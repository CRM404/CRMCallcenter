// --- services/scheduleFormat.js: форматы графика работы (разбор и проверка) ---
//
// Переиспользуется двумя роутами, поэтому лежит здесь, а не внутри одного из них:
// routes/employees.js проверяет «Дни» и время смены в карточке сотрудника,
// routes/schedule.js — состояние и время дня графика. Одна и та же строка
// «21:00-23:30» приходит с двух экранов, и два разных разбора означали бы два
// разных набора того, что считается допустимым.
//
// Проверка на сервере не дублирует клиентскую «на всякий случай»: и
// PUT /api/employees/:id, и PUT /api/schedule/day доступны в обход формы.

const { zonedParts } = require('./appTime');

// Состояния дня. Список держим одной константой — CHECK-констрейнта в базе нет
// намеренно (см. комментарий к employee_schedule_days в schema.sql).
const SCHEDULE_STATES = ['shift', 'day_off', 'vacation', 'sick'];

// Потолок для поля «Дни»: больше месяца подряд не имеет смысла ни в одну сторону.
const MAX_CYCLE_DAYS = 31;

// Тексты ошибок — дословно из макета (report_designer.md, п.9). Их видит
// пользователь, и на клиенте они те же самые.
const DAYS_FORMAT_ERROR = 'Нужно два числа через дробь: 5/2, 3/3, 2/2. Первое — рабочие дни, второе — выходные.';
const TIME_FORMAT_ERROR = 'Нужно время начала и конца через дефис: 09:00-18:00.';
const TIME_EQUAL_ERROR = 'Начало и конец смены не должны совпадать: смена нулевой длительности.';

function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
}

// «Дни»: два целых через дробь, оба больше нуля, каждое не больше 31.
// Возвращает нормализованную строку «5/2» или null, если формат не распознан.
function parseWorkDays(raw) {
    if (isBlank(raw)) return null;
    const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(raw));
    if (!m) return null;
    const work = Number(m[1]);
    const off = Number(m[2]);
    if (work < 1 || off < 1) return null;
    if (work > MAX_CYCLE_DAYS || off > MAX_CYCLE_DAYS) return null;
    return `${work}/${off}`;
}

// Время суток. Принимаем «9:00» без ведущего нуля и «21:00:00» от Postgres,
// возвращаем строго 'HH:MM' — секунд в проекте не показываем нигде.
function parseTimeOfDay(raw) {
    if (isBlank(raw)) return null;
    const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(raw));
    if (!m) return null;
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Пара «начало/конец» смены. Оба пустые — законно (время не указано), один
// пустой — нет. shift_end < shift_start допустимо: это ночная смена.
// Возвращает { start, end } (оба null или оба 'HH:MM') либо { error }.
function parseShiftTimes(rawStart, rawEnd) {
    const startBlank = isBlank(rawStart);
    const endBlank = isBlank(rawEnd);
    if (startBlank && endBlank) return { start: null, end: null };
    if (startBlank || endBlank) return { error: TIME_FORMAT_ERROR };
    const start = parseTimeOfDay(rawStart);
    const end = parseTimeOfDay(rawEnd);
    if (!start || !end) return { error: TIME_FORMAT_ERROR };
    if (start === end) return { error: TIME_EQUAL_ERROR };
    return { start, end };
}

function isValidState(state) {
    return SCHEDULE_STATES.includes(state);
}

// --- Даты ---
//
// DATE в проекте ходит строкой 'YYYY-MM-DD' (парсер типа переопределён в db.js),
// поэтому и здесь работаем со строками: перевод в Date и обратно — единственное
// место, где легко потерять сутки на часовом поясе.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

function isValidDateKey(raw) {
    if (typeof raw !== 'string') return false;
    const m = DATE_RE.exec(raw);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12) return false;
    return day >= 1 && day <= daysInMonth(year, month);
}

function isValidMonthKey(raw) {
    return typeof raw === 'string' && MONTH_RE.test(raw);
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthKeyOf(dateKey) {
    return dateKey.slice(0, 7);
}

// Первый и последний день месяца строками. Границы выборки экрана и диапазона
// заполнения считаются только здесь.
function monthBounds(monthKey) {
    const [year, month] = monthKey.split('-').map(Number);
    const last = daysInMonth(year, month);
    return { first: `${monthKey}-01`, last: `${monthKey}-${String(last).padStart(2, '0')}`, days: last };
}

// Все дни диапазона включительно, строками. Диапазон всегда внутри одного
// месяца (заполнение за границу месяца не выходит никогда), поэтому арифметика
// сводится к перебору чисел — без Date и без риска уехать на сутки.
function daysBetween(fromKey, toKey) {
    const monthKey = monthKeyOf(fromKey);
    const from = Number(fromKey.slice(8));
    const to = Number(toKey.slice(8));
    const result = [];
    for (let d = from; d <= to; d++) {
        result.push(`${monthKey}-${String(d).padStart(2, '0')}`);
    }
    return result;
}

// «Сегодня» в поясе приложения (services/appTime.js, Europe/Moscow). На Railway
// контейнер идёт в UTC, у клиента часы вообще свои — единственный источник
// правды по «сегодня» на этом экране здесь (dialog.md, Б3).
function todayKey(now = new Date()) {
    const p = zonedParts(now);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

module.exports = {
    SCHEDULE_STATES,
    MAX_CYCLE_DAYS,
    DAYS_FORMAT_ERROR,
    TIME_FORMAT_ERROR,
    TIME_EQUAL_ERROR,
    isBlank,
    parseWorkDays,
    parseTimeOfDay,
    parseShiftTimes,
    isValidState,
    isValidDateKey,
    isValidMonthKey,
    monthKeyOf,
    monthBounds,
    daysBetween,
    todayKey
};
