// --- services/operatorState.js: состояния оператора и их интервалы ---
//
// Пять состояний вместо прежнего переключателя «на линии» (да/нет). Лиды
// выдаются только в состоянии on_line, остальные четыре для очереди равнозначны
// — оператор занят.
//
// Время хранится ИНТЕРВАЛАМИ на сервере, а не счётчиком в браузере: обновление
// страницы обнуляло бы счётчики и цифры были бы бесполезны. Открытый интервал
// (ended_at IS NULL) ровно один на сотрудника — это гарантия БД (частичный
// уникальный индекс в schema.sql), а не только кода: две вкладки одного
// оператора иначе удвоили бы суммы.
//
// on_line/on_line_since остаются как ПРОИЗВОДНЫЕ поля (их читает раздача) и
// пишутся только отсюда. Второго источника правды нет.
//
// ЧТО ЭТИ ЦИФРЫ ЗНАЧАТ. Это показатель дисциплины, а не источник для расчёта
// зарплаты (явное требование куратора, dialog.md C3). Heartbeat с фронта не
// делаем — он превращает таймеры в систему контроля присутствия, а это отдельный
// разговор с владельцем. Забытая вкладка даёт «на линии» до потолка в
// MAX_OPEN_INTERVAL_HOURS, и по таким числам нельзя никому ничего начислять.

const { withTransaction } = require('./dbTx');
const { MAX_OPEN_INTERVAL_HOURS, startOfDay } = require('./appTime');

// off — не в системе (вышел или ещё не входил); в панели состояний не
// показывается и вручную не выбирается, его ставит выход из системы.
// ДВА ПОСЛЕДНИХ — СИСТЕМНЫЕ (часть 7А, паспорт Р1). Их ставит система по
// событиям станции, оператор не выбирает ни одного:
//   talk   — идёт разговор;
//   wrapup — пост-обработка, оператор дописывает результат и лидов не берёт.
// В SELECTABLE_STATES их нет и не будет — разбор строкой ниже.
const WORK_STATES = ['off', 'on_line', 'break', 'lunch', 'training', 'review', 'talk', 'wrapup'];

// Порядок и подписи для панели состояний. Разговора и пост-обработки здесь нет
// намеренно: оба системные. Возможность выбрать пост-обработку руками была бы
// способом бесконечно не брать лидов, а «разговор», поставленный вручную, врал
// бы руководителю на вкладке «Активные» — там это единственное состояние, в
// котором идёт работа с клиентом.
const SELECTABLE_STATES = [
    { key: 'on_line', label: 'На линии' },
    { key: 'break', label: 'Перерыв' },
    { key: 'lunch', label: 'Обед' },
    { key: 'training', label: 'Обучение' },
    { key: 'review', label: 'Разбор ошибок' }
];

function isValidState(state) {
    return WORK_STATES.includes(state);
}

// ДВЕ ПРОВЕРКИ, А НЕ ОДНА (К195). isValidState отвечает на вопрос «бывает ли
// такое состояние вообще» — им пользуется система, когда ставит состояние сама.
// Человеку этого вопроса мало: с приходом части 7А в перечень встали talk и
// wrapup, и запрос оператора, который прежде отбивался четырёхсотым, стал
// проходить. Кнопок для них в панели нет, но панель — не преграда: адрес
// открыт, а пост-обработка, поставленная руками, это способ бесконечно не
// брать лидов, «разговор» же — способ соврать руководителю на вкладке
// «Активные», где это единственный признак работы с клиентом.
//
// ПОЧЕМУ НЕ ПРОСТО «СПИСОК КНОПОК». Первая моя редакция сверяла запрос с
// SELECTABLE_STATES — и сломала бы ВЫХОД ИЗ СИСТЕМЫ: он идёт тем же адресом и
// шлёт `off` (Operator/js/modules/operatorApp.js:82), а кнопки `off` в панели
// нет и быть не должно. Отказ на выходе оставил бы интервал «На линии»
// открытым на всю ночь — ровно то, ради чего решение C3 и писалось.
//
// Правило поэтому сформулировано от системных состояний, а не от кнопок:
// человек вправе запросить любое настоящее состояние, КРОМЕ тех, которые
// ставит станция.
const SYSTEM_STATES = ['talk', 'wrapup'];

function isRequestableState(state) {
    return isValidState(state) && !SYSTEM_STATES.includes(state);
}

// Оператор закрыл вкладку, не выйдя из системы, — интервал остаётся открытым и
// «На линии» накрутит всю ночь. Потолок непрерывного интервала (решение
// куратора, dialog.md C3): интервал старше порога закрывается принудительно.
//
// Отступление, о котором говорю прямо: вместе с интервалом сотрудник переводится
// в off. Куратор написал только «интервал закрывается», но если оставить
// work_state = 'on_line', раздача продолжит выдавать лиды человеку, которого нет
// у стола уже двенадцать часов, — то есть ровно то, ради чего и заведено правило
// освобождения удержанного лида. Если решение не нравится — снимается удалением
// одного UPDATE ниже.
async function closeStaleIntervals(db, employeeId) {
    const params = [MAX_OPEN_INTERVAL_HOURS];
    let where = 'ended_at IS NULL AND started_at <= NOW() - make_interval(hours => $1::int)';
    if (employeeId !== undefined && employeeId !== null) {
        params.push(employeeId);
        where += ` AND employee_id = $${params.length}`;
    }
    const closed = await db.query(
        `UPDATE employee_state_intervals
         SET ended_at = started_at + make_interval(hours => $1::int)
         WHERE ${where}
         RETURNING employee_id, state`,
        params
    );
    const stuckOnline = closed.rows.filter((r) => r.state !== 'off').map((r) => r.employee_id);
    if (stuckOnline.length > 0) {
        await db.query(
            `UPDATE employees SET work_state = 'off', on_line = false, on_line_since = NULL
             WHERE id = ANY($1::int[])`,
            [stuckOnline]
        );
        await db.query(
            `INSERT INTO employee_state_intervals (employee_id, state, started_at)
             SELECT id, 'off', NOW() FROM employees WHERE id = ANY($1::int[])
             ON CONFLICT DO NOTHING`,
            [stuckOnline]
        );
    }
    return closed.rows.length;
}

// Смена состояния: в ОДНОЙ транзакции закрыть открытый интервал, открыть новый,
// обновить work_state и синхронизировать производные on_line/on_line_since.
// Половинчатое состояние (интервал закрыт, новый не открыт) означало бы дыру в
// таймерах, которую потом никак не восстановить.
async function setWorkState(db, employeeId, state) {
    return withTransaction(db, async (client) => {
        const employee = await client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);
        if (employee.rows.length === 0) return null;

        await client.query(
            'UPDATE employee_state_intervals SET ended_at = NOW() WHERE employee_id = $1 AND ended_at IS NULL',
            [employeeId]
        );
        await client.query(
            'INSERT INTO employee_state_intervals (employee_id, state, started_at) VALUES ($1, $2, NOW())',
            [employeeId, state]
        );

        const online = state === 'on_line';
        await client.query(
            online
                ? `UPDATE employees SET work_state = $2, on_line = true, on_line_since = NOW() WHERE id = $1`
                : `UPDATE employees SET work_state = $2, on_line = false, on_line_since = NULL WHERE id = $1`,
            [employeeId, state]
        );
        return { employeeId: Number(employeeId), state };
    });
}

// Текущее состояние + суммы за сегодня.
//
// Суммы считаются пересечением интервалов с КАЛЕНДАРНЫМИ сутками в поясе
// приложения (смен как сущности в системе нет — считать «за смену» не из чего).
// Открытый интервал учитывается до NOW(); интервал, начавшийся вчера, режется по
// границе суток, а не отбрасывается целиком (dialog.md B3).
//
// now отдаётся клиенту вместе с startedAt намеренно: счётчик тикает на клиенте,
// и если часы браузера уводит, он соврёт. Клиент считает от разницы серверных
// значений, а не от своего Date.now() (dialog.md G5).
async function getWorkState(db, employeeId) {
    await closeStaleIntervals(db, employeeId);

    const employee = await db.query(
        'SELECT id, work_state, on_line, released_lead_notice FROM employees WHERE id = $1',
        [employeeId]
    );
    if (employee.rows.length === 0) return null;

    const open = await db.query(
        'SELECT state, started_at FROM employee_state_intervals WHERE employee_id = $1 AND ended_at IS NULL',
        [employeeId]
    );

    const dayStart = startOfDay(new Date());
    const totals = await db.query(
        `SELECT state,
                COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (
                    COALESCE(ended_at::timestamptz, NOW()) - GREATEST(started_at::timestamptz, $2::timestamptz)
                )), 0)), 0)::bigint AS seconds
         FROM employee_state_intervals
         WHERE employee_id = $1
           AND COALESCE(ended_at::timestamptz, NOW()) > $2::timestamptz
         GROUP BY state`,
        [employeeId, dayStart]
    );

    const totalsByState = {};
    WORK_STATES.forEach((s) => { totalsByState[s] = 0; });
    totals.rows.forEach((r) => { totalsByState[r.state] = Number(r.seconds); });

    const nowRow = await db.query('SELECT NOW() AS now');

    return {
        employeeId: Number(employeeId),
        state: employee.rows[0].work_state,
        onLine: employee.rows[0].on_line,
        startedAt: open.rows[0] ? open.rows[0].started_at : null,
        now: nowRow.rows[0].now,
        totals: totalsByState,
        releasedLeadNotice: employee.rows[0].released_lead_notice
    };
}

// Отметку «лид, который был за вами, вернулся в общую очередь» снимаем сразу
// после того, как отдали её оператору: она разовая.
async function clearReleasedLeadNotice(db, employeeId) {
    await db.query('UPDATE employees SET released_lead_notice = false WHERE id = $1', [employeeId]);
}

module.exports = {
    WORK_STATES,
    SELECTABLE_STATES,
    isValidState,
    SYSTEM_STATES,
    isRequestableState,
    setWorkState,
    getWorkState,
    closeStaleIntervals,
    clearReleasedLeadNotice
};
