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

// ЧЕТЫРЕ КОНСТАНТЫ ОТСЮДА УШЛИ В НАСТРОЙКУ (часть 9, заход 2). Рабочее окно
// 9–21, интервал «через час» и предел двадцать попыток стояли здесь до коммита
// `847b645`; теперь их задаёт руководитель на вкладке «Звонки → События», а
// читает `services/callEvents.js`. Оставить их здесь копией значило бы завести
// второй источник правды: при расхождении никто не знал бы, который настоящий.
//
// ЗНАЧЕНИЯ ПРИХОДЯТ ПАРАМЕТРОМ, А МОДУЛЬ ОСТАЁТСЯ СИНХРОННЫМ. Чтение настройки
// — запрос к базе, а этот модуль зовут места, которые ждать не умеют. Достаёт
// значения тот, кто и так асинхронный, — `resolveCallStatusEffects`.

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

// Минуты от полуночи из «HH:MM» или «HH:MM:SS». Колонки окна объявлены TIME, и
// драйвер отдаёт их строкой.
//
// ПОЧЕМУ НЕ ВЗЯТЬ ГОТОВЫЙ `parseTimeOfDay` ИЗ `scheduleFormat.js`. Тот модуль
// уже требует этот (`scheduleFormat.js:12`), и обратная ссылка замкнула бы
// круг. Разбор здесь свой на четыре строки, а общее правило — «конец меньше
// начала значит через полночь» — соблюдается ниже дословно.
function minutesOfDay(time) {
    const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(time));
    if (!m) return null;
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

// Сдвиг АВТОМАТИЧЕСКОГО перезвона в рабочее окно. Ручной «Перезвон» этим не
// трогается: клиент вправе попросить любое время, и обещание оператора важнее
// нашего окна (бриф п.4).
//
// Границы окна — из события, параметром: `{ from: '09:00:00', to: '21:00:00' }`.
//
// ОКНО ЧЕРЕЗ ПОЛНОЧЬ ЧИТАЕТСЯ КАК НОЧНАЯ СМЕНА В ГРАФИКЕ: конец меньше начала —
// значит окно переваливает за полночь (`services/scheduleFormat.js:57`, ответ
// куратора 32). Двух разных прочтений одной пары времён в проекте быть не
// должно.
//
// Окно полуоткрытое: ровно `to` — уже снаружи. Так вело себя и прежнее правило
// с константами 9 и 21.
//
// БРОСАЕТ, А НЕ ПОДСТАВЛЯЕТ УМОЛЧАНИЕ. Неразобранное окно значит, что настройка
// пришла битой; подставить сюда 9–21 значило бы звонить по числу, которого
// никто не задавал, и молча. Настоящий вызов сюда с битым окном не доходит:
// `fetchAutoRecall` не отдаёт правило, пока окно не пара и не осмысленно.
function shiftIntoCallWindow(date, window) {
    const from = minutesOfDay(window && window.from);
    const to = minutesOfDay(window && window.to);
    if (from === null || to === null) {
        throw new Error(`Рабочее окно обзвона не разобрано: ${JSON.stringify(window)}`);
    }

    const p = zonedParts(date);
    const at = p.hour * 60 + p.minute;
    const wraps = to < from;
    const inside = wraps ? (at >= from || at < to) : (at >= from && at < to);
    if (inside) return date;

    // Снаружи окна — ближайшее открытие. У обычного окна оно сегодня, если ещё
    // не наступило, и завтра, если день уже кончился. У окна через полночь
    // снаружи можно оказаться только между концом и началом ОДНИХ суток —
    // открытие всегда сегодня и всегда впереди.
    const day = (wraps || at < from) ? p : zonedParts(startOfNextDay(date));
    return instantFromZoned(day.year, day.month, day.day, Math.floor(from / 60), from % 60);
}

// Момент следующей автоматической попытки: интервал из строки события и сдвиг в
// окно события. Интервал в МИНУТАХ — так его задаёт руководитель и так он лежит
// в `call_recall_rules.interval_minutes`; часов здесь больше нет.
function nextAutoRecallAt(now, intervalMinutes, window) {
    const minutes = Number(intervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`Интервал автоперезвона не задан: ${intervalMinutes}`);
    }
    const raw = new Date(now.getTime() + minutes * 60 * 1000);
    return shiftIntoCallWindow(raw, window);
}

module.exports = {
    APP_TIMEZONE,
    HELD_LEAD_RELEASE_HOURS,
    MAX_OPEN_INTERVAL_HOURS,
    zonedParts,
    instantFromZoned,
    minutesOfDay,
    startOfDay,
    startOfNextDay,
    shiftIntoCallWindow,
    nextAutoRecallAt
};
