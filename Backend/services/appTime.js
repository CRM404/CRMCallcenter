// --- services/appTime.js: часовой пояс приложения и рабочее окно обзвона ---
//
// Зачем отдельный модуль. Часового пояса в проекте не было задано нигде: ни
// переменной TZ, ни настройки в railway.json, ни AT TIME ZONE в запросах. На
// Railway контейнер идёт в UTC, локально — UTC+3, и три механизма этой задачи
// завязаны на «время сервера»: окно автоперезвона, границы суток для сумм по
// состояниям и сравнение next_call_at с текущим моментом. На бою при UTC окно
// 09:00–21:00 превратилось бы в 12:00–00:00 по Москве (звоним до полуночи, не
// звоним с утра), а «сегодня» у оператора начиналось бы в 03:00.
//
// Решение куратора (dialog.md B1): пояс — ЯВНАЯ КОНСТАНТА в коде, а не
// переменная окружения, которую однажды забудут проставить. Переменную TZ не
// трогаем.
//
// Как это живёт вместе с колонками TIMESTAMP (без пояса). Всё, что пишется из
// кода, вычисляется здесь как АБСОЛЮТНЫЙ момент (JS Date) и уходит в запрос
// параметром с явным приведением $n::timestamptz — Postgres сам переведёт его в
// пояс сессии, то есть в тот же вид, в котором колонки хранят NOW(). Сравнения
// вида next_call_at <= NOW() при этом остаются корректными независимо от пояса
// контейнера: обе стороны в одном и том же поясе сессии.
//
// В бэклоге (замечание куратора): окно должно считаться по поясу КЛИЕНТА, а не
// приложения — у лида есть регион и город, и 21:00 по Москве это 04:00 во
// Владивостоке. Пока работаем по поясу приложения.

// Пояс приложения. Меняется одной строкой.
const APP_TIMEZONE = 'Europe/Moscow';

// Рабочее окно автоперезвона. Владелец не ответил, выкатывается со значениями по
// умолчанию (регламент приёмки 15.08.2026) — правится одной строкой.
const CALL_WINDOW_START_HOUR = 9;
const CALL_WINDOW_END_HOUR = 21;

// Через сколько автоперезвон повторяет попытку и сколько попыток всего.
const AUTO_RECALL_INTERVAL_HOURS = 1;
const MAX_CALL_ATTEMPTS = 20;

// Сколько оператор может быть вне линии, прежде чем удержанный за ним лид
// вернётся в общую очередь. Тоже значение по умолчанию, ждёт владельца.
const HELD_LEAD_RELEASE_HOURS = 2;

// Потолок непрерывного интервала состояния (решение куратора, dialog.md C3,
// вариант «а» + «б»): оператор закрыл вкладку, не выйдя из системы, — интервал
// висит открытым и «На линии» накрутит всю ночь. Интервал старше этого порога
// закрывается принудительно при следующем обращении.
const MAX_OPEN_INTERVAL_HOURS = 12;

// Части даты в поясе приложения. Intl вместо самодельной арифметики: перевод
// «абсолютный момент -> стенные часы зоны» — единственное место, где легко
// ошибиться на час, и городить его руками незачем.
const PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function zonedParts(date) {
    const parts = {};
    PARTS_FORMAT.formatToParts(date).forEach((p) => {
        if (p.type !== 'literal') parts[p.type] = Number(p.value);
    });
    // hour12: false в некоторых средах отдаёт 24 вместо 00 для полуночи.
    if (parts.hour === 24) parts.hour = 0;
    return parts;
}

// Смещение зоны в этот момент, в миллисекундах.
function zoneOffsetMs(date) {
    const p = zonedParts(date);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Обратное преобразование: стенные часы зоны -> абсолютный момент. Второй проход
// нужен только на переводах часов (в Москве их нет с 2014 года, но код не должен
// зависеть от того, что пояс выбран именно московский).
function instantFromZoned(year, month, day, hour, minute) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    let ms = guess - zoneOffsetMs(new Date(guess));
    ms = guess - zoneOffsetMs(new Date(ms));
    return new Date(ms);
}

// Начало календарных суток (в поясе приложения), в которые попадает date.
function startOfDay(date) {
    const p = zonedParts(date);
    return instantFromZoned(p.year, p.month, p.day, 0, 0);
}

function startOfNextDay(date) {
    return new Date(startOfDay(date).getTime() + 24 * 3600 * 1000);
}

// Попадает ли момент в рабочее окно обзвона.
function isInsideCallWindow(date) {
    const hour = zonedParts(date).hour;
    return hour >= CALL_WINDOW_START_HOUR && hour < CALL_WINDOW_END_HOUR;
}

// Сдвиг АВТОМАТИЧЕСКОГО перезвона в рабочее окно. Ручной «Перезвон» этим не
// трогается: клиент вправе попросить любое время, и обещание оператора важнее
// нашего окна (бриф п.4).
//
// Раньше окна — сегодняшнее открытие; позже — открытие следующего дня.
// Граничный случай ровно 21:00 попадает во вторую ветку: окно полуоткрытое.
function shiftIntoCallWindow(date) {
    const p = zonedParts(date);
    if (p.hour < CALL_WINDOW_START_HOUR) {
        return instantFromZoned(p.year, p.month, p.day, CALL_WINDOW_START_HOUR, 0);
    }
    if (p.hour >= CALL_WINDOW_END_HOUR) {
        const next = startOfNextDay(date);
        const n = zonedParts(next);
        return instantFromZoned(n.year, n.month, n.day, CALL_WINDOW_START_HOUR, 0);
    }
    return date;
}

// Момент следующей автоматической попытки: «через час» и сдвиг в окно.
function nextAutoRecallAt(now) {
    const raw = new Date(now.getTime() + AUTO_RECALL_INTERVAL_HOURS * 3600 * 1000);
    return shiftIntoCallWindow(raw);
}

module.exports = {
    APP_TIMEZONE,
    CALL_WINDOW_START_HOUR,
    CALL_WINDOW_END_HOUR,
    AUTO_RECALL_INTERVAL_HOURS,
    MAX_CALL_ATTEMPTS,
    HELD_LEAD_RELEASE_HOURS,
    MAX_OPEN_INTERVAL_HOURS,
    zonedParts,
    instantFromZoned,
    startOfDay,
    startOfNextDay,
    isInsideCallWindow,
    shiftIntoCallWindow,
    nextAutoRecallAt
};
