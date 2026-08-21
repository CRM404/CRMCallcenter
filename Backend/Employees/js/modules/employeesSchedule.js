// --- employeesSchedule.js: режим «График» — сетка, «Итого», подвал, счётчики ---
//
// Зона ответственности: состояние экрана (месяц, сотрудники, дни), отрисовка
// таблицы и шапки, тулбар и переключатель режима. Поповер дня и окно заполнения
// живут в своих модулях и обращаются сюда за состоянием.
//
// Режим «Список» этот модуль не трогает: график рисуется в свой контейнер,
// переключение — показ/скрытие.
//
// Переименован из scheduleView.js и переведён на фабрику. Раньше состояние
// месяца, сотрудников и дней лежало в переменной уровня модуля — то есть было
// одно на всё приложение. Панель закрывали и открывали заново, а состояние
// оставалось от прошлого раза.

import {
    shiftMinutes, formatHours, formatRangeCompact, formatRangeSpaced,
    daysInMonth, dayKey, monthKeyOf, shiftMonth, weekdayShort, isWeekend,
    monthLabel, monthLabelLower, formatDayGenitive, formatDateGenitive,
    shortName, fullName, initialsOf
} from './employeesScheduleTime.js';

function escapeHtml(value) {
    if (value === null || value === undefined || value === '') return '';
    return String(value).replace(/[&<>"]/g, (m) => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return m;
    });
}

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, isAlive, isAbort, onModeChange }
 */
export function createSchedule(root, deps) {
    const { storage, toast, isAlive, isAbort, onModeChange } = deps;

    const $ = (sel) => root.querySelector(sel);

    // Единственный источник правды для режима. today приходит с сервера в поясе
    // приложения: «сегодня» на этом экране — это подсветка колонки, четыре
    // счётчика и дата по умолчанию в окне заполнения, и часы браузера тут ни
    // при чём (dialog.md, Б3).
    const state = {
        month: null,
        today: null,
        employees: [],
        days: new Map(),      // employeeId -> Map(dayKey -> day)
        departments: [],
        loaded: false
    };

    // Месяц, который сейчас грузится, и номер запроса. Переключатели считают
    // от него, а не от state.month: тот обновляется только после ответа, и два
    // быстрых щелчка «вперёд» оба просили бы один и тот же месяц.
    let pendingMonth = null;
    let monthRequest = 0;

    // Клики по ячейке, на которые ещё не пришёл ответ. Оптимистичной отрисовки
    // нет, поэтому повторный клик до ответа обязан игнорироваться — иначе
    // двойной клик уходит двумя запросами (dialog.md, Н17).
    const pending = new Set();

    const api = {
        getState: () => state,
        isDayPending: (employeeId, day) => pending.has(`${employeeId}:${day}`),
        markDayPending: (employeeId, day) => pending.add(`${employeeId}:${day}`),
        clearDayPending: (employeeId, day) => pending.delete(`${employeeId}:${day}`),
        getEmployee: (employeeId) => state.employees.find((emp) => emp.id === Number(employeeId)) || null,
        getDay(employeeId, day) {
            const byDay = state.days.get(Number(employeeId));
            return byDay ? byDay.get(day) || null : null;
        },
        setDayLocal(day) {
            const employeeId = Number(day.employeeId);
            if (!state.days.has(employeeId)) state.days.set(employeeId, new Map());
            state.days.get(employeeId).set(day.day, day);
        },
        deleteDayLocal(employeeId, day) {
            const byDay = state.days.get(Number(employeeId));
            if (byDay) byDay.delete(day);
        },
        // Единственное условие доступности заполнения и пункта «Смена».
        // Поле «Дни» на это не влияет.
        hasShiftTime: (employee) => Boolean(employee && employee.shiftStart && employee.shiftEnd),
        // Дни до приёма на работу и после увольнения не редактируются:
        // заполнение их пропускает, клик по ним ничего не открывает.
        outOfEmployment(employee, day) {
            if (employee.hireDate && day < employee.hireDate) return 'hire';
            if (employee.terminationDate && day > employee.terminationDate) return 'termination';
            return null;
        },
        visibleEmployees,
        render: renderSchedule,
        loadMonth
    };

    // Поиск и фильтр отдела — на клиенте по уже загруженному месяцу: строк
    // десятки, гонять запрос на каждую букву незачем.
    function visibleEmployees() {
        const query = ($('[data-role="sched-search"]').value || '').trim().toLowerCase();
        const dept = $('[data-role="sched-dept"]').value || '';
        return state.employees.filter((emp) => {
            const matchesQuery = !query || fullName(emp).toLowerCase().includes(query);
            // Отдел сравнивается по точному совпадению названия из справочника с
            // текстом в карточке: FK между ними нет (известный гэп, бриф п.8).
            const matchesDept = !dept || emp.department === dept;
            return matchesQuery && matchesDept;
        });
    }

    // ------------------------------------------------------------ ячейки

    function cellStateOf(employee, day) {
        const outOf = api.outOfEmployment(employee, day);
        if (outOf) return { state: 'none', reason: outOf };
        const existing = api.getDay(employee.id, day);
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
        // неразличимыми ровно там, где различие и нужно.
        if (cell.state === 'none') {
            return cell.reason === 'termination' ? `${date} — после даты увольнения` : `${date} — до даты найма`;
        }
        return `${date} — не заполнено`;
    }

    // ------------------------------------------------------------ отрисовка

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
        $('[data-role="sched-head"]').innerHTML = html;
    }

    // gaps — какие границы занятости реально видны в открытом месяце. Считаются
    // в том же проходе по дням, что и сами ячейки, поэтому метка не может
    // разойтись с тем, что нарисовано в строке.
    function renderEmployeeCell(employee, gaps) {
        const parts = [escapeHtml(employee.lineType || '')];
        if (api.hasShiftTime(employee)) {
            parts.push(`<span class="tpl-tag">${escapeHtml(formatRangeCompact(employee.shiftStart, employee.shiftEnd))}</span>`);
            if (employee.workSchedule) {
                parts.push(`<span class="tpl-mode" title="режим сотрудника — справочно">${escapeHtml(employee.workSchedule)}</span>`);
            }
        } else {
            parts.push('<span class="tpl-tag empty" title="Время смены не указано в карточке сотрудника">без времени смены</span>');
        }
        // Метка стоит в ЛЮБОМ месяце, где есть дни вне периода работы, а не
        // только в месяце самой даты: иначе строка из сплошных бледных точек
        // остаётся без единого объяснения и читается как поломка.
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
                const busy = api.isDayPending(employee.id, key) ? ' pending' : '';
                cells += `<td class="${tdClasses.join(' ')}"><button type="button" class="cellbtn st-${cell.state}${busy}" data-emp="${employee.id}" data-day="${key}" title="${escapeHtml(cellTitle(cell, d))}"${disabled}>${cellInner(cell)}</button></td>`;
            }
            // «Итого» при отсутствии смен — прочерк, а не «0 ч».
            html += `<tr data-emp="${employee.id}">
                <td class="col-emp">${renderEmployeeCell(employee, gaps)}</td>
                ${cells}
                <td class="col-total"><div class="total-main">${shifts} см.</div><div class="total-sub">${minutes ? formatHours(minutes) : '—'}</div></td>
            </tr>`;
        });
        $('[data-role="sched-body"]').innerHTML = html;
    }

    function renderFoot() {
        const total = daysInMonth(state.month);
        const visible = visibleEmployees();
        let html = '<th class="col-emp">В смене</th>';
        for (let d = 1; d <= total; d++) {
            const key = dayKey(state.month, d);
            let count = 0;
            visible.forEach((employee) => {
                if (cellStateOf(employee, key).state === 'shift') count++;
            });
            const classes = ['day'];
            if (isWeekend(state.month, d)) classes.push('wend');
            if (state.today === key) classes.push('today');
            if (!count) classes.push('zero');
            html += `<td class="${classes.join(' ')}">${count}</td>`;
        }
        html += '<td class="col-total"></td>';
        $('[data-role="sched-foot"]').innerHTML = html;
    }

    // Счётчики шапки — по колонке сегодняшнего дня и по ВИДИМЫМ строкам: иначе
    // цифры спорят с таблицей под ними.
    function renderChips() {
        const chips = { shift: 'chip-shift', day_off: 'chip-off', vacation: 'chip-vac', sick: 'chip-sick' };
        const boxes = Array.from($('[data-role="sched-chips"]').querySelectorAll('.ui-chip'));
        const todayInMonth = state.today && monthKeyOf(state.today) === state.month;

        if (!todayInMonth) {
            // Другой месяц (или дата с сервера не пришла) — «—», а не нули: ноль
            // это утверждение «никто не в смене», и оно хуже честного прочерка.
            Object.values(chips).forEach((role) => { $(`[data-role="${role}"]`).textContent = '—'; });
            boxes.forEach((box) => box.classList.add('muted'));
            return;
        }
        boxes.forEach((box) => box.classList.remove('muted'));

        const counts = { shift: 0, day_off: 0, vacation: 0, sick: 0 };
        visibleEmployees().forEach((employee) => {
            const cell = cellStateOf(employee, state.today);
            if (counts[cell.state] !== undefined) counts[cell.state]++;
        });
        Object.entries(chips).forEach(([key, role]) => {
            $(`[data-role="${role}"]`).textContent = String(counts[key]);
        });
    }

    function renderEmptyNote() {
        let filled = false;
        state.days.forEach((byDay) => { if (byDay.size > 0) filled = true; });
        $('[data-role="sched-empty-note"]').hidden = filled;
        $('[data-role="sched-empty-title"]').textContent = `График на ${monthLabelLower(state.month)} ещё не составлен`;
    }

    // Перерисовка без похода на сервер: после правки одной ячейки состояние уже
    // обновлено локально ответом эндпоинта.
    function renderSchedule() {
        if (!state.month) return;
        renderBody();
        renderFoot();
        renderChips();
        renderEmptyNote();
    }

    function renderMonth() {
        $('[data-role="sched-month"]').textContent = monthLabel(state.month);
        renderHead();
        renderSchedule();
    }

    // ------------------------------------------------------------ данные

    async function loadMonth(month) {
        const my = ++monthRequest;
        pendingMonth = month || null;
        let data;
        try {
            data = await storage.fetchSchedule(month);
            if (!isAlive()) return false;
        } catch (err) {
            if (my === monthRequest) pendingMonth = null;
            if (!isAlive() || isAbort(err)) return false;
            toast(err.message, 'error');
            return false;
        }
        // Пока грузили этот месяц, попросили другой — ответ уже не нужен:
        // нарисованный поверх нового, он показал бы чужие данные под чужой
        // подписью.
        if (my !== monthRequest) return false;
        pendingMonth = null;
        state.month = data.month;
        state.today = data.today || null;
        state.employees = data.employees || [];
        state.days = new Map();
        (data.days || []).forEach((day) => api.setDayLocal(day));
        state.loaded = true;
        renderMonth();
        return true;
    }

    // Справочник отделов — отдельным запросом: в контракте графика его нет, а
    // эндпоинт уже есть. Дубли названий схлопываем (UNIQUE у departments.name
    // нет), пустой справочник рисуем как в макете.
    async function loadDepartments() {
        let departments = [];
        try {
            departments = await storage.fetchDepartments();
            if (!isAlive()) return;
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
        }
        state.departments = [...new Set(departments.map((d) => d.name).filter(Boolean))];

        const select = $('[data-role="sched-dept"]');
        select.innerHTML = '';
        if (state.departments.length === 0) {
            select.disabled = true;
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Отделы не заведены';
            select.appendChild(option);
            return;
        }
        select.disabled = false;
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'Все отделы';
        select.appendChild(all);
        state.departments.forEach((name) => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
    }

    function scrollToToday() {
        const th = $('[data-role="sched-head"] th.day.today');
        if (th) th.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // ------------------------------------------------------------ режим

    function setMode(mode) {
        const isSchedule = mode === 'schedule';
        $('[data-role="list-section"]').hidden = isSchedule;
        $('[data-role="schedule-section"]').hidden = !isSchedule;
        $('[data-role="list-chips"]').hidden = isSchedule;
        $('[data-role="sched-chips"]').hidden = !isSchedule;
        // Кнопки шапки принадлежат «Списку» целиком (К115). Раньше пряталась
        // только «Добавить сотрудника», а «Отделы», «Фильтры» и «Колонки»
        // оставались: окно колонок настраивало таблицу, которой на экране нет,
        // а отбор, применённый прямо из графика, не менял в сетке ни строки —
        // и при этом зажигал счётчик на кнопке.
        $('[data-role="list-acts"]').hidden = isSchedule;
        $('[data-role="view-list"]').classList.toggle('ui-switch__option--active', !isSchedule);
        $('[data-role="view-schedule"]').classList.toggle('ui-switch__option--active', isSchedule);
        $('[data-role="view-list"]').setAttribute('aria-selected', String(!isSchedule));
        $('[data-role="view-schedule"]').setAttribute('aria-selected', String(isSchedule));
        if (onModeChange) onModeChange(mode);
    }

    function init() {
        $('[data-role="view-list"]').addEventListener('click', () => setMode('list'));
        // Данные графика грузятся лениво — при первом переключении, а не при
        // каждом открытии раздела.
        $('[data-role="view-schedule"]').addEventListener('click', async () => {
            setMode('schedule');
            if (state.loaded) return;
            await loadDepartments();
            if (!isAlive()) return;
            // Месяц не передаём: сервер возьмёт текущий по поясу приложения.
            await loadMonth(undefined);
            if (!isAlive()) return;
            scrollToToday();
        });

        // От pendingMonth, если загрузка ещё идёт: иначе второй щелчок
        // отсчитывает от месяца, который на экране, но уже не актуален.
        const currentMonth = () => pendingMonth || state.month;
        $('[data-role="sched-prev"]').addEventListener('click', () => {
            const base = currentMonth();
            if (base) loadMonth(shiftMonth(base, -1));
        });
        $('[data-role="sched-next"]').addEventListener('click', () => {
            const base = currentMonth();
            if (base) loadMonth(shiftMonth(base, 1));
        });
        $('[data-role="sched-today"]').addEventListener('click', async () => {
            if (!state.today) return;
            const todayMonth = monthKeyOf(state.today);
            if (state.month !== todayMonth) {
                const ok = await loadMonth(todayMonth);
                if (!ok || !isAlive()) return;
            }
            scrollToToday();
        });

        $('[data-role="sched-search"]').addEventListener('input', renderSchedule);
        $('[data-role="sched-dept"]').addEventListener('change', renderSchedule);

        setMode('list');
    }

    return { init, setMode, ...api };
}
