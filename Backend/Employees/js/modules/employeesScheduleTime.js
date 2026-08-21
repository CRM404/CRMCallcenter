// Переименован из scheduleTime.js при переносе в оболочку. Сам код не тронут:
// модуль чистый — ни одного обращения к document, только вычисления над
// строками времени и датами. Переименование нужно по другой причине: все
// статические папки монтируются в один корень, и общее имя рано или поздно
// столкнётся с чужим файлом.
//
// --- employeesScheduleTime.js: чистые расчёты режима «График» (без DOM) ---
//
// Здесь длительность смены, суммы часов, форматирование, разбор и проверка
// формата времени и «Дней», а также вся календарная арифметика месяца.
// Модуль намеренно не знает про DOM: этой же формулой считаются «Итого»,
// предпросмотр в модалке и любой будущий отчёт по часам — три копии означали бы
// три разных числа при первой же правке.
//
// Даты везде ходят строками 'YYYY-MM-DD', как их отдаёт API (в db.js парсер
// DATE переопределён на строку). Перевод в Date и обратно — единственное место,
// где легко потерять сутки на часовом поясе, поэтому его тут нет: недели
// считаются через Date.UTC, а перебор дней — через числа.

export const DAYS_FORMAT_ERROR = 'Нужно два числа через дробь: 5/2, 3/3, 2/2. Первое — рабочие дни, второе — выходные.';
export const TIME_FORMAT_ERROR = 'Нужно время начала и конца через дефис: 09:00-18:00.';
export const TIME_EQUAL_ERROR = 'Начало и конец смены не должны совпадать: смена нулевой длительности.';

const MONTHS_NOMINATIVE = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];
const MONTHS_GENITIVE = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];
// Индекс — результат getUTCDay(): 0 это воскресенье.
const DOW_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// --- Время смены ---

function toMinutes(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
}

// Длительность одной смены. shift_end <= shift_start означает ночную смену:
// прибавляем сутки. Ночная смена целиком относится к дню, в котором началась —
// на следующий день ничего не переносится.
export function shiftMinutes(start, end) {
    if (!start || !end) return 0;
    let diff = toMinutes(end) - toMinutes(start);
    if (diff <= 0) diff += 24 * 60;
    return diff;
}

// «207 ч», «2 ч 30 мин» — минуты показываются только когда они есть.
export function formatHours(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

// Компактная запись для ячеек, плашек и колонки «Список»: длинное тире без
// пробелов — в ячейке 44 px лишние пробелы стоят места.
export function formatRangeCompact(start, end) {
    return `${start}–${end}`;
}

// Запись для подписей меню и предпросмотра — то же тире, но с пробелами.
export function formatRangeSpaced(start, end) {
    return `${start} – ${end}`;
}

// Значение поля ввода в карточке сотрудника — через дефис, как в макете.
export function formatShiftInput(start, end) {
    return start && end ? `${start}-${end}` : '';
}

function normalizeTime(hoursRaw, minutesRaw) {
    const hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Разбор одного поля «Время смены». Принимаем «9:00-18:00» без ведущего нуля,
// пробелы вокруг разделителя и вставленные тире – и —; отдаём нормализованное
// { start, end } либо { error } с дословным текстом из макета.
export function parseShiftInput(raw) {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (value === '') return { start: null, end: null };
    const m = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(value.replace(/\s*([-–—])\s*/, '$1'));
    if (!m) return { error: TIME_FORMAT_ERROR };
    const start = normalizeTime(m[1], m[2]);
    const end = normalizeTime(m[3], m[4]);
    if (!start || !end) return { error: TIME_FORMAT_ERROR };
    if (start === end) return { error: TIME_EQUAL_ERROR };
    return { start, end };
}

// Поле «Дни»: два целых через дробь, оба больше нуля, каждое не больше 31.
// Справочная запись — в расчёте заполнения не участвует ни в каком виде.
export function parseWorkDaysInput(raw) {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (value === '') return { value: null };
    const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(value);
    if (!m) return { error: DAYS_FORMAT_ERROR };
    const work = Number(m[1]);
    const off = Number(m[2]);
    if (work < 1 || off < 1 || work > 31 || off > 31) return { error: DAYS_FORMAT_ERROR };
    return { value: `${work}/${off}` };
}

// --- Календарь месяца ---

export function daysInMonth(monthKey) {
    const [year, month] = monthKey.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dayKey(monthKey, day) {
    return `${monthKey}-${String(day).padStart(2, '0')}`;
}

export function monthKeyOf(dateKey) {
    return dateKey.slice(0, 7);
}

export function dayOf(dateKey) {
    return Number(dateKey.slice(8));
}

export function shiftMonth(monthKey, delta) {
    const [year, month] = monthKey.split('-').map(Number);
    const total = year * 12 + (month - 1) + delta;
    const newYear = Math.floor(total / 12);
    const newMonth = total % 12 + 1;
    return `${newYear}-${String(newMonth).padStart(2, '0')}`;
}

// День недели: 0 — воскресенье. Через UTC, чтобы пояс браузера не сдвинул дату.
export function weekdayOf(monthKey, day) {
    const [year, month] = monthKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekdayShort(monthKey, day) {
    return DOW_SHORT[weekdayOf(monthKey, day)];
}

export function isWeekend(monthKey, day) {
    const w = weekdayOf(monthKey, day);
    return w === 0 || w === 6;
}

// «Август 2026»
export function monthLabel(monthKey) {
    const [year, month] = monthKey.split('-').map(Number);
    return `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
}

// «август 2026» — для плашки пустого месяца.
export function monthLabelLower(monthKey) {
    return monthLabel(monthKey).toLowerCase();
}

// «августа» — для подписей вида «13 августа».
export function monthGenitive(monthKey) {
    return MONTHS_GENITIVE[Number(monthKey.slice(5, 7)) - 1];
}

// «13 августа»
export function formatDayGenitive(monthKey, day) {
    return `${day} ${monthGenitive(monthKey)}`;
}

// Дата целиком, с месяцем ИЗ САМОЙ ДАТЫ, а не из открытого месяца: метки о
// границах занятости показываются во всех месяцах, и «уволен 20 августа» при
// открытом сентябре не должно превращаться в «уволен 20 сентября». Неверная
// дата в интерфейсе хуже отсутствующей — её не перепроверяют.
//
// Год добавляется, только если он отличается от года открытого месяца:
// открыт январь 2027, уволен 20 августа 2026 — «уволен 20 августа 2026».
export function formatDateGenitive(dateKey, openMonthKey) {
    const base = formatDayGenitive(monthKeyOf(dateKey), dayOf(dateKey));
    const year = dateKey.slice(0, 4);
    return year === openMonthKey.slice(0, 4) ? base : `${base} ${year}`;
}

// день / дня / дней
/**
 * Русское числительное: 1 смена, 2 смены, 5 смен. Общий вид — потому что
 * склонять приходится не только дни: предпросмотр заполнения обещал «1 смен»
 * и «1 выходных» (К117), а строкой выше в том же окне дни склонялись верно.
 */
export function plural(n, one, few, many) {
    const tens = n % 100;
    const units = n % 10;
    if (tens > 10 && tens < 20) return many;
    if (units === 1) return one;
    if (units >= 2 && units <= 4) return few;
    return many;
}

export function pluralDays(n) {
    return plural(n, 'день', 'дня', 'дней');
}

// --- Имя сотрудника ---

// В сетке колонка сотрудника 224–244 px и закреплена — полное ФИО туда не
// влезет. Короткая форма «Фамилия И. О.» используется и в заголовке поповера,
// и в тостах; полное ФИО живёт в title.
export function shortName(employee) {
    const initials = [employee.firstName, employee.middleName]
        .filter(Boolean)
        .map((part) => `${part.trim().charAt(0).toUpperCase()}.`)
        .join(' ');
    return [employee.lastName, initials].filter(Boolean).join(' ').trim();
}

export function fullName(employee) {
    return [employee.lastName, employee.firstName, employee.middleName].filter(Boolean).join(' ').trim();
}

export function initialsOf(employee) {
    const last = (employee.lastName || '').trim().charAt(0).toUpperCase();
    const first = (employee.firstName || '').trim().charAt(0).toUpperCase();
    return `${last}${first}` || '?';
}
