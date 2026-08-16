// --- scheduleDayMenu.js: поповер дня и второй шаг «Доп. смена» ---
//
// Каждое изменение мгновенное, без подтверждения. Оптимистичной отрисовки нет:
// сначала ответ сервера, потом перерисовка — «нарисовалось, но не сохранилось» в
// сетке из тридцати одной колонки глазами не поймать (dialog.md, Н17).
// Поповер при этом закрывается СРАЗУ, не дожидаясь ответа, иначе клик читается
// как «не нажалось».

import { saveScheduleDay, clearScheduleDay } from './storage.js';
import { showToast } from './toast.js';
import {
    getEmployee, getDay, setDayLocal, deleteDayLocal, renderSchedule,
    hasShiftTime, outOfEmployment, isDayPending, markDayPending, clearDayPending,
    getScheduleState
} from './scheduleView.js';
import { formatRangeSpaced, formatDayGenitive, weekdayShort, shortName, dayOf } from './scheduleTime.js';

let pop;
let popMain;
let popExtra;
let optShift;
let optShiftText;
let extraFrom;
let extraTo;
let target = null;   // { employeeId, day }

const STATE_TOASTS = {
    day_off: 'выходной',
    vacation: 'отпуск',
    sick: 'больничный'
};

function closePop() {
    pop.hidden = true;
    popMain.hidden = false;
    popExtra.hidden = true;
    target = null;
}

function positionPop(button) {
    const rect = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const x = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    let y = rect.bottom + 6;
    if (y + height > window.innerHeight - 8) y = Math.max(8, rect.top - height - 6);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
}

function openPop(button) {
    const employeeId = Number(button.dataset.emp);
    const day = button.dataset.day;
    const employee = getEmployee(employeeId);
    if (!employee) return;

    target = { employeeId, day };
    const month = getScheduleState().month;
    document.getElementById('cellPopTitle').textContent =
        `${weekdayShort(month, dayOf(day))}, ${formatDayGenitive(month, dayOf(day))} — ${shortName(employee)}`;

    // Пункт «Смена» без времени в карточке остаётся видимым, но неактивным:
    // пропавший пункт читается как поломка, неактивный объясняет сам себя.
    if (hasShiftTime(employee)) {
        optShift.classList.remove('off');
        optShiftText.textContent = `Смена ${formatRangeSpaced(employee.shiftStart, employee.shiftEnd)}`;
    } else {
        optShift.classList.add('off');
        optShiftText.innerHTML = 'Смена<span class="sub">время не указано в карточке</span>';
    }

    popMain.hidden = false;
    popExtra.hidden = true;
    pop.hidden = false;
    positionPop(button);
}

async function applyDay(employeeId, day, payload, toastText) {
    if (isDayPending(employeeId, day)) return;
    markDayPending(employeeId, day);
    renderSchedule();
    try {
        const saved = await saveScheduleDay({ employeeId, day, ...payload });
        setDayLocal(saved);
        clearDayPending(employeeId, day);
        renderSchedule();
        showToast(toastText, 'success');
    } catch (err) {
        clearDayPending(employeeId, day);
        renderSchedule();
        showToast(err.message, 'error');
    }
}

async function clearDay(employeeId, day, toastText) {
    if (isDayPending(employeeId, day)) return;
    markDayPending(employeeId, day);
    renderSchedule();
    try {
        await clearScheduleDay(employeeId, day);
        deleteDayLocal(employeeId, day);
        clearDayPending(employeeId, day);
        renderSchedule();
        showToast(toastText, 'success');
    } catch (err) {
        clearDayPending(employeeId, day);
        renderSchedule();
        showToast(err.message, 'error');
    }
}

function handleOption(option) {
    if (!target || option.classList.contains('off')) return;
    const { employeeId, day } = target;
    const employee = getEmployee(employeeId);
    if (!employee) return;
    const month = getScheduleState().month;
    const date = formatDayGenitive(month, dayOf(day));
    const name = shortName(employee);
    const action = option.dataset.set;

    if (action === 'extra') {
        // Второй шаг внутри того же поповера: отдельная модалка ради двух полей
        // тяжела для действия, которое делают на бегу.
        const existing = getDay(employeeId, day);
        extraFrom.value = existing && existing.state === 'shift' ? existing.shiftStart : '';
        extraTo.value = existing && existing.state === 'shift' ? existing.shiftEnd : '';
        popMain.hidden = true;
        popExtra.hidden = false;
        extraFrom.focus();
        return;
    }

    closePop();

    if (action === 'clear') {
        clearDay(employeeId, day, `${name}: ${date} — ячейка очищена`);
        return;
    }
    if (action === 'shift') {
        applyDay(employeeId, day, {
            state: 'shift',
            shiftStart: employee.shiftStart,
            shiftEnd: employee.shiftEnd,
            isExtra: false
        }, `${name}: ${date} — смена ${formatRangeSpaced(employee.shiftStart, employee.shiftEnd)}`);
        return;
    }
    applyDay(employeeId, day, { state: action }, `${name}: ${date} — ${STATE_TOASTS[action]}`);
}

function handleExtraApply() {
    if (!target) return;
    const from = extraFrom.value;
    const to = extraTo.value;
    if (!from || !to) {
        showToast('Укажите начало и конец доп. смены', 'error');
        return;
    }
    if (from === to) {
        showToast('Начало и конец доп. смены совпадают', 'error');
        return;
    }
    const { employeeId, day } = target;
    const employee = getEmployee(employeeId);
    const month = getScheduleState().month;
    const date = formatDayGenitive(month, dayOf(day));
    const name = shortName(employee);
    closePop();
    // is_extra хранится, но в интерфейсе не показывается: доп. смена выглядит
    // ровно как обычная (решение владельца). Признак нельзя восстановить задним
    // числом, поэтому пишем его в момент постановки.
    applyDay(employeeId, day, {
        state: 'shift',
        shiftStart: from,
        shiftEnd: to,
        isExtra: true
    }, `${name}: ${date} — доп. смена ${formatRangeSpaced(from, to)}`);
}

export function initScheduleDayMenu() {
    pop = document.getElementById('cellPop');
    popMain = document.getElementById('popMain');
    popExtra = document.getElementById('popExtra');
    optShift = document.getElementById('optShift');
    optShiftText = document.getElementById('optShiftText');
    extraFrom = document.getElementById('extraFrom');
    extraTo = document.getElementById('extraTo');

    document.getElementById('schedBody').addEventListener('click', (e) => {
        const button = e.target.closest('.cellbtn');
        if (!button) return;
        const employee = getEmployee(button.dataset.emp);
        // Дни до найма и после увольнения меню не открывают.
        if (!employee || outOfEmployment(employee, button.dataset.day)) return;
        if (isDayPending(employee.id, button.dataset.day)) return;
        openPop(button);
        e.stopPropagation();
    });

    popMain.addEventListener('click', (e) => {
        const option = e.target.closest('.cell-pop-opt');
        if (!option) return;
        handleOption(option);
        e.stopPropagation();
    });

    document.getElementById('extraBack').addEventListener('click', () => {
        popMain.hidden = false;
        popExtra.hidden = true;
    });
    document.getElementById('extraApply').addEventListener('click', handleExtraApply);

    document.addEventListener('click', (e) => {
        if (!pop.hidden && !pop.contains(e.target)) closePop();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || pop.hidden) return;
        // Esc на втором шаге сначала возвращает на первый.
        if (!popExtra.hidden) {
            popMain.hidden = false;
            popExtra.hidden = true;
            return;
        }
        closePop();
    });
    window.addEventListener('resize', () => { if (!pop.hidden) closePop(); });
}
