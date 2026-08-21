// --- employeesScheduleFill.js: окно «Добавить график» ---
//
// Правило заполнения (третья, действующая редакция): от выбранной даты до конца
// ОТКРЫТОГО месяца; отмеченный день → выходной, любой другой → смена с временем
// из карточки; дни вне периода работы пропускаются; всё прежнее затирается,
// включая отпуск и больничный. Шаблон «5/2» в расчёте не участвует ни в каком
// виде — выходные называет человек, они плавающие.
//
// Переименован из scheduleFillModal.js и переведён на фабрику: набор отметок и
// счётчик снятых лежали в переменных уровня модуля, то есть переживали закрытие
// панели и всплывали в следующем открытии.

import { openModal } from '/ui/modal.js';
import {
    daysInMonth, dayKey, dayOf, monthKeyOf, monthLabel, monthGenitive,
    formatRangeSpaced, formatDayGenitive, plural, pluralDays, shortName
} from './employeesScheduleTime.js';

const WEEK_DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, isAlive, isAbort, schedule }
 */
export function createScheduleFill(root, deps) {
    const { storage, toast, isAlive, isAbort, schedule } = deps;

    const $ = (sel) => root.querySelector(sel);
    const tpl = $('[data-role="fill-tpl"]');

    // Окно собирает слой (К110, К111) — узлы полей существуют, только пока оно
    // открыто, и берутся заново на каждое открытие.
    let modal = null;
    let empSelect = null;
    let fromInput = null;
    let wkPanel = null;
    let wkGrid = null;
    const applyBtn = () => $('[data-role="fill-apply"]');

    // Выходные, отмеченные администратором для ЭТОГО заполнения. Система их не
    // вычисляет и нигде не хранит.
    const picked = new Set();
    let submitting = false;
    // Сколько отметок снято сдвигом даты. Копится между пересчётами и обнуляется
    // только осмысленным действием пользователя: поле даты выдаёт input и change
    // подряд, и счётчик «за один пересчёт» стирался бы вторым же вызовом — то
    // есть сообщение мелькало бы и исчезало.
    let dropped = 0;

    function selectedEmployee() {
        return schedule.getEmployee(empSelect.value);
    }

    // Первый день диапазона. Значение поля ограничено месяцем и на уровне
    // min/max, и здесь: поле доступно клавиатуре, и туда можно вписать что угодно.
    function fromDayNumber() {
        const month = schedule.getState().month;
        const value = fromInput.value;
        if (!value || monthKeyOf(value) !== month) return 1;
        const day = dayOf(value);
        return day >= 1 && day <= daysInMonth(month) ? day : 1;
    }

    // День недоступен для отметки, если он раньше даты заполнения или вне
    // периода работы сотрудника.
    function dayLocked(employee, day) {
        if (day < fromDayNumber()) return true;
        return Boolean(schedule.outOfEmployment(employee, dayKey(schedule.getState().month, day)));
    }

    function renderCalendar(employee) {
        const month = schedule.getState().month;
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
        $('[data-role="wk-clear"]').disabled = picked.size === 0;
    }

    function summaryText() {
        const month = schedule.getState().month;
        const list = [...picked].sort((a, b) => a - b);
        if (list.length === 0) {
            return { text: 'Не отмечены — смены встанут на все дни подряд', none: true };
        }
        const shown = list.slice(0, 6).join(', ');
        const tail = list.length > 6 ? ` и ещё ${list.length - 6}` : '';
        // Месяц стоит ПЕРЕД перечислением, а не в конце: «…и ещё 2 августа»
        // читается как «и ещё 2-е августа», то есть как дата, а не как счёт.
        return { text: `${list.length} ${pluralDays(list.length)} ${monthGenitive(month)}: ${shown}${tail}`, none: false };
    }

    // Пересчитывается на каждое действие в форме. Числа считаются по тем же
    // правилам, что и на сервере, — иначе предпросмотр обещал бы одно, а
    // заполнение делало другое.
    function syncFill() {
        if (!modal) return;
        const employee = selectedEmployee();
        const month = schedule.getState().month;
        const box = $('[data-role="fill-emp-schedule"]');
        if (!employee) {
            applyBtn().disabled = true;
            return;
        }

        const ready = schedule.hasShiftTime(employee);
        box.classList.toggle('bad', !ready);
        $('[data-role="fill-emp-time"]').textContent = ready
            ? formatRangeSpaced(employee.shiftStart, employee.shiftEnd)
            : 'не заполнено в карточке сотрудника — заполните его там, тогда месяц можно будет проставить разом';

        // Режим — отдельной строкой без плашки: он справочный и на заполнение
        // не влияет. Собирается узлами, а не innerHTML: workSchedule —
        // единственное значение здесь, которое вводит человек.
        const daysBox = $('[data-role="fill-emp-days"]');
        daysBox.textContent = employee.workSchedule ? `${employee.workSchedule} ` : '';
        const daysNote = document.createElement('i');
        daysNote.textContent = employee.workSchedule ? '— справочно, выходные отмечаете вы' : 'не указан';
        daysBox.appendChild(daysNote);
        applyBtn().disabled = !ready || submitting;

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
        const summaryEl = $('[data-role="wk-summary"]');
        summaryEl.textContent = summary.text;
        summaryEl.classList.toggle('none', summary.none);

        const previewEl = $('[data-role="fill-preview-text"]');
        const warnBox = $('[data-role="fill-warn"]');
        if (!ready) {
            previewEl.textContent = 'Заполнение недоступно, пока в карточке сотрудника не указано время смены.';
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
            if (schedule.outOfEmployment(employee, key)) continue;
            if (picked.has(d)) daysOff++; else shifts++;
            const existing = schedule.getDay(employee.id, key);
            if (existing && existing.state === 'vacation') vacation++;
            if (existing && existing.state === 'sick') sick++;
        }

        // Числительные склоняются (К117): при одной смене строка обещала
        // «1 смен», при одном выходном — «1 выходных».
        previewEl.innerHTML =
            `Заполнит <b>${from}–${last} ${monthGenitive(month)}</b>: <b>${shifts}</b> ${plural(shifts, 'смена', 'смены', 'смен')} по <b>${formatRangeSpaced(employee.shiftStart, employee.shiftEnd)}</b>`
            + (daysOff ? ` и <b>${daysOff}</b> ${plural(daysOff, 'выходной', 'выходных', 'выходных')} по вашим отметкам` : ' — выходные не отмечены')
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

    function closeFill() {
        if (modal) modal.close(false);
    }

    function openFill() {
        if (modal) return;
        const state = schedule.getState();
        if (!state.month) return;
        if (state.employees.length === 0) {
            toast('Нет активных сотрудников — график заполнять некому', 'error');
            return;
        }

        const body = document.createElement('div');
        body.appendChild(tpl.content.cloneNode(true));
        empSelect = body.querySelector('#empFillEmployee');
        fromInput = body.querySelector('#empFillFrom');
        wkPanel = body.querySelector('[data-role="wk-panel"]');
        wkGrid = body.querySelector('[data-role="wk-grid"]');

        modal = openModal({
            title: 'Добавить график',
            body,
            scope: root,
            actions: [
                { label: 'Отмена', variant: 'ghost', role: 'fill-cancel', value: false },
                { label: 'Заполнить', role: 'fill-apply', onClick: () => handleApply() }
            ]
        });
        modal.result.then(() => {
            modal = null;
            empSelect = null;
            fromInput = null;
            wkPanel = null;
            wkGrid = null;
        });

        bindFormEvents(body);

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
        $('[data-role="wk-field"]').setAttribute('aria-expanded', 'false');
        $('[data-role="wk-month"]').textContent = monthLabel(state.month);
        syncFill();

        // Фокус — в первое поле окна, а не на крестик (К110).
        empSelect.focus();
    }

    async function handleApply() {
        const employee = selectedEmployee();
        // false — окно остаётся открытым: слой понимает это как «не удалось».
        if (!employee || !schedule.hasShiftTime(employee) || submitting) return false;
        const month = schedule.getState().month;
        const from = fromDayNumber();
        const fromDate = dayKey(month, from);
        const dayOffDates = [...picked].sort((a, b) => a - b).map((d) => dayKey(month, d));

        submitting = true;
        let result;
        try {
            result = await storage.fillSchedule({ employeeId: employee.id, fromDate, dayOffDates });
            if (!isAlive()) return false;
        } catch (err) {
            submitting = false;
            if (!isAlive() || isAbort(err)) return false;
            toast(err.message, 'error');
            return false;
        }
        submitting = false;
        closeFill();
        // Числа в тосте — из ответа сервера: только он знает, сколько строк
        // реально записано после пропуска дней вне периода работы.
        await schedule.loadMonth(month);
        if (!isAlive()) return true;
        toast(
            `${shortName(employee)}: с ${formatDayGenitive(month, from)} проставлено ${result.shifts} ${plural(result.shifts, 'смена', 'смены', 'смен')} и ${result.daysOff} ${plural(result.daysOff, 'выходной', 'выходных', 'выходных')}`,
            'success'
        );
        return true;
    }

    function init() {
        $('[data-role="sched-fill"]').addEventListener('click', openFill);
    }

    /** Подписки на поля окна — они клонируются на каждое открытие. */
    function bindFormEvents(form) {
        // Смена сотрудника — новые границы найма, прежний счётчик снятых отметок
        // к ним отношения не имеет.
        empSelect.addEventListener('change', () => { dropped = 0; syncFill(); });
        fromInput.addEventListener('change', syncFill);
        fromInput.addEventListener('input', syncFill);

        // Календарь раскрывается прямо под полем, а не вторым шагом: какие дни
        // отмечать, зависит от того, с какого числа идёт заполнение, — эту связь
        // второй шаг разрывает.
        const wkField = form.querySelector('[data-role="wk-field"]');
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
        form.querySelector('[data-role="wk-clear"]')
            .addEventListener('click', () => { picked.clear(); dropped = 0; syncFill(); });
    }

    return {
        init,
        isOpen: () => modal !== null,
        // Слушателей документа у окна больше нет: Esc и щелчок мимо окна —
        // работа слоя.
        destroy() {}
    };
}
