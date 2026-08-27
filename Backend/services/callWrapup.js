// --- services/callWrapup.js: пост-обработка с пределом ------------------------
//
// Событие «Пост-обработка» (паспорт Р12, решения владельца 18–23). Длительность
// задаётся ПАРОЙ «линия + скрипт»: у разных разговоров разная работа после них,
// и одно число на всех было бы либо мало, либо лишним ожиданием.
//
// СОСТОЯНИЕ ОСТАЁТСЯ ПРОИЗВОДНЫМ. Своей строки в `employee_state_intervals`
// пост-обработка не заводит — и это не экономия, а сохранность учёта времени: у
// той таблицы стоит указатель «открытый интервал ровно один», значит завести
// `wrapup` означало бы ЗАКРЫТЬ «на линии» и открыть другой. Все отчёты, где «на
// линии» означает работу, начали бы считать иначе, и задним числом. Часть 9
// добавляет пост-обработке предел, а не переписывает учёт времени.
//
// СКРИПТ — ТОТ, ПО КОТОРОМУ ШЁЛ РАЗГОВОР, то есть открытый по статусу, который у
// лида СЕЙЧАС, до сохранения. Новый статус к прошедшему разговору отношения не
// имеет. Двух открытых скриптов не бывает структурно: у `lead_script_statuses`
// первичный ключ (lead_id, funnel_status_id).
//
// ЛИНИЯ БЕРЁТСЯ У ЛИДА, а не у оператора. Значения те же — раздача сводит лида
// только с оператором своей линии, — но у лида она остаётся и после того, как
// оператор отцепился, а брошенную карточку подбирают именно тогда.

const auditContext = require('./auditContext');

const WRAPUP = 'wrapup';

// Сколько сторож ждёт СВЕРХ предела, прежде чем закрыть карточку сам.
//
// Основной путь — браузер оператора: у него есть и `opened_at`, и тикающий
// счётчик, и следующий лид ему же и приходит. Сторож чинит один случай —
// оператор закрыл вкладку с открытой карточкой; без него `opened_at` остался бы
// навсегда, лид не вернулся бы в очередь и не достался никому (ловушка 6
// наряда). Минута форы — чтобы сторож не отбирал карточку у живого браузера,
// который вот-вот закроет её сам.
const GRACE_SECONDS = 60;

/**
 * Сколько секунд длится пост-обработка по этой карточке — или null, если она не
 * кончается сама.
 *
 * Причин у null две, и обе дают один итог, поэтому не различаются: у статуса
 * лида нет назначенного скрипта, либо пары «эта линия + этот скрипт» нет в
 * перечне события. Паспорт называет это законным состоянием, а не поломкой:
 * оператор остаётся в пост-обработке, пока не вернётся на линию сам.
 */
async function resolveWrapupSeconds(db, { leadId, funnelStatusId, lineType }) {
    if (!leadId || !funnelStatusId || !lineType) return null;
    const result = await db.query(
        `SELECT w.duration_seconds
           FROM call_events e
           JOIN lead_script_statuses lss
             ON lss.lead_id = $1 AND lss.funnel_status_id = $2
           JOIN call_wrapup_rules w
             ON w.script_id = lss.script_id AND w.line_type = $3
          WHERE e.kind = $4 AND e.enabled`,
        [leadId, funnelStatusId, lineType, WRAPUP]
    );
    return result.rows[0] ? result.rows[0].duration_seconds : null;
}

/**
 * Сторож брошенных карточек. Зовётся тиком планировщика.
 *
 * ПИШЕТ ОТ ИМЕНИ СИСТЕМЫ. Без служебного автора журнал показал бы «не указан» —
 * то есть правку из админки, которой никто не делал (решение владельца 98,
 * механизм `auditContext.runAsService`).
 *
 * `opened_at` снимается ЗДЕСЬ ЖЕ, вместе с пометкой: пост-обработка закрывает
 * карточку помимо трёх случаев, которые снимают признак сегодня (сохранение
 * статуса, архивация, вывод сотрудника), и не снять его значило бы оставить лида
 * «открытым» навсегда — в очередь он не вернётся и никому не достанется, потому
 * что проверка занятости оператора считает его работой.
 */
async function closeAbandonedWrapups(pool) {
    return auditContext.runAsService('Система', async () => {
        const result = await pool.query(
            `UPDATE leads l
                SET opened_at = NULL, partially_filled = true, employee_id = NULL, updated_at = NOW()
              WHERE l.opened_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM call_events WHERE kind = $1 AND enabled)
                AND EXISTS (
                    SELECT 1
                      FROM lead_script_statuses lss
                      JOIN call_wrapup_rules w
                        ON w.script_id = lss.script_id AND w.line_type = l.line_type
                     WHERE lss.lead_id = l.id
                       AND lss.funnel_status_id = l.funnel_status_id
                       AND l.opened_at + make_interval(secs => w.duration_seconds + $2) <= NOW()
                )
              RETURNING l.id`,
            [WRAPUP, GRACE_SECONDS]
        );
        return result.rows.map((r) => r.id);
    });
}

module.exports = {
    WRAPUP,
    GRACE_SECONDS,
    resolveWrapupSeconds,
    closeAbandonedWrapups
};
