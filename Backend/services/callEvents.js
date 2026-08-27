// --- services/callEvents.js: чтение событий руководителя ---------------------
//
// Четыре числа переехали из кода в настройку (решение владельца 97, наряд
// куратора, часть 9). До этого захода интервал перезвона, предел попыток и
// рабочее окно стояли константами в `services/appTime.js`; теперь их задаёт
// руководитель на вкладке «Звонки → События», а хранятся они в `call_events` и
// в перечнях этих событий.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ЗАПРОС В МЕСТЕ ВЫЗОВА. Событий четыре, читать их
// будут четыре разных места, и каждое обязано одинаково отвечать на вопрос «а
// настроено ли». Правило «настроено» непростое — событие может существовать,
// быть выключенным, быть включённым без окна и быть включённым без единой
// строки, — и написанное дважды оно разойдётся на первой же правке.
//
// ЧИТАЕТ, НО НЕ РЕШАЕТ. Что делать с прочитанным, решает вызывающий:
// `leadCallRules` — что записать лиду, сторож при старте — о чём кричать в лог.
// Здесь только «вот настройка» или «настройки нет».

const AUTO_RECALL = 'auto_recall';

/**
 * Годно ли событие автоперезвона к работе, и если да — с каким окном.
 *
 * ОДНО МЕСТО НА ВСЕХ ЧИТАТЕЛЕЙ. Условий четыре — события нет, выключено, окно не
 * заполнено, окно нулевой длины, — и написанные порознь у каждого читателя они
 * разойдутся: кто-то забудет про нулевое окно, и экран оператора обещал бы
 * перезвон, которого сервер не назначит. Возвращает окно или null.
 */
function usableWindow(row) {
    if (!row) return null;
    if (!row.enabled) return null;
    // Окно — пара, и половины окна не бывает: это стережёт и база
    // (`call_events_window_pair_check`). Здесь проверяется другое: «обе пусты» —
    // законное состояние и означает «окно не настроено».
    if (!row.window_from || !row.window_to) return null;
    // Окно нулевой длины — это «никогда», а не «круглые сутки» (ответ куратора
    // 32). Такую пару отбивает сервер при сохранении; здесь она читается как
    // ненастроенная.
    if (row.window_from === row.window_to) return null;
    return { from: row.window_from, to: row.window_to };
}

/**
 * Настройка автоперезвона для КОНКРЕТНОГО статуса — того, который сейчас
 * ставят. Так это работает и в коде до захода 2: признаки берутся у статуса,
 * который проставляют, а не у того, на котором лид стоял (ответ куратора 14).
 *
 * Возвращает null во всех случаях, когда перезванивать не по чему, и это ОДИН
 * ответ на все причины намеренно: у вызывающего от них ничего не зависит — лид
 * просто уходит из очереди без назначенного перезвона, ровно как сегодня уходит
 * статус без флага `auto_recall`. Кому нужны причины по отдельности — сторожу
 * при старте, и у него своя функция ниже.
 *
 * ОДНИМ ЗАПРОСОМ, А НЕ ДВУМЯ. Строка события одна на вид, строка правила одна на
 * статус; внешнее соединение даёт ровно одну строку и в том случае, когда
 * правила нет. Запрос идёт внутри той же транзакции, что и сохранение карточки:
 * настройка, поменявшаяся между чтением и записью, не должна расщепить решение.
 */
async function fetchAutoRecall(db, statusId) {
    const result = await db.query(
        `SELECT e.enabled, e.window_from, e.window_to,
                r.id AS rule_id, r.interval_minutes, r.max_attempts, r.after_limit_status_id
           FROM call_events e
           LEFT JOIN call_recall_rules r ON r.funnel_status_id = $1
          WHERE e.kind = $2`,
        [statusId, AUTO_RECALL]
    );
    const row = result.rows[0];
    const window = usableWindow(row);
    if (!window) return null;
    // Правила для этого статуса нет — автоперезвона по нему нет. Подставлять
    // чужое правило или общее умолчание нельзя: это решение за владельца, куда
    // уходит лид (ответ куратора 16).
    if (row.rule_id === null) return null;

    return {
        intervalMinutes: row.interval_minutes,
        maxAttempts: row.max_attempts,
        afterStatusId: row.after_limit_status_id,
        window
    };
}

/**
 * Все строки автоперезвона разом — для справочника статусов, который читает
 * экран оператора. Пустой массив, когда событие к работе не годно: тогда
 * перезвона нет ни по одному статусу, и экран не должен обещать его ни у одного.
 *
 * ИМЯ ЦЕЛЕВОГО СТАТУСА ПРИХОДИТ СЮДА ЖЕ. Оператор читает «после N-й лид уйдёт в
 * статус …», и статус этот теперь свой у каждой строки. Собирать имя на клиенте
 * из второго списка значило бы держать ту же связь в двух местах.
 */
async function fetchAutoRecallRules(db) {
    const event = await db.query(
        'SELECT enabled, window_from, window_to FROM call_events WHERE kind = $1', [AUTO_RECALL]);
    if (!usableWindow(event.rows[0])) return [];

    const result = await db.query(
        `SELECT r.funnel_status_id, r.interval_minutes, r.max_attempts,
                r.after_limit_status_id, a.status_name AS after_status_name
           FROM call_recall_rules r
           JOIN lead_funnel_statuses a ON a.id = r.after_limit_status_id
          ORDER BY r.funnel_status_id`
    );
    return result.rows.map((r) => ({
        funnelStatusId: r.funnel_status_id,
        intervalMinutes: r.interval_minutes,
        maxAttempts: r.max_attempts,
        afterStatusId: r.after_limit_status_id,
        afterStatusName: r.after_status_name
    }));
}

/**
 * Состояние события целиком — для сторожа при старте. Здесь причины НУЖНЫ
 * порознь: «события нет», «выключено», «без окна» и «без строк» чинятся в
 * разных местах, и одна общая строка в логе отправила бы искать не туда.
 *
 * Возвращает null, только если строки события нет вовсе — то есть засев не
 * отработал.
 */
async function fetchAutoRecallState(db) {
    const result = await db.query(
        `SELECT e.enabled,
                (e.window_from IS NOT NULL AND e.window_to IS NOT NULL) AS has_window,
                (SELECT count(*) FROM call_recall_rules)::int AS rules
           FROM call_events e
          WHERE e.kind = $1`,
        [AUTO_RECALL]
    );
    return result.rows[0] || null;
}

module.exports = {
    AUTO_RECALL,
    fetchAutoRecall,
    fetchAutoRecallRules,
    fetchAutoRecallState
};
