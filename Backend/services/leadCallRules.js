// --- services/leadCallRules.js: что происходит с лидом при сохранении статуса ---
//
// Правила (бриф п.4). Статус с releases_lead = true:
//   1. employee_id = NULL — оператор отцепляется сразу;
//   2. last_call_at = NOW(), opened_at = NULL;
//   3. есть строка автоперезвона для этого статуса — call_attempts + 1 и
//      next_call_at = «через интервал строки», сдвинутый в окно события;
//   4. requires_call_time («Перезвон») — next_call_at = выбранное оператором
//      время, счётчик НЕ растёт: он про недозвоны, а не про договорённости;
//   5. после предела попыток ЭТОЙ строки — статус, который в ней назван,
//      next_call_at = NULL, лид выпадает из автоперезвона.
//
// ЧТО ИЗМЕНИЛОСЬ В ЗАХОДЕ 2. Пункты 3 и 5 читались из констант кода и из флага
// `auto_recall` у статуса; теперь их задаёт руководитель строкой события. Флаг
// колонки больше не решает ничего: решает наличие строки. Это не смена правила,
// а смена источника — в день выкатки засев даёт ровно прежние числа, и четыре
// строки заведены ровно тем статусам, у которых флаг стоял.
//
// ИНТЕРВАЛ И ПРЕДЕЛ БЕРУТСЯ У СТАТУСА, КОТОРЫЙ СТАВЯТ (ответ куратора 14, 15).
// Так работал и прежний код: `fetchStatusFlags(client, statusId)` брал признаки
// проставляемого статуса. Следствие названо вслух: счётчик попыток сквозной
// (решение владельца 13), предел свой у каждого статуса (решение 12) — значит
// лид с восемью попытками, которому поставили статус с пределом пять, уходит на
// «статус после предела» немедленно. Это норма новой настройки, а не край.
//
// Оператор не закрепляется ни за автоматическим перезвоном, ни за назначенным
// вручную: лид возвращается в ОБЩУЮ очередь (решение владельца). «Общая» значит
// «не персональная», а не «всем подряд» — линия и пул раздачи сохраняются.
//
// Ручной «Перезвон» вне рабочего окна оператор поставить может: клиент вправе
// попросить любое время. Сдвигается только автоматический.

const { nextAutoRecallAt } = require('./appTime');
const { fetchAutoRecall, fetchAutoRecallState } = require('./callEvents');

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
        // Кем назначен перезвон. Пусто, пока перезвона нет вовсе; ставится
        // вместе с временем и только здесь — иначе признак и время разошлись бы
        // (ловушка 7 наряда: смена интервала пересчитывает автоматические и не
        // трогает назначенные руками).
        next_call_source: null,
        call_attempts: currentAttempts,
        last_call_at: undefined,   // undefined = не трогаем колонку
        employee_id: undefined
    };

    if (!statusFlags || !statusFlags.releases_lead) {
        return effects;
    }

    effects.employee_id = null;
    effects.last_call_at = now;

    // Строка события вместо флага колонки. null — перезванивать не по чему, и
    // причин у этого несколько (события нет, выключено, без окна, без строки на
    // этот статус). Отсюда они неразличимы намеренно: лид в любом случае уходит
    // из очереди без перезвона, ровно как уходил статус без флага.
    const recall = await fetchAutoRecall(db, statusId);

    if (recall) {
        effects.call_attempts = currentAttempts + 1;
        // СРАВНЕНИЕ ОСТАВЛЕНО ДОСЛОВНО ПРЕЖНИМ: сначала +1, потом `>=`. При
        // пределе двадцать переход даёт ДВАДЦАТАЯ попытка. Замена `>=` на `>`
        // тихо добавила бы всем по одной попытке (предупреждение куратора).
        if (effects.call_attempts >= recall.maxAttempts) {
            // Статус после предела назван в самой строке и объявлен NOT NULL:
            // «строки нет — правила нет» отработало выше, а строка без целевого
            // статуса невозможна. Прежней подстановки статуса по имени здесь
            // больше нет — она решала за владельца, куда уходит лид.
            effects.funnel_status_id = recall.afterStatusId;
            effects.next_call_at = null;
        } else {
            effects.next_call_at = nextAutoRecallAt(now, recall.intervalMinutes, recall.window);
            effects.next_call_source = 'auto';
        }
        return effects;
    }

    if (statusFlags.requires_call_time) {
        effects.next_call_at = nextCallAt;
        effects.next_call_source = nextCallAt ? 'manual' : null;
        return effects;
    }

    // Отпускающий статус без автоперезвона и без времени — лид уходит из очереди
    // совсем (next_call_at = NULL) и ждёт следующего этапа воронки.
    return effects;
}

// Проверка при старте сервера (dialog.md A1). Заведена не зря: флаги статусов
// проставлялись миграцией ПО НАЗВАНИЮ, и один лишний пробел молча выключал
// автоперезвон — без единой ошибки в логе.
//
// ПЕРВАЯ ПОЛОВИНА ПЕРЕНАЦЕЛЕНА, А НЕ УДАЛЕНА (наряд, ловушка 3). Сторожить флаг
// `auto_recall` больше незачем — решает строка события; но погасить обзвон
// целиком стало ЛЕГЧЕ, чем было: достаточно снять галочку на вкладке. Причины
// названы порознь, потому что чинятся в разных местах.
//
// ВТОРАЯ ПОЛОВИНА ОСТАЁТСЯ ДО ЗАХОДА 4. Пока вкладка «Статусы воронки» только
// на чтение, `requires_call_time` ставит одна миграция по названиям, и
// утверждение «ровно у одного» ещё верно. Заход 4 делает признак правимым —
// владелец вправе поставить его хоть трём статусам, и сторож начнёт ругаться на
// законную настройку; тогда эта половина снимается совсем, а не смягчается.
async function checkStatusFlagsConfigured(db) {
    const recall = await fetchAutoRecallState(db);
    if (!recall) {
        console.error('[события] Строки события «Автоперезвон» нет в базе — система не перезванивает никому. Засев не отработал.');
    } else if (!recall.enabled) {
        console.error('[события] Событие «Автоперезвон» выключено — система не перезванивает никому.');
    } else if (!recall.has_window) {
        console.error('[события] У события «Автоперезвон» не задано рабочее окно — перезвоны не назначаются.');
    } else if (recall.rules === 0) {
        console.error('[события] В событии «Автоперезвон» нет ни одной строки — перезванивать не по каким статусам.');
    }

    const result = await db.query(
        `SELECT count(*) FILTER (WHERE requires_call_time)::int AS requires_call_time,
                count(*) FILTER (WHERE releases_lead)::int AS releases_lead
         FROM lead_funnel_statuses`
    );
    const counts = result.rows[0];
    if (counts.requires_call_time !== 1) {
        console.error(`[статусы] requires_call_time стоит у ${counts.requires_call_time} статусов вместо одного — выбор времени перезвона показывается неверно.`);
    }
    return { ...counts, recall };
}

module.exports = {
    fetchStatusFlags,
    resolveCallStatusEffects,
    checkStatusFlagsConfigured
};
