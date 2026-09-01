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
const appSettings = require('./appSettings');
const auditContext = require('./auditContext');

// ПОРЯДОК ОБЯЗАТЕЛЕН, И С ЧАСТИ 9 ЭТО НЕ ПЕДАНТИЗМ. Пока справочник был
// закреплён схемой, на нулевом этапе стояла ровно одна строка, и `LIMIT 1` без
// порядка возвращал её всегда. Заход 4 сделал справочник правимым: второй
// статус на нулевом этапе теперь завести можно, и без явного порядка одна и та
// же выборка отдавала бы разное между запросами — то есть новые лиды заводились
// бы то с одним статусом, то с другим.
async function findNewFunnelStatusId(db) {
    const result = await db.query(
        'SELECT id FROM lead_funnel_statuses WHERE stage_number = 0 ORDER BY sort_order, id LIMIT 1');
    return result.rows[0] ? result.rows[0].id : null;
}

// ЛИД С СИСТЕМНЫМ СТАТУСОМ ИЗ РАЗДАЧИ ВЫПАДАЕТ (К241, решение владельца 106).
// Дословно: «лид перестаёт быть „Новым", из условия очереди выпадает и тому же
// оператору обратно не приходит»; «дальше лид не раздаётся, пока ему не
// поставят настоящий статус». Ровно это же обещает описание системного этапа в
// схеме — то есть база говорила одно, а очередь делала другое.
//
// ЧТО БЫЛО БЕЗ ЭТОГО. Пост-обработка закрыла карточку по времени: статус стал
// «Нет результата», оператор отцеплен, `next_call_at` НЕ ТРОНУТ — снять чужое
// обещание клиенту молча нельзя. А лид пришёл к оператору именно потому, что
// время перезвона наступило, и оно по-прежнему в прошлом. Следующий же запрос
// «дай лида» возвращал того же лида тому же человеку. Случай не выдуманный: это
// обычный ход событий, а не край.
//
// ПРАВКА ЗДЕСЬ, А НЕ В ЗАКРЫТИИ КАРТОЧКИ. Обнулить `next_call_at` при закрытии
// значило бы стереть договорённость с клиентом ради обхода очереди. Условие
// очереди — одно на все места, и добавлять надо в него: разойдись очередь с
// проверкой занятости оператора, и человек стал бы «занят» лидом, которого ему
// никогда не выдадут.
//
// ПРОВЕРКА `is_system`, А НЕ `awaits_manager`. Системных статусов два, и второй
// — «Не ответил после N перезвонов» — раздаваться не должен тем более: по нему
// работа кончена. Для него это не смена поведения: `next_call_at` там и так
// обнуляется, из очереди он выпадал и раньше.
function notSystemStatus(alias) {
    return `NOT EXISTS (SELECT 1 FROM lead_funnel_statuses sys
                         WHERE sys.id = ${alias}.funnel_status_id AND sys.is_system)`;
}

// Условие «этот лид сейчас ждёт работы»: он новый или у него наступило время
// перезвона — И статус у него не системный. Один и тот же текст нужен в трёх
// местах, поэтому вынесен — расхождение между ними означало бы лида, который
// виден очереди, но не виден проверке занятости оператора (или наоборот).
function queueCondition(alias, statusParam) {
    // Внешние скобки обязательны: условие подставляется в том числе внутрь OR
    // (проверка занятости оператора), а AND связывает сильнее — без них «лид не
    // слит» относилось бы только ко второй половине выражения.
    return `((${alias}.funnel_status_id = ${statusParam}
              OR (${alias}.next_call_at IS NOT NULL AND ${alias}.next_call_at <= NOW()))
             AND ${alias}.merged_into_id IS NULL
             AND ${alias}.archived_at IS NULL
             AND ${notSystemStatus(alias)})`;
}

// ПОРЯДОК ОЧЕРЕДИ — ТРИ УРОВНЯ, и текст у них один на оба места, по той же
// причине, что и у queueCondition: разошедшись, они дали бы лида, который в
// общей раздаче идёт первым, а лично оператору выдаётся третьим.
//
// Пропущенные → наступившие перезвоны → новые (бриф части 7, решение владельца
// 28). Внутри пропущенных — по времени звонка: кто раньше звонил, того раньше
// отдаём. Именно ради этой сортировки признак «пропущенный» хранится временем,
// а не булевым.
//
// `(alias.missed_at IS NULL)` даёт 0 у пропущенных и 1 у остальных — потому они
// и выходят вперёд. Тот же приём, что уже стоял на next_call_at.
function queueOrder(alias) {
    return `(${alias}.missed_at IS NULL), ${alias}.missed_at ASC,
             (${alias}.next_call_at IS NULL), ${alias}.next_call_at ASC,
             ${alias}.created_at ASC, ${alias}.id ASC`;
}

// Дольше всех свободен — первый в очереди (ORDER BY on_line_since ASC).
// lead — строка с полями id и line_type: кандидаты у каждого лида свои,
// одного общего "следующего свободного оператора" не существует.
async function findAvailableEmployee(db, lead, newStatusId) {
    if (!lead || !lead.line_type) return null;

    // ПРОПУЩЕННЫЙ ОБХОДИТ ПРАВИЛО «НЕ ДАВАТЬ НОВОГО, ПОКА ЕСТЬ ЖДУЩИЙ», И
    // ТОЛЬКО ЕГО (ответ куратора И167). Без обхода «вне очереди» не сработает
    // никогда: у оператора почти всегда числится ждущий лид, и пропущенный
    // встал бы в общий хвост — то есть решение владельца 27 осталось бы словами.
    //
    // Открытую карточку он НЕ обходит. Выдать лида поверх начатого разговора
    // значит потерять работу, которую человек уже делает, а правило «не терять
    // начатую работу» сильнее правила «вне очереди».
    // ОБХОД НЕ ОТМЕНЯЕТ ПРАВИЛО, А СУЖАЕТ ЕГО. Пропущенный проходит мимо
    // обычного ждущего лида — но не мимо ДРУГОГО пропущенного, который у этого
    // оператора уже ждёт работы. Иначе один проход раздачи отдал бы одному
    // человеку все пропущенные звонки разом: он всё равно говорит по одному, а
    // остальные оказались бы заперты за ним вместо того, чтобы достаться
    // свободным. Это поймал набор — я написал обход шире, чем следовало.
    const isMissed = Boolean(lead.missed_at);
    const waiting = queueCondition('w', '$3');
    const busy = isMissed
        ? `(w.opened_at IS NOT NULL OR (w.missed_at IS NOT NULL AND ${waiting}))`
        : `(w.opened_at IS NOT NULL OR ${waiting})`;
    const params = [lead.line_type, lead.id, newStatusId];

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
                  AND ${busy}
           )
         ORDER BY e.on_line_since ASC
         LIMIT 1`,
        params
    );
    return result.rows[0] ? result.rows[0].id : null;
}

// Лид держится за оператором, пока тот на перерыве (решение владельца), значит
// держится и после того, как оператор ушёл домой: employee_id не очищается
// ничем, и лид, открытый в 19:55, до утра не достанется никому. Через
// HELD_LEAD_RELEASE_HOURS вне линии он возвращается в общую очередь.
//
// ЧАСЫ БЕРУТСЯ ИЗ НАСТРОЙКИ, а константа осталась умолчанием (ответы куратора
// 12 и 13). Настройка, которую видно на экране и которая ничего не меняет, хуже
// её отсутствия — по ней принимают решения. Константу при этом не убираем:
// пустая строка в базе не должна ронять раздачу.
//
// Отцепляются только лиды, ЖДУЩИЕ РАБОТЫ. Лид этапа 2+ остаётся закреплён за
// оператором и в очередь не возвращается — это граница задачи (dialog.md 0.1).
//
// С К241 сюда попал и лид с системным статусом: он тоже не ждёт работы, и с
// ушедшего домой оператора теперь не откалывается. Названо вслух, потому что
// выглядит как потеря: на деле закрытие по времени отцепляет оператора само
// (`services/callWrapup.js`), и лида с системным статусом при живом операторе
// не бывает. Останься такой — он всё равно никому не выдаётся, и «отцепить»
// значило бы только переложить его из одного тупика в другой.
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

    const releaseHours = await appSettings.getInt(db, 'held_lead_release_hours', HELD_LEAD_RELEASE_HOURS);

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
        [newStatusId, releaseHours]
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
            `SELECT id, line_type, missed_at FROM leads l
             WHERE employee_id IS NULL
               AND line_type IS NOT NULL
               AND opened_at IS NULL
               AND ${queueCondition('l', '$1')}
             ORDER BY ${queueOrder('l')}
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
             ORDER BY ${queueOrder('l')}
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
    queueCondition,
    // Половина условия наружу — ради ответа «вернётся позже» (К241). Кто
    // спрашивает «а когда лид вернётся», обязан спрашивать про системный статус
    // тем же текстом: иначе окно скажет «позже» про лида, которого не выдадут
    // ни позже, ни когда-либо — до вмешательства руководителя.
    notSystemStatus,
    // Порядок наружу по той же причине: части, которые захотят показать очередь
    // человеку, обязаны показывать ТОТ ЖЕ порядок, в котором она раздаётся.
    queueOrder
};
