// --- scheduleView.js: режим «График» — сетка, «Итого», подвал, счётчики ---
//
// Зона ответственности: состояние экрана (месяц, сотрудники, дни), отрисовка
// таблицы и шапки, тулбар и переключатель режима страницы. Поповер дня и модалка
// заполнения живут в своих модулях и обращаются сюда за состоянием.
//
// Режим «Список» этот модуль не трогает: график рисуется в отдельный контейнер,
// переключение — показ/скрытие, render.js не меняется.

import { fetchSchedule, fetchDepartments } from './storage.js';
import { showToast } from './toast.js';
import {
    shiftMinutes, formatHours, formatRangeCompact, formatRangeSpaced,
    daysInMonth, dayKey, monthKeyOf, shiftMonth, weekdayShort, isWeekend,
    monthLabel, monthLabelLower, formatDayGenitive, formatDateGenitive,
    shortName, fullName, initialsOf
} from './scheduleTime.js';

// Единственный источник правды для всего режима. today приходит с сервера в
// поясе приложения — «сегодня» на этом экране это подсветка колонки, четыре
// счётчика и дата по умолчанию в модалке, и часы браузера тут не при чём
// (dialog.md, Б3).
const state = {
    month: null,
    today: null,
    employees: [],
    days: new Map(),      // employeeId -> Map(dayKey -> day)
    departments: [],
    loaded: false
};

// Клики по ячейке, на которые ещё не пришёл ответ. Оптимистичной отрисовки нет,
// поэтому повторный клик до ответа обязан игнорироваться — иначе двойной клик
// уходит двумя запросами (dialog.md, Н17).
const pending = new Set();

let listSection;
let scheduleSection;
let listStatChips;
let schedStatChips;
let addEmployeeWrap;
let viewListBtn;
let viewScheduleBtn;
let searchInput;
let deptSelect;

export function getScheduleState() {
    return state;
}

export function pendingKey(employeeId, day) {
    return `${employeeId}:${day}`;
}

export function isDayPending(employeeId, day) {
    return pending.has(pendingKey(employeeId, day));
}

export function markDayPending(employeeId, day) {
    pending.add(pendingKey(employeeId, day));
}

export function clearDayPending(employeeId, day) {
    pending.delete(pendingKey(employeeId, day));
}

export function getEmployee(employeeId) {
    return state.employees.find((emp) => emp.id === Number(employeeId)) || null;
}

export function getDay(employeeId, day) {
    const byDay = state.days.get(Number(employeeId));
    return byDay ? byDay.get(day) || null : null;
}

export function setDayLocal(day) {
    const employeeId = Number(day.employeeId);
    if (!state.days.has(employeeId)) state.days.set(employeeId, new Map());
    state.days.get(employeeId).set(day.day, day);
}

export function deleteDayLocal(employeeId, day) {
    const byDay = state.days.get(Number(employeeId));
    if (byDay) byDay.delete(day);
}

// Есть ли у сотрудника время смены в карточке. Единственное условие
// доступности заполнения и пункта «Смена» — поле «Дни» на это не влияет.
export function hasShiftTime(employee) {
    return Boolean(employee && employee.shiftStart && employee.shiftEnd);
}

// Дни до приёма на работу и после увольнения не редактируются: заполнение их
// пропускает, клик по ним ничего не открывает.
export function outOfEmployment(employee, day) {
    if (employee.hireDate && day < employee.hireDate) return 'hire';
    if (employee.terminationDate && day > employee.terminationDate) return 'termination';
    return null;
}

function escapeHtml(str) {
    if (str === null || str === undefined || str === '') return '';
    return String(str).replace(/[&<>"]/g, (m) => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return m;
    });
}

// Поиск и фильтр отдела — на клиенте по уже загруженному месяцу: строк десятки,
// гонять запрос на каждую букву незачем.
export function visibleEmployees() {
    const query = (searchInput?.value || '').trim().toLowerCase();
    const dept = deptSelect?.value || '';
    return state.employees.filter((emp) => {
        const matchesQuery = !query || fullName(emp).toLowerCase().includes(query);
        // Отдел сравнивается по точному совпадению названия из справочника с
        // текстом в карточке: FK между ними нет (известный гэп, бриф п.8).
        const matchesDept = !dept || emp.department === dept;
        return matchesQuery && matchesDept;
    });
}

// --- Отрисовка ---

function cellStateOf(employee, day) {
    const outOf = outOfEmployment(employee, day);
    if (outOf) return { state: 'none', reason: outOf };
    const existing = getDay(employee.id, day);
    return existing ? { state: existing.state, day: existing } : { state: 'empty' };
}

function cellInner(cell) {
    if (cell.state === 'shift') {
        return `<span class="t1">${escapeHtml(cell.day.shiftStart)}</span><span class="t2">${escapeHtml(cell.day.shiftEnd)}</span>`;
    }
    if (cell.state === 'day_off') return 'Вых';
    if (cell.state === 'vacation') return 'ОТ';
    if (cell.state === 'sick') return 'Б';
    if (cell.state === 'none') return '·';
    return '';
}

function cellTitle(cell, dayNumber) {
    const date = formatDayGenitive(state.month, dayNumber);
    if (cell.state === 'shift') return `${date} — смена ${formatRangeSpaced(cell.day.shiftStart, cell.day.shiftEnd)}`;
    if (cell.state === 'day_off') return `${date} — выходной`;
    if (cell.state === 'vacation') return `${date} — отпуск`;
    if (cell.state === 'sick') return `${date} — больничный`;
    // Причины прочерка две, и подписи у них разные: одинаковая сделала бы их
    // неразличимыми ровно там, где различие и нужно (замечание дизайн-сессии).
    if (cell.state === 'none') {
        return cell.reason === 'termination' ? `${date} — после даты увольнения` : `${date} — до даты найма`;
    }
    return `${date} — не заполнено`;
}

function renderHead() {
    const total = daysInMonth(state.month);
    let html = '<th class="col-emp">Сотрудник</th>';
    for (let d = 1; d <= total; d++) {
        const classes = ['day'];
        if (isWeekend(state.month, d)) classes.push('wend');
        if (state.today === dayKey(state.month, d)) classes.push('today');
        html += `<th class="${classes.join(' ')}" data-day="${d}"><span class="dnum">${d}</span><span class="dow">${weekdayShort(state.month, d)}</span></th>`;
    }
    html += '<th class="col-total">Итого</th>';
    document.getElementById('schedHead').innerHTML = html;
}

// gaps — какие границы занятости реально видны в открытом месяце. Считаются в
// том же проходе по дням, что и сами ячейки, поэтому метка не может разойтись с
// тем, что нарисовано в строке (замечание куратора про границы месяца).
function renderEmployeeCell(employee, gaps) {
    const parts = [escapeHtml(employee.lineType || '')];
    if (hasShiftTime(employee)) {
        parts.push(`<span class="tpl-tag">${escapeHtml(formatRangeCompact(employee.shiftStart, employee.shiftEnd))}</span>`);
        if (employee.workSchedule) {
            parts.push(`<span class="tpl-mode" title="режим сотрудника — справочно">${escapeHtml(employee.workSchedule)}</span>`);
        }
    } else {
        parts.push('<span class="tpl-tag empty" title="Время смены не указано в карточке сотрудника">без времени смены</span>');
    }
    // Метка стоит в ЛЮБОМ месяце, где есть дни вне периода работы, а не только
    // в месяце самой даты: иначе строка из сплошных бледных точек остаётся без
    // единого объяснения и читается как поломка (решение владельца 17.08.2026).
    // Причин может быть две сразу — тогда обе метки, в хронологическом порядке.
    if (gaps.hire && employee.hireDate) {
        parts.push(`<span class="tpl-fired">принят ${escapeHtml(formatDateGenitive(employee.hireDate, state.month))}</span>`);
    }
    if (gaps.termination && employee.terminationDate) {
        parts.push(`<span class="tpl-fired">уволен ${escapeHtml(formatDateGenitive(employee.terminationDate, state.month))}</span>`);
    }
    return `
        <div class="emp-cell">
            <span class="avatar-initials av-${Math.abs(Number(employee.id) || 0) % 4}">${escapeHtml(initialsOf(employee))}</span>
            <div>
                <div class="emp-name" title="${escapeHtml(fullName(employee))}">${escapeHtml(shortName(employee))}</div>
                <div class="emp-sub">${parts.filter(Boolean).join('')}</div>
            </div>
        </div>`;
}

function renderBody() {
    const total = daysInMonth(state.month);
    let html = '';
    visibleEmployees().forEach((employee) => {
        let shifts = 0;
        let minutes = 0;
        let cells = '';
        const gaps = { hire: false, termination: false };
        for (let d = 1; d <= total; d++) {
            const key = dayKey(state.month, d);
            const cell = cellStateOf(employee, key);
            if (cell.state === 'shift') {
                shifts++;
                minutes += shiftMinutes(cell.day.shiftStart, cell.day.shiftEnd);
            }
            if (cell.state === 'none') gaps[cell.reason] = true;
            const tdClasses = ['day'];
            if (isWeekend(state.month, d)) tdClasses.push('wend');
            if (state.today === key) tdClasses.push('today');
            const disabled = cell.state === 'none' ? ' tabindex="-1"' : '';
            const busy = isDayPending(employee.id, key) ? ' pending' : '';
            cells += `<td class="${tdClasses.join(' ')}"><button type="button" class="cellbtn st-${cell.state}${busy}" data-emp="${employee.id}" data-day="${key}" title="${escapeHtml(cellTitle(cell, d))}"${disabled}>${cellInner(cell)}</button></td>`;
        }
        // «Итого» при отсутствии смен — прочерк, а не «0 ч».
        html += `<tr data-emp="${employee.id}">
            <td class="col-emp">${renderEmployeeCell(employee, gaps)}</td>
            ${cells}
            <td class="col-total"><div class="total-main">${shifts} см.</div><div class="total-sub">${minutes ? formatHours(minutes) : '—'}</div></td>
        </tr>`;
    });
    document.getElementById('schedBody').innerHTML = html;
}

function renderFoot() {
    const total = daysInMonth(state.month);
    const visible = visibleEmployees();
    let html = '<th class="col-emp">В смене</th>';
    for (let d = 1; d <= total; d++) {
        const key = dayKey(state.month, d);
        let count = 0;
        visible.forEach((employee) => {
            const cell = cellStateOf(employee, key);
            if (cell.state === 'shift') count++;
        });
        const classes = ['day'];
        if (isWeekend(state.month, d)) classes.push('wend');
        if (state.today === key) classes.push('today');
        if (!count) classes.push('zero');
        html += `<td class="${classes.join(' ')}">${count}</td>`;
    }
    html += '<td class="col-total"></td>';
    document.getElementById('schedFoot').innerHTML = html;
}

// Счётчики шапки — по колонке сегодняшнего дня и по ВИДИМЫМ строкам: иначе
// цифры спорят с таблицей под ними.
function renderChips() {
    const chips = { shift: 'chipShift', day_off: 'chipOff', vacation: 'chipVac', sick: 'chipSick' };
    const chipBoxes = schedStatChips.querySelectorAll('.stat-chip');
    const todayInMonth = state.today && monthKeyOf(state.today) === state.month;

    if (!todayInMonth) {
        // Другой месяц (или дата с сервера не пришла) — «—», а не нули: ноль это
        // утверждение «никто не в смене», и оно хуже честного прочерка.
        Object.values(chips).forEach((id) => { document.getElementById(id).textContent = '—'; });
        chipBoxes.forEach((box) => box.classList.add('muted'));
        return;
    }
    chipBoxes.forEach((box) => box.classList.remove('muted'));

    const counts = { shift: 0, day_off: 0, vacation: 0, sick: 0 };
    visibleEmployees().forEach((employee) => {
        const cell = cellStateOf(employee, state.today);
        if (counts[cell.state] !== undefined) counts[cell.state]++;
    });
    Object.entries(chips).forEach(([key, id]) => {
        document.getElementById(id).textContent = String(counts[key]);
    });
}

function renderEmptyNote() {
    let filled = false;
    state.days.forEach((byDay) => { if (byDay.size > 0) filled = true; });
    const note = document.getElementById('schedEmptyNote');
    note.hidden = filled;
    document.getElementById('schedEmptyNoteTitle').textContent = `График на ${monthLabelLower(state.month)} ещё не составлен`;
}

// Перерисовка без похода на сервер: после правки одной ячейки состояние уже
// обновлено локально ответом эндпоинта.
export function renderSchedule() {
    if (!state.month) return;
    renderBody();
    renderFoot();
    renderChips();
    renderEmptyNote();
}

function renderMonth() {
    document.getElementById('schedMonthLabel').textContent = monthLabel(state.month);
    renderHead();
    renderSchedule();
}

// --- Данные ---

export async function loadMonth(month) {
    let data;
    try {
        data = await fetchSchedule(month);
    } catch (err) {
        showToast(err.message, 'error');
        return false;
    }
    state.month = data.month;
    state.today = data.today || null;
    state.employees = data.employees || [];
    state.days = new Map();
    (data.days || []).forEach((day) => setDayLocal(day));
    state.loaded = true;
    renderMonth();
    return true;
}

// Справочник отделов — отдельным запросом: в контракте графика его нет, а
// эндпоинт уже существует. Дубли названий схлопываем (UNIQUE у departments.name
// нет), пустой справочник рисуем как в макете.
async function loadDepartments() {
    let departments = [];
    try {
        departments = await fetchDepartments();
    } catch (err) {
        showToast(err.message, 'error');
    }
    state.departments = [...new Set(departments.map((d) => d.name).filter(Boolean))];

    deptSelect.innerHTML = '';
    if (state.departments.length === 0) {
        deptSelect.disabled = true;
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Отделы не заведены';
        deptSelect.appendChild(option);
        return;
    }
    deptSelect.disabled = false;
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'Все отделы';
    deptSelect.appendChild(all);
    state.departments.forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        deptSelect.appendChild(option);
    });
}

function scrollToToday() {
    const th = document.querySelector('#schedHead th.day.today');
    if (th) th.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

// --- Переключение режима ---

function setMode(mode) {
    const isSchedule = mode === 'schedule';
    listSection.hidden = isSchedule;
    scheduleSection.hidden = !isSchedule;
    listStatChips.hidden = isSchedule;
    schedStatChips.hidden = !isSchedule;
    // Сотрудников заводят в «Списке» — в графике эта кнопка ведёт не туда, куда
    // человек в этот момент смотрит (решение куратора, вынесено на приёмку).
    addEmployeeWrap.hidden = isSchedule;
    viewListBtn.classList.toggle('active', !isSchedule);
    viewScheduleBtn.classList.toggle('active', isSchedule);
    viewListBtn.setAttribute('aria-selected', String(!isSchedule));
    viewScheduleBtn.setAttribute('aria-selected', String(isSchedule));
}

export function initScheduleView() {
    listSection = document.getElementById('listSection');
    scheduleSection = document.getElementById('scheduleView');
    listStatChips = document.getElementById('listStatChips');
    schedStatChips = document.getElementById('schedStatChips');
    addEmployeeWrap = document.getElementById('addEmployeeWrap');
    viewListBtn = document.getElementById('viewListBtn');
    viewScheduleBtn = document.getElementById('viewScheduleBtn');
    searchInput = document.getElementById('schedSearchInput');
    deptSelect = document.getElementById('schedDeptSelect');

    viewListBtn.addEventListener('click', () => setMode('list'));
    // Данные графика грузятся лениво — при первом переключении, а не на каждой
    // загрузке страницы «Сотрудники».
    viewScheduleBtn.addEventListener('click', async () => {
        setMode('schedule');
        if (!state.loaded) {
            await loadDepartments();
            // Месяц не передаём: сервер сам возьмёт текущий по поясу приложения.
            await loadMonth(undefined);
            scrollToToday();
        }
    });

    document.getElementById('schedPrevMonth').addEventListener('click', () => {
        if (state.month) loadMonth(shiftMonth(state.month, -1));
    });
    document.getElementById('schedNextMonth').addEventListener('click', () => {
        if (state.month) loadMonth(shiftMonth(state.month, 1));
    });
    document.getElementById('schedTodayBtn').addEventListener('click', async () => {
        if (!state.today) return;
        const todayMonth = monthKeyOf(state.today);
        if (state.month !== todayMonth) {
            const ok = await loadMonth(todayMonth);
            if (!ok) return;
        }
        scrollToToday();
    });

    searchInput.addEventListener('input', renderSchedule);
    deptSelect.addEventListener('change', renderSchedule);

    setMode('list');
}
