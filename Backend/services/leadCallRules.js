// --- services/leadCallRules.js: что происходит с лидом при сохранении статуса ---
//
// Правила (бриф п.4). Статус с releases_lead = true:
//   1. employee_id = NULL — оператор отцепляется сразу;
//   2. last_call_at = NOW(), opened_at = NULL;
//   3. auto_recall — call_attempts + 1 и next_call_at = «через час», сдвинутый в
//      рабочее окно;
//   4. requires_call_time («Перезвон») — next_call_at = выбранное оператором
//      время, счётчик НЕ растёт: он про недозвоны, а не про договорённости;
//   5. после MAX_CALL_ATTEMPTS попыток — статус «Не ответил после N перезвонов»,
//      next_call_at = NULL, лид выпадает из автоперезвона.
//
// Оператор не закрепляется ни за автоматическим перезвоном, ни за назначенным
// вручную: лид возвращается в ОБЩУЮ очередь (решение владельца). «Общая» значит
// «не персональная», а не «всем подряд» — линия и пул раздачи сохраняются.
//
// Ручной «Перезвон» вне рабочего окна оператор поставить может: клиент вправе
// попросить любое время. Сдвигается только автоматический.

const { nextAutoRecallAt, MAX_CALL_ATTEMPTS } = require('./appTime');

const NO_ANSWER_STATUS_NAME = 'Не ответил после N перезвонов';

// Ищем один раз и кешируем — как findNewFunnelStatusId для статуса «Новый».
// undefined = ещё не искали, null = в справочнике такой строки нет.
let noAnswerStatusIdCache;

async function findNoAnswerStatusId(db) {
    if (noAnswerStatusIdCache !== undefined) return noAnswerStatusIdCache;
    const result = await db.query(
        'SELECT id FROM lead_funnel_statuses WHERE stage_number = 1 AND status_name = $1 LIMIT 1',
        [NO_ANSWER_STATUS_NAME]
    );
    noAnswerStatusIdCache = result.rows[0] ? result.rows[0].id : null;
    if (noAnswerStatusIdCache === null) {
        console.error(
            `[статусы] В справочнике нет статуса «${NO_ANSWER_STATUS_NAME}». ` +
            'Лиды, исчерпавшие попытки дозвона, останутся на текущем статусе без автоперезвона.'
        );
    }
    return noAnswerStatusIdCache;
}

async function fetchStatusFlags(db, statusId) {
    if (statusId === null || statusId === undefined) return null;
    const result = await db.query(
        'SELECT id, status_name, stage_number, auto_recall, requires_call_time, releases_lead FROM lead_funnel_statuses WHERE id = $1',
        [statusId]
    );
    return result.rows[0] || null;
}

// Возвращает набор колонок, которые надо записать лиду вместе с полями карточки.
// Ничего не пишет сам — вся запись идёт одним UPDATE в вызывающей транзакции,
// иначе половинчатое состояние (оператор снят, время не проставлено) дало бы
// лида, который не в очереди и ни у кого.
//
// next_call_at по умолчанию ОБНУЛЯЕТСЯ. Это не мелочь: лид, вернувшийся по
// перезвону и сохранённый с обычным статусом («Лид ответил»), остался бы с
// наступившим next_call_at, и очередь выдавала бы его тому же оператору по
// кругу — та же петля, из-за которой появилось правило opened_at = NULL.
async function resolveCallStatusEffects(db, { currentAttempts, statusId, statusFlags, nextCallAt, now }) {
    const effects = {
        funnel_status_id: statusId,
        opened_at: null,
        next_call_at: null,
        call_attempts: currentAttempts,
        last_call_at: undefined,   // undefined = не трогаем колонку
        employee_id: undefined
    };

    if (!statusFlags || !statusFlags.releases_lead) {
        return effects;
    }

    effects.employee_id = null;
    effects.last_call_at = now;

    if (statusFlags.auto_recall) {
        effects.call_attempts = currentAttempts + 1;
        if (effects.call_attempts >= MAX_CALL_ATTEMPTS) {
            const noAnswerId = await findNoAnswerStatusId(db);
            if (noAnswerId !== null) {
                effects.funnel_status_id = noAnswerId;
            }
            // Строки нет — оставляем текущий статус и next_call_at = NULL:
            // лид выпадает из автоперезвона. Молча крутить 21-ю попытку хуже
            // (dialog.md A3), поэтому ошибка уже написана в лог.
            effects.next_call_at = null;
        } else {
            effects.next_call_at = nextAutoRecallAt(now);
        }
        return effects;
    }

    if (statusFlags.requires_call_time) {
        effects.next_call_at = nextCallAt;
        return effects;
    }

    // Отпускающий статус без автоперезвона и без времени — лид уходит из очереди
    // совсем (next_call_at = NULL) и ждёт следующего этапа воронки.
    return effects;
}

// Проверка при старте сервера (dialog.md A1). Флаги проставляются миграцией ПО
// НАЗВАНИЮ статуса, и если на бою хоть один пробел отличается, флаг молча не
// встанет: автоперезвон не заработает, а в логе не будет ни одной ошибки.
async function checkStatusFlagsConfigured(db) {
    const result = await db.query(
        `SELECT count(*) FILTER (WHERE auto_recall)::int AS auto_recall,
                count(*) FILTER (WHERE requires_call_time)::int AS requires_call_time,
                count(*) FILTER (WHERE releases_lead)::int AS releases_lead
         FROM lead_funnel_statuses`
    );
    const counts = result.rows[0];
    if (counts.auto_recall === 0) {
        console.error('[статусы] Ни один статус не помечен auto_recall — автоперезвон не работает. Проверьте названия статусов на бою.');
    }
    if (counts.requires_call_time !== 1) {
        console.error(`[статусы] requires_call_time стоит у ${counts.requires_call_time} статусов вместо одного — выбор времени перезвона показывается неверно.`);
    }
    return counts;
}

// Только для тестов: сбросить кеш статуса «Не ответил…» между прогонами.
function resetStatusCache() {
    noAnswerStatusIdCache = undefined;
}

module.exports = {
    NO_ANSWER_STATUS_NAME,
    MAX_CALL_ATTEMPTS,
    findNoAnswerStatusId,
    fetchStatusFlags,
    resolveCallStatusEffects,
    checkStatusFlagsConfigured,
    resetStatusCache
};
