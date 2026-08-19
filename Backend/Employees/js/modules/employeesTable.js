// --- employeesTable.js: режим «Список» — таблица, фильтры, сортировка,
// пагинация, выделение и массовые действия ---
//
// Собран из render.js и massActions.js: они и раньше были одним экраном,
// разнесённым по двум файлам через глобальные id и взаимный импорт
// (render → massActions → render).
//
// Таблица строится вокруг составных ячеек «Сотрудник» (аватар + ФИО +
// должность), «Контакты» (телефон + email) и «Мессенджеры» (чипы) — они
// структурные и есть всегда; «Отдел»/«Руководитель»/«Дата найма»/«Статус» и
// далее переключаются целиком. Настройка колонок управляет и тем, и другим:
// внутри составной ячейки — гранулярно, у остальных — колонкой целиком.

import { iconNode } from '/ui/icons.js';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// Колонки, которые могут исчезать целиком. Раньше их <th> искались по семи
// отдельным id; теперь у шапки и у ячеек один общий атрибут data-col.
const STANDALONE_COLUMNS = ['department', 'managerName', 'hireDate', 'status', 'terminationDate', 'lineType', 'workSchedule'];

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

function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : String(dateStr);
}

function createDebounced(fn, ms) {
    let timer = null;
    const call = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    call.cancel = () => clearTimeout(timer);
    return call;
}

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, confirmDanger, isAlive, isAbort,
 *                              getHiddenColumns, onEdit, onDataChanged }
 */
export function createTable(root, deps) {
    const { storage, toast, confirmDanger, isAlive, isAbort, getHiddenColumns, onEdit, onDataChanged } = deps;

    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));

    let sortField = 'id';
    let sortDirection = 'asc';
    let currentPage = 1;
    let rows = [];
    // Отбор, с которым реально сходили на сервер. Поля окна фильтров — это
    // ещё не отбор: их можно заполнить и закрыть окно, не нажимая «Применить».
    let appliedFilters = {};
    let selectedIds = new Set();
    let massApplying = false;
    // Полный список — только для наполнения списков «Отдел» и «Должность» в
    // фильтрах. Раньше он запрашивался ЗАНОВО при каждой перерисовке, то есть
    // на каждую букву в поиске уходило по два запроса вместо одного.
    let allEmployees = [];

    // ------------------------------------------------------------ ячейки

    // Аватаров-кружков с инициалами здесь больше нет (Э4): такого элемента нет
    // ни в макете, ни в каталоге слоя, а раздел своих элементов не заводит.
    // Понадобятся снова — заводятся в слое как вид, а не тут.

    function renderEmployeeCell(emp, hidden) {
        const nameParts = [];
        if (!hidden.has('lastName')) nameParts.push(emp.lastName);
        if (!hidden.has('firstName')) nameParts.push(emp.firstName);
        if (!hidden.has('middleName') && emp.middleName) nameParts.push(emp.middleName);
        const fio = escapeHtml(nameParts.filter(Boolean).join(' '));
        const showPosition = !hidden.has('position') && emp.position;
        return `
            <div class="employee-cell">
                <span class="ui-table__main">${fio}</span>
                ${showPosition ? `<span class="ui-table__sub">${escapeHtml(emp.position)}</span>` : ''}
            </div>`;
    }

    // Скрыт email — остаётся только телефон, и наоборот; скрыты оба — ячейка пустая.
    function renderContactsCell(emp, hidden) {
        const lines = [];
        if (!hidden.has('phone') && emp.phone) {
            lines.push(`<div class="contact-line contact-phone"><svg class="ui-ic ui-ic--sm ui-ic--quiet" aria-hidden="true"><use href="#ui-ic-phone"></use></svg>${escapeHtml(emp.phone)}</div>`);
        }
        if (!hidden.has('email') && emp.email) {
            lines.push(`<div class="contact-line"><svg class="ui-ic ui-ic--sm ui-ic--quiet" aria-hidden="true"><use href="#ui-ic-mail"></use></svg>${escapeHtml(emp.email)}</div>`);
        }
        return `<div class="contact-cell">${lines.join('')}</div>`;
    }

    // Чип не показывается, если поле пустое ИЛИ колонка скрыта; ни одного чипа —
    // прочерк.
    // Метки в палитре проекта, а не фирменные зелёный и голубой (Э5): цвет в
    // таблице означает статус, и чужой бренд в этом языке не участвует.
    function renderMessengersCell(emp, hidden) {
        const marks = [];
        if (!hidden.has('whatsapp') && emp.whatsapp) {
            marks.push('<span class="ui-tag" title="WhatsApp">WA</span>');
        }
        if (!hidden.has('telegram') && emp.telegram) {
            marks.push('<span class="ui-tag" title="Telegram">TG</span>');
        }
        if (marks.length === 0) return '<span class="ui-table__muted">—</span>';
        return `<div class="messenger-cell">${marks.join('')}</div>`;
    }

    // «3/3 · 21:00–23:30»; при одном заполненном — только оно, при пустых прочерк.
    function renderWorkScheduleCell(emp) {
        const parts = [];
        if (emp.workSchedule) parts.push(escapeHtml(emp.workSchedule));
        if (emp.shiftStart && emp.shiftEnd) parts.push(`${escapeHtml(emp.shiftStart)}–${escapeHtml(emp.shiftEnd)}`);
        return parts.length ? parts.join(' · ') : '—';
    }

    function renderManagerCell(emp) {
        if (!emp.managerName) return '<span class="manager-cell manager-empty">—</span>';
        return `<span class="manager-cell"><svg class="ui-ic ui-ic--sm ui-ic--quiet" aria-hidden="true"><use href="#ui-ic-share"></use></svg>${escapeHtml(emp.managerName)}</span>`;
    }

    function renderStatusBadge(emp) {
        const isActive = emp.status === 'active';
        return `<span class="ui-pill ${isActive ? 'ui-pill--ok' : 'ui-pill--mute'}">${isActive ? 'Активен' : 'Неактивен'}</span>`;
    }

    // ------------------------------------------------------------ отрисовка

    function applyColumnVisibility(hidden) {
        STANDALONE_COLUMNS.forEach((key) => {
            $$(`[data-col="${key}"]`).forEach((cell) => { cell.hidden = hidden.has(key); });
        });
    }

    function rowHtml(emp, hidden) {
        const idFormatted = String(emp.id).padStart(4, '0');
        const hiddenAttr = (key) => (hidden.has(key) ? ' hidden' : '');
        const fullName = `${emp.lastName || ''} ${emp.firstName || ''}`.trim();
        const checked = selectedIds.has(emp.id) ? ' checked' : '';
        return `
            <tr data-id="${emp.id}" class="${selectedIds.has(emp.id) ? 'ui-table__row--selected' : ''}">
                <td class="ui-table__sel"><input type="checkbox" data-check-id="${emp.id}" aria-label="Выбрать сотрудника ${idFormatted}"${checked}></td>
                <td>${idFormatted}</td>
                <td>${renderEmployeeCell(emp, hidden)}</td>
                <td data-col="department"${hiddenAttr('department')}>${emp.department ? escapeHtml(emp.department) : '<span class="ui-table__muted">—</span>'}</td>
                <td>${renderContactsCell(emp, hidden)}</td>
                <td>${renderMessengersCell(emp, hidden)}</td>
                <td data-col="managerName"${hiddenAttr('managerName')}>${renderManagerCell(emp)}</td>
                <td data-col="hireDate"${hiddenAttr('hireDate')}>${emp.hireDate ? formatDate(emp.hireDate) : '—'}</td>
                <td data-col="status"${hiddenAttr('status')}>${renderStatusBadge(emp)}</td>
                <td data-col="terminationDate"${hiddenAttr('terminationDate')}>${emp.terminationDate ? formatDate(emp.terminationDate) : '—'}</td>
                <td data-col="lineType"${hiddenAttr('lineType')}>${emp.lineType ? escapeHtml(emp.lineType) : '—'}</td>
                <td data-col="workSchedule"${hiddenAttr('workSchedule')}>${renderWorkScheduleCell(emp)}</td>
                <td class="ui-table__acts">
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-edit="${emp.id}" title="Изменить" aria-label="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-del="${emp.id}" data-name="${escapeHtml(fullName)}" title="Удалить" aria-label="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                </td>
            </tr>`;
    }

    // Подвал: сколько строк ВИДНО на текущей странице из скольких подходящих
    // под фильтр. «Всего: N» отвечал на другой вопрос и не совпадал с тем, что
    // человек видит перед собой (М28).
    function shownRange(totalItems) {
        if (!totalItems) return 'Ничего не найдено';
        const from = (currentPage - 1) * PAGE_SIZE;
        const to = Math.min(from + PAGE_SIZE, totalItems);
        return `Показано ${to - from} из ${totalItems}`;
    }

    function renderPagination(totalItems) {
        const totalPages = Math.ceil(totalItems / PAGE_SIZE) || 1;
        const box = $('[data-role="pagination"]');
        if (totalPages <= 1) {
            box.innerHTML = '';
            $('[data-role="pagination-note"]').textContent = shownRange(totalItems);
            return;
        }
        const maxVisible = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        const endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage + 1 < maxVisible) startPage = Math.max(1, endPage - maxVisible + 1);

        let html = '';
        for (let i = startPage; i <= endPage; i++) {
            html += `<button type="button" class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        }
        box.innerHTML = html;
        $('[data-role="pagination-note"]').textContent =
            `${shownRange(totalItems)} · страница ${currentPage} из ${totalPages}`;
    }

    function renderSortIcons() {
        $$('thead th[data-field]').forEach((th) => {
            const icon = th.querySelector('.sort-icon');
            if (th.dataset.field === sortField) {
                const key = sortDirection === 'asc' ? 'sort-asc' : 'sort-desc';
                if (icon) icon.remove();
                th.appendChild(iconNode(key, 'sm', 'sort-icon'));
            } else if (icon) {
                icon.remove();
            }
        });
    }

    function renderStatChips(list) {
        const total = list.length;
        const active = list.filter((e) => e.status === 'active').length;
        $('[data-role="stat-total"]').textContent = String(total);
        $('[data-role="stat-active"]').textContent = String(active);
        $('[data-role="stat-inactive"]').textContent = String(total - active);
    }

    function currentFilters() {
        return {
            search: $('[data-role="search"]').value.trim(),
            status: $('#empFilterStatus').value,
            department: $('#empFilterDepartment').value,
            lineType: $('[data-role="quick-line"]').value,
            position: $('#empFilterPosition').value,
            hasWhatsapp: $('#empFilterWhatsapp').checked,
            hasTelegram: $('#empFilterTelegram').checked,
            hireDateFrom: $('#empFilterHireFrom').value,
            hireDateTo: $('#empFilterHireTo').value
        };
    }

    function updateFilterBadge(filters = {}) {
        const badge = $('[data-role="filter-badge"]');
        const activeCount = [filters.status, filters.department, filters.position, filters.lineType,
            filters.hireDateFrom, filters.hireDateTo]
            .filter(Boolean).length + (filters.hasWhatsapp ? 1 : 0) + (filters.hasTelegram ? 1 : 0);
        badge.textContent = String(activeCount);
        badge.hidden = activeCount === 0;
    }

    function populateFilterOptions() {
        const fill = (select, values, placeholder) => {
            const previous = select.value;
            select.innerHTML = `<option value="">${placeholder}</option>`;
            values.sort().forEach((v) => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                select.appendChild(opt);
            });
            select.value = values.includes(previous) ? previous : '';
        };
        const departments = [...new Set(allEmployees.map((e) => e.department).filter(Boolean))];
        fill($('#empFilterDepartment'), departments, 'Все отделы');
        fill($('#empFilterPosition'), [...new Set(allEmployees.map((e) => e.position).filter(Boolean))], 'Все должности');
        // Тот же список отделов в тулбаре: состав берётся из одних данных,
        // иначе два «Все отделы» однажды разойдутся.
        fill($('[data-role="quick-department"]'), departments, 'Все отделы');
    }

    // Полный список — не на каждую перерисовку, а когда данные могли измениться.
    async function reloadAllForFilters() {
        try {
            const list = await storage.fetchEmployees();
            if (!isAlive()) return;
            allEmployees = list;
            populateFilterOptions();
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
        }
    }

    // Задан ли хоть один фильтр в наборе. При пустом отборе список сотрудников
    // совпадает с полным — значит второй запрос за «полным списком для
    // выпадающих фильтров» не нужен вовсе.
    function isFilterSet(f) {
        return Boolean(f.search || f.status || f.department || f.position || f.lineType
            || f.hasWhatsapp || f.hasTelegram || f.hireDateFrom || f.hireDateTo);
    }

    function hasActiveFilters() {
        return isFilterSet(appliedFilters);
    }

    /**
     * Сходить за данными. Вызывается только когда отбор мог измениться:
     * поиск, фильтры, обновление после правки. Сортировка, страница и
     * настройка колонок сюда не ходят — они меняют лишь то, КАК показан уже
     * загруженный список.
     */
    async function load() {
        const filters = currentFilters();
        try {
            const list = await storage.fetchEmployees(filters);
            if (!isAlive()) return false;
            rows = list;
            appliedFilters = filters;
            if (!isFilterSet(filters)) {
                allEmployees = list;
                populateFilterOptions();
            }
            return true;
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return false;
        }
    }

    /** Нарисовать уже загруженный список: сортировка, страница, колонки. */
    async function draw() {
        const list = rows.slice();

        const hidden = await getHiddenColumns();
        if (!isAlive()) return;

        applyColumnVisibility(hidden);
        // По применённому отбору, а не по полям окна: иначе счётчик загорается
        // от значения, которое человек выбрал и не применил.
        updateFilterBadge(appliedFilters);
        renderStatChips(list);

        // Колонка, по которой шла сортировка, скрыта — откатываем на дефолтную.
        if (STANDALONE_COLUMNS.includes(sortField) && hidden.has(sortField)) {
            sortField = 'id';
            sortDirection = 'asc';
        }

        list.sort((a, b) => {
            let valA = a[sortField] ?? '';
            let valB = b[sortField] ?? '';
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();
            if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });

        const totalPages = Math.ceil(list.length / PAGE_SIZE) || 1;
        if (currentPage > totalPages) currentPage = totalPages;

        if (list.length === 0) {
            $('[data-role="table-body"]').innerHTML = '';
            // Рамку таблицы прячем целиком: она забирает всю оставшуюся высоту
            // панели, и над сообщением висел бы пустой прямоугольник.
            $('[data-role="table-wrap"]').hidden = true;
            $('[data-role="empty-state"]').hidden = false;
            $('[data-role="pagination-row"]').hidden = true;
            updateMassBar();
            return;
        }
        $('[data-role="table-wrap"]').hidden = false;
        $('[data-role="empty-state"]').hidden = true;
        $('[data-role="pagination-row"]').hidden = false;

        const startIndex = (currentPage - 1) * PAGE_SIZE;
        const pageItems = list.slice(startIndex, startIndex + PAGE_SIZE);
        $('[data-role="table-body"]').innerHTML = pageItems.map((emp) => rowHtml(emp, hidden)).join('');

        renderPagination(list.length);
        renderFilterChips();
        renderSortIcons();
        updateMassBar();
    }

    // Строка активных фильтров. Подписи человеческие: не «status=active», а
    // «Статус: Активен». Снятие любого чипа и «Сбросить все» ходят тем же
    // путём, что окно «Фильтры», — общего состояния два не бывает.
    const FILTER_LABELS = {
        search: 'Поиск',
        status: 'Статус',
        department: 'Отдел',
        position: 'Должность',
        lineType: 'Линия',
        hireDateFrom: 'Принят с',
        hireDateTo: 'Принят по'
    };
    const STATUS_LABELS = { active: 'Активен', inactive: 'Неактивен' };

    function renderFilterChips() {
        const box = $('[data-role="filter-chips"]');
        if (!box) return;
        const f = appliedFilters || {};
        const chips = Object.keys(FILTER_LABELS)
            .filter((key) => f[key])
            .map((key) => ({
                key,
                label: FILTER_LABELS[key],
                value: key === 'status' ? (STATUS_LABELS[f[key]] || f[key]) : f[key]
            }));
        if (f.hasWhatsapp) chips.push({ key: 'hasWhatsapp', label: '', value: 'Есть WhatsApp' });
        if (f.hasTelegram) chips.push({ key: 'hasTelegram', label: '', value: 'Есть Telegram' });

        box.hidden = chips.length === 0;
        box.innerHTML = chips.length
            ? chips.map((c) => `
                <span class="ui-fchip">${c.label ? `${escapeHtml(c.label)}: ` : ''}<b>${escapeHtml(String(c.value))}</b>
                    <button type="button" class="ui-fchip__remove" data-drop-filter="${c.key}"
                            aria-label="Снять фильтр"></button>
                </span>`).join('')
                + '<button type="button" class="ui-fchips__clear" data-role="clear-filters">Сбросить все</button>'
            : '';
        box.querySelectorAll('.ui-fchip__remove').forEach((btn) => {
            btn.appendChild(iconNode('close', 'sm'));
        });
    }

    function dropFilter(key) {
        const controls = {
            search: '[data-role="search"]',
            status: '#empFilterStatus',
            department: '#empFilterDepartment',
            position: '#empFilterPosition',
            lineType: '[data-role="quick-line"]',
            hireDateFrom: '#empFilterHireFrom',
            hireDateTo: '#empFilterHireTo'
        };
        if (key === 'hasWhatsapp' || key === 'hasTelegram') {
            $(key === 'hasWhatsapp' ? '#empFilterWhatsapp' : '#empFilterTelegram').checked = false;
        } else if (controls[key]) {
            $(controls[key]).value = '';
        }
        // Отдел живёт в двух местах — снимаем в обоих.
        if (key === 'department') $('[data-role="quick-department"]').value = '';
    }

    function clearAllFilters() {
        Object.keys(FILTER_LABELS).forEach(dropFilter);
        dropFilter('hasWhatsapp');
        dropFilter('hasTelegram');
    }

    // ------------------------------------------------------------ выделение

    function updateMassBar() {
        $('[data-role="selected-count"]').textContent = `Выбрано: ${selectedIds.size}`;
        $('[data-role="mass-bar"]').hidden = selectedIds.size === 0;
        const boxes = $$('[data-check-id]');
        $('[data-role="select-all"]').checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
    }

    function clearSelection() {
        selectedIds.clear();
        $$('[data-check-id]').forEach((cb) => { cb.checked = false; });
        $$('tr[data-id]').forEach((tr) => tr.classList.remove('ui-table__row--selected'));
        // Вместе с выделением сбрасывается и выбранное действие: иначе полоса
        // откроется в следующий раз с прежним выбором, и «Применить» сделает
        // не то, чего человек ждёт.
        $('[data-role="mass-action"]').value = '';
        updateMassBar();
    }

    // ------------------------------------------------------------ действия

    async function handleDelete(id, name) {
        const ok = await confirmDanger({
            title: 'Удаление сотрудника',
            message: name
                ? `Удалить сотрудника «${name}»? Действие необратимо.`
                : 'Удалить этого сотрудника? Действие необратимо.'
        });
        if (!ok || !isAlive()) return;
        try {
            await storage.deleteEmployee(id);
            if (!isAlive()) return;
            selectedIds.delete(id);
            toast('Сотрудник удалён', 'success');
            await refresh();
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
        }
    }

    async function runMassInactive(ids) {
        let changed = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                const emp = await storage.fetchEmployeeById(id);
                if (!isAlive()) return;
                if (emp.status !== 'inactive') {
                    await storage.updateEmployee(id, { ...emp, status: 'inactive' });
                    changed++;
                }
            } catch (err) {
                if (isAbort(err)) return;
                failed++;
            }
            if (!isAlive()) return;
        }
        clearSelection();
        await refresh();
        if (!isAlive()) return;
        if (changed > 0) toast(`Статус обновлён у ${changed} сотрудников`, 'success');
        else if (failed === 0) toast('Нет сотрудников для изменения — они уже неактивны', 'info');
        if (failed > 0) toast(`Не удалось обновить: ${failed}`, 'error');
    }

    async function runMassDelete(ids) {
        const ok = await confirmDanger({
            title: 'Удаление сотрудников',
            message: `Будет удалено: ${ids.length}. Действие необратимо.`
        });
        if (!ok || !isAlive()) return;
        let deleted = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                await storage.deleteEmployee(id);
                deleted++;
            } catch (err) {
                if (isAbort(err)) return;
                failed++;
            }
            if (!isAlive()) return;
        }
        clearSelection();
        await refresh();
        if (!isAlive()) return;
        if (deleted > 0) toast(`Удалено сотрудников: ${deleted}`, 'success');
        if (failed > 0) toast(`Не удалось удалить: ${failed}`, 'error');
    }

    async function handleMassApply() {
        // Второй щелчок, пока идёт первый, повторял бы весь проход по списку —
        // для удаления это второй заход по уже удалённым, где сервер на каждого
        // отвечает «не найден».
        if (massApplying) return;
        const action = $('[data-role="mass-action"]').value;
        if (!action) { toast('Выберите действие', 'error'); return; }
        if (selectedIds.size === 0) { toast('Выберите хотя бы одного сотрудника', 'error'); return; }
        const ids = Array.from(selectedIds);

        massApplying = true;
        const btn = $('[data-role="mass-apply"]');
        btn.disabled = true;
        try {
            if (action === 'inactive') await runMassInactive(ids);
            else if (action === 'delete') await runMassDelete(ids);
        } finally {
            massApplying = false;
            btn.disabled = false;
        }
    }

    /** Сходить за данными и нарисовать — когда отбор изменился. */
    async function reload() {
        const ok = await load();
        if (!ok || !isAlive()) return;
        await draw();
    }

    /**
     * Обновление после изменения данных. Списки «Отдел» и «Должность» строятся
     * по полному набору, поэтому при заданном отборе он перечитывается
     * отдельно; при пустом хватает одного запроса — его делает load().
     */
    async function refresh() {
        if (hasActiveFilters()) {
            await reloadAllForFilters();
            if (!isAlive()) return;
        }
        await reload();
        if (!isAlive()) return;
        if (onDataChanged) await onDataChanged();
    }

    const renderDebounced = createDebounced(() => { currentPage = 1; reload(); }, SEARCH_DEBOUNCE_MS);

    function init() {
        $('[data-role="search"]').addEventListener('input', renderDebounced);

        $('thead').addEventListener('click', (e) => {
            const th = e.target.closest('th[data-field]');
            if (!th) return;
            const field = th.dataset.field;
            if (sortField === field) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            else { sortField = field; sortDirection = 'asc'; }
            currentPage = 1;
            draw();
        });

        $('[data-role="pagination"]').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-page]');
            if (!btn) return;
            const page = Number(btn.dataset.page);
            if (page === currentPage) return;
            currentPage = page;
            draw();
        });

        const body = $('[data-role="table-body"]');
        body.addEventListener('click', (e) => {
            const editBtn = e.target.closest('[data-edit]');
            if (editBtn) { onEdit(Number(editBtn.dataset.edit)); return; }
            const delBtn = e.target.closest('[data-del]');
            if (delBtn) handleDelete(Number(delBtn.dataset.del), delBtn.dataset.name || '');
        });
        body.addEventListener('change', (e) => {
            const cb = e.target.closest('[data-check-id]');
            if (!cb) return;
            const id = Number(cb.dataset.checkId);
            if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
            const row = cb.closest('tr');
            if (row) row.classList.toggle('ui-table__row--selected', cb.checked);
            updateMassBar();
        });

        $('[data-role="select-all"]').addEventListener('change', (e) => {
            const on = e.target.checked;
            $$('[data-check-id]').forEach((cb) => {
                cb.checked = on;
                const id = Number(cb.dataset.checkId);
                if (on) selectedIds.add(id); else selectedIds.delete(id);
                const row = cb.closest('tr');
                if (row) row.classList.toggle('ui-table__row--selected', on);
            });
            updateMassBar();
        });

        $('[data-role="mass-clear"]').addEventListener('click', clearSelection);
        $('[data-role="mass-apply"]').addEventListener('click', handleMassApply);

        // --- фильтры ---
        const filterModal = $('[data-role="filter-modal"]');
        $('[data-role="filter-toggle"]').addEventListener('click', () => { filterModal.hidden = false; });
        $('[data-role="filter-close"]').addEventListener('click', () => { filterModal.hidden = true; });
        filterModal.addEventListener('click', (e) => { if (e.target === filterModal) filterModal.hidden = true; });
        $('[data-role="filter-apply"]').addEventListener('click', () => {
            currentPage = 1;
            filterModal.hidden = true;
            reload();
        });
        $('[data-role="filter-clear"]').addEventListener('click', () => {
            clearAllFilters();
            currentPage = 1;
            filterModal.hidden = true;
            reload();
        });

        // --- тулбар: отдел и линия ---
        //
        // Отдел выбирается и здесь, и в окне «Фильтры»; состояние одно, поэтому
        // выбор в тулбаре сразу проставляется в окне, а не живёт рядом с ним.
        $('[data-role="quick-department"]').addEventListener('change', (e) => {
            $('#empFilterDepartment').value = e.target.value;
            currentPage = 1;
            reload();
        });
        $('[data-role="quick-line"]').addEventListener('change', () => {
            currentPage = 1;
            reload();
        });

        // --- строка активных фильтров ---
        //
        // Слушатель на контейнере: чипы перерисовываются при каждом изменении
        // отбора, и вешать обработчики на них пришлось бы заново.
        $('[data-role="filter-chips"]').addEventListener('click', (e) => {
            const drop = e.target.closest('[data-drop-filter]');
            if (drop) {
                dropFilter(drop.dataset.dropFilter);
                currentPage = 1;
                reload();
                return;
            }
            if (e.target.closest('[data-role="clear-filters"]')) {
                clearAllFilters();
                currentPage = 1;
                reload();
            }
        });
    }

    return {
        init,
        // reload — сходить за данными и нарисовать; draw — только перерисовать
        // уже загруженное (настройка колонок ничего не перезапрашивает).
        reload,
        draw,
        refresh,
        getRows: () => rows,
        destroy() {
            renderDebounced.cancel();
        }
    };
}
