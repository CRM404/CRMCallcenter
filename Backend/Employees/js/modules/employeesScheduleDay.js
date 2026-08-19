// --- employeesScheduleDay.js: поповер дня и второй шаг «Доп. смена» ---
//
// Каждое изменение мгновенное, без подтверждения. Оптимистичной отрисовки нет:
// сначала ответ сервера, потом перерисовка — «нарисовалось, но не сохранилось»
// в сетке из тридцати одной колонки глазами не поймать (dialog.md, Н17).
// Поповер при этом закрывается СРАЗУ, не дожидаясь ответа, иначе клик читается
// как «не нажалось».
//
// Переименован из scheduleDayMenu.js и переведён на фабрику. Слушатели на
// документе и на окне теперь снимаются при закрытии панели: раньше они
// копились с каждым открытием раздела.

import { formatRangeSpaced, formatDayGenitive, weekdayShort, shortName, dayOf } from './employeesScheduleTime.js';

const STATE_TOASTS = {
    day_off: 'выходной',
    vacation: 'отпуск',
    sick: 'больничный'
};

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, isAlive, isAbort, schedule }
 */
export function createScheduleDay(root, deps) {
    const { storage, toast, isAlive, isAbort, schedule } = deps;

    const $ = (sel) => root.querySelector(sel);
    const pop = $('[data-role="cell-pop"]');
    const popMain = $('[data-role="pop-main"]');
    const popExtra = $('[data-role="pop-extra"]');

    let target = null;   // { employeeId, day }
    let onDocClick = null;
    let onDocKeydown = null;
    let onWinResize = null;

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
        const employee = schedule.getEmployee(employeeId);
        if (!employee) return;

        target = { employeeId, day };
        const month = schedule.getState().month;
        $('[data-role="cell-pop-title"]').textContent =
            `${weekdayShort(month, dayOf(day))}, ${formatDayGenitive(month, dayOf(day))} — ${shortName(employee)}`;

        // Пункт «Смена» без времени в карточке остаётся видимым, но неактивным:
        // пропавший пункт читается как поломка, неактивный объясняет сам себя.
        const optShift = $('[data-role="opt-shift"]');
        const optShiftText = $('[data-role="opt-shift-text"]');
        if (schedule.hasShiftTime(employee)) {
            optShift.classList.remove('ui-popover__option--off');
            optShiftText.textContent = `Смена ${formatRangeSpaced(employee.shiftStart, employee.shiftEnd)}`;
        } else {
            optShift.classList.add('ui-popover__option--off');
            optShiftText.textContent = 'Смена';
            const sub = document.createElement('span');
            sub.className = 'ui-popover__option-sub';
            sub.textContent = 'время не указано в карточке';
            optShiftText.appendChild(sub);
        }

        popMain.hidden = false;
        popExtra.hidden = true;
        pop.hidden = false;
        positionPop(button);
    }

    async function applyDay(employeeId, day, payload, toastText) {
        if (schedule.isDayPending(employeeId, day)) return;
        schedule.markDayPending(employeeId, day);
        schedule.render();
        try {
            const saved = await storage.saveScheduleDay({ employeeId, day, ...payload });
            if (!isAlive()) return;
            schedule.setDayLocal(saved);
            schedule.clearDayPending(employeeId, day);
            schedule.render();
            toast(toastText, 'success');
        } catch (err) {
            if (!isAlive()) return;
            schedule.clearDayPending(employeeId, day);
            schedule.render();
            if (!isAbort(err)) toast(err.message, 'error');
        }
    }

    async function clearDay(employeeId, day, toastText) {
        if (schedule.isDayPending(employeeId, day)) return;
        schedule.markDayPending(employeeId, day);
        schedule.render();
        try {
            await storage.clearScheduleDay(employeeId, day);
            if (!isAlive()) return;
            schedule.deleteDayLocal(employeeId, day);
            schedule.clearDayPending(employeeId, day);
            schedule.render();
            toast(toastText, 'success');
        } catch (err) {
            if (!isAlive()) return;
            schedule.clearDayPending(employeeId, day);
            schedule.render();
            if (!isAbort(err)) toast(err.message, 'error');
        }
    }

    function handleOption(option) {
        if (!target || option.classList.contains('ui-popover__option--off')) return;
        const { employeeId, day } = target;
        const employee = schedule.getEmployee(employeeId);
        if (!employee) return;
        const month = schedule.getState().month;
        const date = formatDayGenitive(month, dayOf(day));
        const name = shortName(employee);
        const action = option.dataset.set;

        if (action === 'extra') {
            // Второй шаг внутри того же поповера: отдельное окно ради двух полей
            // тяжело для действия, которое делают на бегу.
            const existing = schedule.getDay(employeeId, day);
            $('[data-role="extra-from"]').value = existing && existing.state === 'shift' ? existing.shiftStart : '';
            $('[data-role="extra-to"]').value = existing && existing.state === 'shift' ? existing.shiftEnd : '';
            popMain.hidden = true;
            popExtra.hidden = false;
            $('[data-role="extra-from"]').focus();
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
        const from = $('[data-role="extra-from"]').value;
        const to = $('[data-role="extra-to"]').value;
        if (!from || !to) {
            toast('Укажите начало и конец доп. смены', 'error');
            return;
        }
        if (from === to) {
            toast('Начало и конец доп. смены совпадают', 'error');
            return;
        }
        const { employeeId, day } = target;
        const employee = schedule.getEmployee(employeeId);
        const month = schedule.getState().month;
        const date = formatDayGenitive(month, dayOf(day));
        const name = shortName(employee);
        closePop();
        // is_extra хранится, но в интерфейсе не показывается: доп. смена
        // выглядит ровно как обычная (решение владельца). Признак нельзя
        // восстановить задним числом, поэтому пишем его в момент постановки.
        applyDay(employeeId, day, {
            state: 'shift',
            shiftStart: from,
            shiftEnd: to,
            isExtra: true
        }, `${name}: ${date} — доп. смена ${formatRangeSpaced(from, to)}`);
    }

    function init() {
        $('[data-role="sched-body"]').addEventListener('click', (e) => {
            const button = e.target.closest('.cellbtn');
            if (!button) return;
            const employee = schedule.getEmployee(button.dataset.emp);
            // Дни до найма и после увольнения меню не открывают.
            if (!employee || schedule.outOfEmployment(employee, button.dataset.day)) return;
            if (schedule.isDayPending(employee.id, button.dataset.day)) return;
            openPop(button);
            e.stopPropagation();
        });

        popMain.addEventListener('click', (e) => {
            const option = e.target.closest('.ui-popover__option');
            if (!option) return;
            handleOption(option);
            e.stopPropagation();
        });

        $('[data-role="extra-back"]').addEventListener('click', () => {
            popMain.hidden = false;
            popExtra.hidden = true;
        });
        $('[data-role="extra-apply"]').addEventListener('click', handleExtraApply);

        onDocClick = (e) => { if (!pop.hidden && !pop.contains(e.target)) closePop(); };
        onDocKeydown = (e) => {
            if (e.key !== 'Escape' || pop.hidden) return;
            // Esc на втором шаге сначала возвращает на первый.
            if (!popExtra.hidden) {
                popMain.hidden = false;
                popExtra.hidden = true;
                return;
            }
            closePop();
        };
        onWinResize = () => { if (!pop.hidden) closePop(); };

        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onDocKeydown);
        window.addEventListener('resize', onWinResize);
    }

    return {
        init,
        isOpen: () => !pop.hidden,
        close: closePop,
        destroy() {
            if (onDocClick) document.removeEventListener('click', onDocClick);
            if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown);
            if (onWinResize) window.removeEventListener('resize', onWinResize);
            onDocClick = null;
            onDocKeydown = null;
            onWinResize = null;
        }
    };
}
