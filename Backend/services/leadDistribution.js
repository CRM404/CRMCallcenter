// --- services/leadDistribution.js: раздача лидов операторам "на линии" ---
// Не роут — переиспользуется из routes/leadsAdmin.js (POST /bulk-import),
// routes/employees.js (смена состояния) и routes/leads.js (очередь оператора).
// Принимает db (пул или client уже открытой транзакции) первым параметром.
//
// Правило подбора: оператор активен, "на линии", ТОЙ ЖЕ линии, что у лида, и —
// если у лида заполнен пул раздачи — входит в пул. Пустой пул означает "всем
// подходящим по линии", а не "никому".
//
// Что изменила задача «рабочий режим оператора» (15.08.2026):
//
// 1. Раньше подбирались только лиды со статусом «Новый». Отцепленный лид со
//    статусом «Недоступен» под это условие не попадал и завис бы навсегда —
//    молча, без ошибки. Условие расширено на «наступило время перезвона», и
//    наступившие перезвоны идут ВПЕРЁД новых лидов: назначенное время — это
//    обещание клиенту, новый лид подождёт минуту.
// 2. Оператору не выдаётся новый лид, пока у него есть лид, ЖДУЩИЙ РАБОТЫ
//    (dialog.md 0.2). Формулировка шире, чем «открытая карточка»: закреплённый
//    за ним лид без opened_at, подходящий под условие очереди, тоже блокирует.
//    Иначе раздача при загрузке партии снова навесила бы на одного оператора
//    сотню лидов — открытым был бы один, а остальные не достались бы тем, кто
//    вышел на линию позже.
// 3. Выборка идёт с FOR UPDATE SKIP LOCKED внутри транзакции. Раньше гонку
//    прикрывал список (оператор выбирал лида сам), теперь двое операторов,
//    одновременно попросивших следующего, получили бы одну карточку и позвонили
//    бы клиенту дважды подряд (dialog.md D1).
// 4. opened_at ставит ТОЛЬКО выдача карточки в браузер, раздача её не трогает.
//
// Что изменила часть 4 «единый формат телефона»: у лида появился указатель
// слияния, и СЛИТЫЙ ЛИД В РАЗДАЧЕ НЕ УЧАСТВУЕТ НИГДЕ. Он влит в старшего, номер
// у него тот же самый — выдать его оператору значило бы позвонить человеку
// второй раз по той же карточке. Условие добавлено в queueCondition (общее для
// трёх запросов), в разбор осиротевших карточек и в выдачу уже открытой.
//
// Что изменила часть 5 «архив»: АРХИВНЫЙ ЛИД ИСЧЕЗАЕТ РОВНО ТАМ ЖЕ, ГДЕ СЛИТЫЙ.
// Это не догадка про симметрию, а требование: места те же самые, все три, и
// пройти надо по всем. Пропустить одно значит отдать архивного лида оператору —
// и выглядеть это будет случайностью, а не забытым условием. Условие второе, но
// стоит рядом с первым намеренно: кто будет добавлять третье (например,
// «в чёрном списке»), увидит оба сразу и не заведёт его в одном месте из трёх.

const { withTransaction } = require('./dbTx');
const { HELD_LEAD_RELEASE_HOURS } = require('./appTime');
const auditContext = require('./auditContext');

async function findNewFunnelStatusId(db) {
    const result = await db.query("SELECT id FROM lead_funnel_statuses WHERE stage_number = 0 LIMIT 1");
    return result.rows[0] ? result.rows[0].id : null;
}

// Условие «этот лид сейчас ждёт работы»: либо он новый, либо у него наступило
// время перезвона. Один и тот же текст нужен в трёх местах, поэтому вынесен —
// расхождение между ними означало бы лида, который виден очереди, но не виден
// проверке занятости оператора (или наоборот).
function queueCondition(alias, statusParam) {
    // Внешние скобки обязательны: условие подставляется в том числе внутрь OR
    // (проверка занятости оператора), а AND связывает сильнее — без них «лид не
    // слит» относилось бы только ко второй половине выражения.
    return `((${alias}.funnel_status_id = ${statusParam}
              OR (${alias}.next_call_at IS NOT NULL AND ${alias}.next_call_at <= NOW()))
             AND ${alias}.merged_into_id IS NULL
             AND ${alias}.archived_at IS NULL)`;
}

// Дольше всех свободен — первый в очереди (ORDER BY on_line_since ASC).
// lead — строка с полями id и line_type: кандидаты у каждого лида свои,
// одного общего "следующего свободного оператора" не существует.
async function findAvailableEmployee(db, lead, newStatusId) {
    if (!lead || !lead.line_type) return null;
    const result = await db.query(
        `SELECT e.id
         FROM employees e
         WHERE e.status = 'active'
           AND e.on_line = true
           AND e.line_type = $1
           AND (
                NOT EXISTS (SELECT 1 FROM lead_distribution_pool p WHERE p.lead_id = $2)
                OR EXISTS (SELECT 1 FROM lead_distribution_pool p WHERE p.lead_id = $2 AND p.employee_id = e.id)
           )
           AND NOT EXISTS (
                SELECT 1 FROM leads w
                WHERE w.employee_id = e.id
                  AND (w.opened_at IS NOT NULL OR ${queueCondition('w', '$3')})
           )
         ORDER BY e.on_line_since ASC
         LIMIT 1`,
        [lead.line_type, lead.id, newStatusId]
    );
    return result.rows[0] ? result.rows[0].id : null;
}

// Лид держится за оператором, пока тот на перерыве (решение владельца), значит
// держится и после того, как оператор ушёл домой: employee_id не очищается
// ничем, и лид, открытый в 19:55, до утра не достанется никому. Через
// HELD_LEAD_RELEASE_HOURS вне линии он возвращается в общую очередь.
//
// Отцепляются только лиды, ЖДУЩИЕ РАБОТЫ. Лид этапа 2+ остаётся закреплён за
// оператором и в очередь не возвращается — это граница задачи (dialog.md 0.1).
async function releaseHeldLeads(db, newStatusId) {
    if (newStatusId === null) return { released: 0 };

    // Осиротевшие открытые карточки (правка куратора при приёмке, 15.08.2026).
    // leads.employee_id объявлен ON DELETE SET NULL: удалили сотрудника — у его
    // открытой карточки оператор обнуляется, а opened_at остаётся. Такой лид не
    // виден никому: очередь берёт только opened_at IS NULL, а правило ниже
    // джойнится с employees, которых уже нет. До этой задачи лид просто вернулся
    // бы в общую раздачу, теперь пропадал бы навсегда — тот же класс потери, что
    // и лид с пустым статусом. Снимаем метку и возвращаем его в очередь.
    await db.query('UPDATE leads SET opened_at = NULL, updated_at = NOW() WHERE employee_id IS NULL AND opened_at IS NOT NULL AND merged_into_id IS NULL AND archived_at IS NULL');

    const result = await db.query(
        `UPDATE leads l
         SET employee_id = NULL, opened_at = NULL, updated_at = NOW()
         FROM employees e
         WHERE l.employee_id = e.id
           AND e.on_line = false
           AND ${queueCondition('l', '$1')}
           AND COALESCE(
                 (SELECT i.started_at FROM employee_state_intervals i
                  WHERE i.employee_id = e.id AND i.ended_at IS NULL),
                 l.updated_at
               ) <= NOW() - make_interval(hours => $2::int)
         RETURNING l.id, e.id AS employee_id`,
        [newStatusId, HELD_LEAD_RELEASE_HOURS]
    );
    if (result.rows.length > 0) {
        const employeeIds = Array.from(new Set(result.rows.map((r) => r.employee_id)));
        await db.query(
            'UPDATE employees SET released_lead_notice = true WHERE id = ANY($1::int[])',
            [employeeIds]
        );
    }
    return { released: result.rows.length };
}

// Разбирает ВСЕ зависшие лиды по свободным операторам, по одному, в порядке
// очереди. После каждого назначения on_line_since оператора сбрасывается на
// NOW() — простая ротация: если он единственный подходящий, следующий лид снова
// достанется ему же, а не зависнет ради "справедливости" между операторами,
// которых сейчас нет.
//
// continue, а не break: у лидов разные линии и разные пулы, поэтому "для этого
// лида кандидата нет" не означает "для остальных тоже".
//
// Запускается при загрузке партии и при выходе оператора на линию. Опрос
// очереди с фронта полный проход НЕ запускает (dialog.md D3) — он разбирает
// очередь только под запросившего оператора, см. assignNextLeadForEmployee.
async function distributePendingLeads(db) {
    // АВТОР У РАЗДАЧИ СЛУЖЕБНЫЙ, и это честнее человека. Запускает её выход
    // оператора на линию или загрузка партии, но переставляет лидов система по
    // своим правилам: записать сюда фамилию нажавшего значит приписать ему
    // решение, которого он не принимал (часть 3, план 10.3).
    return auditContext.runAsService('Раздача', () => withTransaction(db, async (client) => {
        const newStatusId = await findNewFunnelStatusId(client);
        if (newStatusId === null) return { distributed: 0 };

        await releaseHeldLeads(client, newStatusId);

        const pending = await client.query(
            `SELECT id, line_type FROM leads l
             WHERE employee_id IS NULL
               AND line_type IS NOT NULL
               AND opened_at IS NULL
               AND ${queueCondition('l', '$1')}
             ORDER BY (next_call_at IS NULL), next_call_at ASC, created_at ASC, id ASC
             FOR UPDATE SKIP LOCKED`,
            [newStatusId]
        );

        let distributed = 0;
        for (const lead of pending.rows) {
            const employeeId = await findAvailableEmployee(client, lead, newStatusId);
            if (employeeId === null) continue;
            await client.query('UPDATE leads SET employee_id = $1, updated_at = NOW() WHERE id = $2', [employeeId, lead.id]);
            await client.query('UPDATE employees SET on_line_since = NOW() WHERE id = $1', [employeeId]);
            distributed++;
        }
        return { distributed };
    }));
}

// Очередь одного оператора: вернуть ему карточку, с которой он должен работать
// прямо сейчас. Это и есть «следующий лид» страницы оператора.
//
// Порядок проверок важен:
//   1. Не на линии — очередь остановлена, ничего не выдаём (но лид, который уже
//      открыт, остаётся за ним и откроется, когда он вернётся).
//   2. Карточка уже открыта (opened_at IS NOT NULL) — отдаём ЕЁ же, не трогая
//      opened_at. Это обычное обновление страницы посреди разговора; выдать в
//      этот момент другого лида означало бы потерять начатую работу.
//   3. Иначе — берём первого подходящего: своего закреплённого или свободного,
//      с блокировкой строки.
async function assignNextLeadForEmployee(db, employeeId) {
    return withTransaction(db, async (client) => {
        const newStatusId = await findNewFunnelStatusId(client);

        const empResult = await client.query(
            'SELECT id, status, on_line, line_type FROM employees WHERE id = $1',
            [employeeId]
        );
        const employee = empResult.rows[0];
        if (!employee) return { leadId: null, reason: 'no-employee' };

        const opened = await client.query(
            `SELECT id FROM leads WHERE employee_id = $1 AND opened_at IS NOT NULL
               AND merged_into_id IS NULL AND archived_at IS NULL
             ORDER BY opened_at ASC LIMIT 1`,
            [employeeId]
        );
        if (opened.rows.length > 0) {
            return { leadId: opened.rows[0].id, reason: 'already-open' };
        }

        if (!employee.on_line || employee.status !== 'active') {
            return { leadId: null, reason: 'off-line' };
        }
        if (newStatusId === null || !employee.line_type) {
            return { leadId: null, reason: 'empty' };
        }

        await releaseHeldLeads(client, newStatusId);

        const candidate = await client.query(
            `SELECT l.id FROM leads l
             WHERE l.line_type = $1
               AND l.opened_at IS NULL
               AND (l.employee_id = $2 OR l.employee_id IS NULL)
               AND ${queueCondition('l', '$3')}
               AND (
                    NOT EXISTS (SELECT 1 FROM lead_distribution_pool p WHERE p.lead_id = l.id)
                    OR EXISTS (SELECT 1 FROM lead_distribution_pool p WHERE p.lead_id = l.id AND p.employee_id = $2)
               )
             ORDER BY (l.next_call_at IS NULL), l.next_call_at ASC, l.created_at ASC, l.id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`,
            [employee.line_type, employeeId, newStatusId]
        );
        if (candidate.rows.length === 0) {
            return { leadId: null, reason: 'empty' };
        }

        const leadId = candidate.rows[0].id;
        await client.query(
            'UPDATE leads SET employee_id = $1, opened_at = NOW(), updated_at = NOW() WHERE id = $2',
            [employeeId, leadId]
        );
        await client.query('UPDATE employees SET on_line_since = NOW() WHERE id = $1', [employeeId]);
        return { leadId, reason: 'assigned' };
    });
}

module.exports = {
    distributePendingLeads,
    findAvailableEmployee,
    findNewFunnelStatusId,
    assignNextLeadForEmployee,
    releaseHeldLeads,
    // Наружу — ради части 5. Окно вывода сотрудника из работы обязано сказать,
    // сколько его лидов вернётся в очередь, и считать это ПО ФАКТИЧЕСКОМУ
    // УСЛОВИЮ ОЧЕРЕДИ (ответ куратора И88). Написать там второе такое же
    // условие значило завести две правды: они совпадут в день написания и
    // разойдутся в первый же день правки — а расхождение это будет выглядеть
    // как «окно соврало», и искать его пойдут в окне, а не здесь.
    queueCondition
};
