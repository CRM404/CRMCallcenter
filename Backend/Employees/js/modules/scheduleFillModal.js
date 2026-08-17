// --- scheduleFillModal.js: модалка «Добавить график» ---
//
// Правило заполнения (третья, действующая редакция): от выбранной даты до конца
// ОТКРЫТОГО месяца; отмеченный день → выходной, любой другой → смена с временем
// из карточки; дни вне периода работы пропускаются; всё прежнее затирается,
// включая отпуск и больничный. Шаблон «5/2» в расчёте не участвует ни в каком
// виде — выходные называет человек, они плавающие.

import { fillSchedule } from './storage.js';
import { showToast } from './toast.js';
import {
    getScheduleState, getEmployee, getDay, loadMonth, hasShiftTime, outOfEmployment
} from './scheduleView.js';
import {
    daysInMonth, dayKey, dayOf, monthKeyOf, monthLabel, monthGenitive,
    formatRangeSpaced, formatDayGenitive, pluralDays, shortName
} from './scheduleTime.js';

let modal;
let empSelect;
let fromInput;
let applyBtn;
let wkField;
let wkPanel;
let wkGrid;
let wkSummary;
let wkClearBtn;
let previewText;
let warnBox;

// Выходные, отмеченные администратором для ЭТОГО заполнения. Система их не
// вычисляет и нигде не хранит.
const picked = new Set();
let submitting = false;
// Сколько отметок снято сдвигом даты. Копится между пересчётами и обнуляется
// только осмысленным действием пользователя: поле даты выдаёт input и change
// подряд, и счётчик «за один пересчёт» стирался бы вторым же вызовом — то есть
// сообщение мелькало бы и исчезало, чего никто не увидит.
let dropped = 0;

const WEEK_DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function selectedEmployee() {
    return getEmployee(empSelect.value);
}

// Первый день диапазона. Значение поля ограничено месяцем и на уровне min/max,
// и здесь: поле доступно клавиатуре, и туда можно вписать что угодно.
function fromDayNumber() {
    const month = getScheduleState().month;
    const value = fromInput.value;
    if (!value || monthKeyOf(value) !== month) return 1;
    const day = dayOf(value);
    return day >= 1 && day <= daysInMonth(month) ? day : 1;
}

// День недоступен для отметки, если он раньше даты заполнения или вне периода
// работы сотрудника.
function dayLocked(employee, day) {
    if (day < fromDayNumber()) return true;
    return Boolean(outOfEmployment(employee, dayKey(getScheduleState().month, day)));
}

function renderCalendar(employee) {
    const month = getScheduleState().month;
    const total = daysInMonth(month);
    // Календарь начинается с понедельника.
    const firstWeekday = (new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)).getUTCDay() + 6) % 7;

    let html = WEEK_DAYS.map((name, i) => `<div class="wk-dow${i >= 5 ? ' wend' : ''}">${name}</div>`).join('');
    for (let i = 0; i < firstWeekday; i++) html += '<div class="wk-day blank"></div>';
    for (let d = 1; d <= total; d++) {
        const locked = dayLocked(employee, d);
        const on = picked.has(d);
        const classes = ['wk-day'];
        if (locked) classes.push('out');
        if (on) classes.push('on');
        const title = locked
            ? `${formatDayGenitive(month, d)} — вне диапазона заполнения`
            : formatDayGenitive(month, d);
        html += `<button type="button" class="${classes.join(' ')}" data-day="${d}" title="${title}"${locked ? ' disabled' : ''} aria-pressed="${on}">${d}</button>`;
    }
    wkGrid.innerHTML = html;
    wkClearBtn.disabled = picked.size === 0;
}

function summaryText() {
    const month = getScheduleState().month;
    const list = [...picked].sort((a, b) => a - b);
    if (list.length === 0) {
        return { text: 'Не отмечены — смены встанут на все дни подряд', none: true };
    }
    const shown = list.slice(0, 6).join(', ');
    const tail = list.length > 6 ? ` и ещё ${list.length - 6}` : '';
    return { text: `${list.length} ${pluralDays(list.length)}: ${shown}${tail} ${monthGenitive(month)}`, none: false };
}

// Пересчитывается на каждое действие в форме. Числа считаются по тем же
// правилам, что и на сервере, — иначе предпросмотр обещал бы одно, а
// заполнение делало другое.
function syncFill() {
    const employee = selectedEmployee();
    const month = getScheduleState().month;
    const box = document.getElementById('fillEmpSchedule');
    if (!employee) {
        applyBtn.disabled = true;
        return;
    }

    const ready = hasShiftTime(employee);
    box.classList.toggle('bad', !ready);
    document.getElementById('fillEmpTime').textContent = ready
        ? formatRangeSpaced(employee.shiftStart, employee.shiftEnd)
        : 'не заполнено в карточке сотрудника — заполните его там, тогда месяц можно будет проставить разом';
    // Режим — отдельной строкой без плашки: он справочный и на заполнение не влияет.
    //
    // Собирается узлами, а не innerHTML: workSchedule — единственное значение
    // здесь, которое вводит человек. Сегодня оно безопасно (сервер нормализует
    // его до «5/2» из двух чисел), но защита держалась бы целиком на валидации
    // в другом слое — расширят формат «Дней», и разметка поедет вслед за вводом.
    const daysBox = document.getElementById('fillEmpDays');
    daysBox.textContent = employee.workSchedule ? `${employee.workSchedule} ` : '';
    const daysNote = document.createElement('i');
    daysNote.textContent = employee.workSchedule ? '— справочно, выходные отмечаете вы' : 'не указан';
    daysBox.appendChild(daysNote);
    applyBtn.disabled = !ready || submitting;

    // Отметки, выпавшие из диапазона после сдвига даты, снимаются — но не
    // молча: иначе человек нажмёт «Заполнить», рассчитывая на то, чего уже нет.
    [...picked].forEach((d) => {
        if (dayLocked(employee, d)) {
            picked.delete(d);
            dropped++;
        }
    });
    renderCalendar(employee);

    const summary = summaryText();
    wkSummary.textContent = summary.text;
    wkSummary.classList.toggle('none', summary.none);

    if (!ready) {
        previewText.textContent = 'Заполнение недоступно, пока в карточке сотрудника не указано время смены.';
        warnBox.hidden = true;
        return;
    }

    const from = fromDayNumber();
    const last = daysInMonth(month);
    let shifts = 0;
    let daysOff = 0;
    let vacation = 0;
    let sick = 0;
    for (let d = from; d <= last; d++) {
        const key = dayKey(month, d);
        if (outOfEmployment(employee, key)) continue;
        if (picked.has(d)) daysOff++; else shifts++;
        const existing = getDay(employee.id, key);
        if (existing && existing.state === 'vacation') vacation++;
        if (existing && existing.state === 'sick') sick++;
    }

    previewText.innerHTML =
        `Заполнит <b>${from}–${last} ${monthGenitive(month)}</b>: <b>${shifts}</b> смен по <b>${formatRangeSpaced(employee.shiftStart, employee.shiftEnd)}</b>`
        + (daysOff ? ` и <b>${daysOff}</b> выходных по вашим отметкам` : ' — выходные не отмечены')
        + `. Дни до ${from}-го не меняются.`
        + (dropped ? ` <i>Снято отметок вне диапазона: ${dropped}.</i>` : '');

    if (vacation || sick) {
        const parts = [];
        if (vacation) parts.push(`${vacation} дн. отпуска`);
        if (sick) parts.push(`${sick} дн. больничного`);
        warnBox.textContent = `Внимание: будет затёрто ${parts.join(' и ')} — заполнение перезаписывает всё, что стоит в этих днях.`;
        warnBox.hidden = false;
    } else {
        warnBox.hidden = true;
    }
}

function closeModal() {
    modal.style.display = 'none';
}

function openModal() {
    const state = getScheduleState();
    if (!state.month) return;
    if (state.employees.length === 0) {
        showToast('Нет активных сотрудников — график заполнять некому', 'error');
        return;
    }

    empSelect.innerHTML = '';
    state.employees.forEach((employee) => {
        const option = document.createElement('option');
        option.value = String(employee.id);
        option.textContent = shortName(employee);
        empSelect.appendChild(option);
    });

    const total = daysInMonth(state.month);
    fromInput.min = dayKey(state.month, 1);
    fromInput.max = dayKey(state.month, total);
    // По умолчанию — сегодняшнее число, в месяце без «сегодня» первое.
    fromInput.value = state.today && monthKeyOf(state.today) === state.month
        ? state.today
        : dayKey(state.month, 1);

    picked.clear();
    dropped = 0;
    submitting = false;
    wkPanel.hidden = true;
    wkField.setAttribute('aria-expanded', 'false');
    document.getElementById('wkMonth').textContent = monthLabel(state.month);
    syncFill();
    modal.style.display = 'flex';
}

async function handleApply() {
    const employee = selectedEmployee();
    if (!employee || !hasShiftTime(employee) || submitting) return;
    const state = getScheduleState();
    const month = state.month;
    const from = fromDayNumber();
    const fromDate = dayKey(month, from);
    const dayOffDates = [...picked].sort((a, b) => a - b).map((d) => dayKey(month, d));

    submitting = true;
    applyBtn.disabled = true;
    let result;
    try {
        result = await fillSchedule({ employeeId: employee.id, fromDate, dayOffDates });
    } catch (err) {
        submitting = false;
        applyBtn.disabled = false;
        showToast(err.message, 'error');
        return;
    }
    submitting = false;
    closeModal();
    // Числа в тосте — из ответа сервера: только он знает, сколько строк реально
    // записано после пропуска дней вне периода работы.
    await loadMonth(month);
    showToast(
        `${shortName(employee)}: с ${formatDayGenitive(month, from)} проставлено ${result.shifts} смен и ${result.daysOff} выходных`,
        'success'
    );
}

export function initScheduleFillModal() {
    modal = document.getElementById('fillModal');
    empSelect = document.getElementById('fillEmp');
    fromInput = document.getElementById('fillFrom');
    applyBtn = document.getElementById('fillApplyBtn');
    wkField = document.getElementById('wkField');
    wkPanel = document.getElementById('wkPanel');
    wkGrid = document.getElementById('wkGrid');
    wkSummary = document.getElementById('wkSummary');
    wkClearBtn = document.getElementById('wkClear');
    previewText = document.getElementById('fillPreviewText');
    warnBox = document.getElementById('fillWarn');

    document.getElementById('schedFillBtn').addEventListener('click', openModal);
    document.getElementById('fillCloseBtn').addEventListener('click', closeModal);
    document.getElementById('fillCancelBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
    });

    // Смена сотрудника — новые границы найма, прежний счётчик снятых отметок
    // к ним отношения не имеет.
    empSelect.addEventListener('change', () => { dropped = 0; syncFill(); });
    fromInput.addEventListener('change', syncFill);
    fromInput.addEventListener('input', syncFill);

    // Календарь раскрывается прямо под полем, а не вторым шагом: какие дни
    // отмечать, зависит от того, с какого числа идёт заполнение, — эту связь
    // второй шаг разрывает.
    wkField.addEventListener('click', () => {
        const open = wkPanel.hidden;
        wkPanel.hidden = !open;
        wkField.setAttribute('aria-expanded', String(open));
    });
    wkGrid.addEventListener('click', (e) => {
        const button = e.target.closest('.wk-day');
        if (!button || button.disabled || button.classList.contains('blank')) return;
        const day = Number(button.dataset.day);
        if (picked.has(day)) picked.delete(day); else picked.add(day);
        // Человек снова взялся за отметки — сообщение о снятых устарело.
        dropped = 0;
        syncFill();
        // Сетка перерисована целиком — возвращаем фокус на тот же день.
        const again = wkGrid.querySelector(`.wk-day[data-day="${day}"]`);
        if (again) again.focus();
    });
    wkClearBtn.addEventListener('click', () => { picked.clear(); dropped = 0; syncFill(); });

    applyBtn.addEventListener('click', handleApply);
}
