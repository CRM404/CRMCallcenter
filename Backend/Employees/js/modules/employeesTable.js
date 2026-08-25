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

import { icon, iconNode } from '/ui/icons.js';
import { openModal } from '/ui/modal.js';
import {
    openEmployeeArchive, openEmployeeMassArchive, openEmployeeReturn
} from './employeesArchive.js';

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
 * @param {Object}      deps  { storage, toast, isAlive, isAbort,
 *                              getHiddenColumns, onEdit, onDataChanged }
 */
export function createTable(root, deps) {
    const { storage, toast, isAlive, isAbort, getHiddenColumns, onEdit, onDataChanged } = deps;

    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));

    let sortField = 'id';
    let sortDirection = 'asc';
    let currentPage = 1;
    let rows = [];

    // ОТБОР ЖИВЁТ В ОБЪЕКТЕ, А НЕ В ПОЛЯХ ОКНА.
    //
    // Пока окно фильтров было объявлено разметкой, оно существовало всегда, и
    // значение отбора можно было прочитать прямо из его полей в любой момент.
    // Окно слоя существует, только пока открыто (К110), — читать из него
    // состояние в момент запроса больше нельзя.
    //
    // draft — что набрано: тулбар пишет сюда сразу, окно — по «Применить».
    // applied — с чем реально сходили на сервер. Поля окна это ещё не отбор:
    // их можно заполнить и закрыть окно, не нажимая «Применить».
    const EMPTY_FILTERS = {
        search: '', status: '', department: '', position: '', lineType: '',
        hasWhatsapp: false, hasTelegram: false, hireDateFrom: '', hireDateTo: ''
    };
    let draftFilters = { ...EMPTY_FILTERS };
    let appliedFilters = {};
    // Открытое окно фильтров или null.
    let filterModal = null;
    // Списки «Отдел» и «Должность» собираются из самих сотрудников. Раньше они
    // жили прямо в <select> окна; теперь окна между открытиями нет.
    let filterOptions = { departments: [], positions: [] };
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
        // Значок `user`, а не `share` (К119): руководитель — человек, а `share`
        // рисует три соединённых узла, то есть связь, а не людей.
        return `<span class="manager-cell"><svg class="ui-ic ui-ic--sm ui-ic--quiet" aria-hidden="true"><use href="#ui-ic-user"></use></svg>${escapeHtml(emp.managerName)}</span>`;
    }

    // ТРИ СОСТОЯНИЯ ВМЕСТО ДВУХ (решение владельца 70). Слово «Неактивен»
    // уходит: неактивным человека делают и не увольняя.
    //
    // ОБЕ ПОМЕТКИ АРХИВА — --mute, ОДНИМ ЦВЕТОМ, и это решение, а не экономия:
    // для системы разницы между ними нет, добавочный освобождается и ключ
    // отзывается в обоих случаях. Цветом различать состояния, ведущие себя
    // одинаково, значит обещать разное поведение.
    //
    // Строку выведенного НЕ ГАСИМ прозрачностью — её читают: когда ушёл, в
    // каком отделе работал, какие документы остались. Состояние называет пилюля.
    function renderStatusBadge(emp) {
        if (emp.status === 'active') {
            return '<span class="ui-pill ui-pill--ok">Активен</span>';
        }
        // Вид архива мог не проставиться только у строки, заведённой мимо
        // приложения: миграция части 5 проставила «Уволен» всем существующим.
        const frozen = emp.archiveKind === 'frozen';
        const label = frozen ? 'Заморожен' : 'Уволен';
        // Дата под пилюлей: у уволенного — своя колонка, у замороженного —
        // frozen_at. Одной колонки на два смысла нет намеренно (ответ И79).
        const since = frozen ? emp.frozenAt : emp.terminationDate;
        const line = since ? `<span class="arc-since">с ${formatDate(since)}</span>` : '';
        return `<span class="ui-pill ui-pill--mute">${label}</span>${line}`;
    }

    // ------------------------------------------------------------ отрисовка

    function applyColumnVisibility(hidden) {
        STANDALONE_COLUMNS.forEach((key) => {
            $$(`[data-col="${key}"]`).forEach((cell) => { cell.hidden = hidden.has(key); });
        });
    }

    /**
     * КРАСНОГО ЗНАЧКА В СТРОКЕ СОТРУДНИКА НЕТ ВОВСЕ (паспорт Р7). Сотрудников
     * физически не удаляют (план 11.2), и кнопка, которой нельзя
     * воспользоваться, хуже отсутствующей. Вместо неё — «Вывести из работы»
     * значком archive, без цвета: действие обратимо, а красный обещал бы
     * необратимость, которой нет.
     *
     * У выведенной строки действие одно — «Вернуть в работу». Ни правки, ни
     * чего-либо ещё: сначала верни, потом работай.
     */
    function renderRowActions(emp, archived) {
        if (archived) {
            return `<button type="button" class="ui-btn ui-btn--row" data-return="${emp.id}"`
                + ` title="Вернуть в работу">Вернуть в работу</button>`;
        }
        return `
            <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-edit="${emp.id}" title="Изменить" aria-label="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
            <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-archive="${emp.id}" title="Вывести из работы: уволить или заморозить. Карточка и документы останутся, добавочный освободится" aria-label="Вывести из работы"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-archive"></use></svg></button>`;
    }

    function rowHtml(emp, hidden) {
        // Номер записи как есть: «0001» выглядит как код или артикул, а это
        // просто id строки (М29, подтверждено паспортом — «ID · номер записи»).
        const idFormatted = String(emp.id);
        const hiddenAttr = (key) => (hidden.has(key) ? ' hidden' : '');
        const fullName = `${emp.lastName || ''} ${emp.firstName || ''}`.trim();
        const checked = selectedIds.has(emp.id) ? ' checked' : '';
        const archived = emp.status === 'inactive';
        // ЧЕКБОКСА У ВЫВЕДЕННОЙ СТРОКИ НЕТ (паспорт Р7, ответ И111): массовое
        // действие к ней всё равно не применится, а пустой чекбокс обещал бы,
        // что применится. Ячейка остаётся — иначе поедет вся таблица.
        const cell = archived
            ? ''
            : `<input type="checkbox" data-check-id="${emp.id}" aria-label="Выбрать сотрудника ${idFormatted}"${checked}>`;
        return `
            <tr data-id="${emp.id}" class="${selectedIds.has(emp.id) ? 'ui-table__row--selected' : ''}">
                <td class="ui-table__sel">${cell}</td>
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
                <td class="ui-table__acts">${renderRowActions(emp, archived)}</td>
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

    /**
     * Пустое состояние отвечает на вопрос «почему я ничего не вижу», и ответов
     * два: в разделе никого нет — или никто не подошёл под отбор. Разница не
     * косметическая: второй случай прежде выглядел как первый и звал завести
     * сотрудника, который уже заведён (К52). Дубль человека стоит дороже
     * лишнего щелчка.
     */
    function showEmptyState() {
        const filtered = hasActiveFilters();
        const box = $('[data-role="empty-state"]');
        const action = $('[data-role="empty-action"]');
        const iconBox = $('[data-role="empty-icon"]');

        // ПУСТОЙ АРХИВ — ОТДЕЛЬНОЕ СОСТОЯНИЕ, И ИХ ДВА, А НЕ ОДНО (паспорт Р7).
        // «Уволенных нет» и «Замороженных нет» различить можно только настоящим
        // отбором по виду архива — ради этого он и заведён на сервере (И112).
        // Общий текст «ничего не найдено по фильтрам» звал бы сбросить отбор,
        // хотя сбрасывать нечего: людей в этом состоянии просто нет.
        const archiveKind = appliedFilters.status === 'dismissed' ? 'Уволенных'
            : appliedFilters.status === 'frozen' ? 'Замороженных' : null;
        if (archiveKind) {
            // Значок обычный, приглушённый: пустой архив — не хорошая и не
            // плохая новость, сюда пока ничего не клали. Зелёный .ui-empty--good
            // здесь не применяется.
            iconBox.innerHTML = icon('archive', 'lg', 'ui-empty__icon');
            iconBox.hidden = false;
            $('[data-role="empty-title"]').textContent = `${archiveKind} нет`;
            $('[data-role="empty-text"]').textContent =
                'Все сотрудники работают. Выведенные из работы останутся здесь '
                + 'со всеми документами и графиком.';
            action.hidden = false;
            box.hidden = false;
            return;
        }
        iconBox.hidden = true;
        iconBox.innerHTML = '';

        $('[data-role="empty-title"]').textContent = filtered
            ? 'Ничего не найдено по текущим фильтрам'
            : 'Нет сотрудников';
        $('[data-role="empty-text"]').textContent = filtered
            ? 'Сотрудники в разделе есть — просто ни один не подходит под отбор. Проверьте написание или сбросьте фильтры.'
            // Кнопка названа ровно так, как подписана в шапке (К116). До этого
            // текст звал к «Новому сотруднику» — так называется ЗАГОЛОВОК окна,
            // которое ещё не открыто, а кнопка в шапке подписана иначе.
            : 'Добавьте первого — кнопка «Добавить сотрудника» в шапке раздела.';
        action.hidden = !filtered;
        box.hidden = false;
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
            const icon = th.querySelector('.ui-table__sort-icon');
            if (th.dataset.field === sortField) {
                const key = sortDirection === 'asc' ? 'sort-asc' : 'sort-desc';
                if (icon) icon.remove();
                // Ступень `xs`, а не `sm`: значок стоит рядом с текстом шапки в
                // 10.5 px, и по правилу выбора ступени крупнее подписи он быть
                // не может (К29). Класс — из слоя: свой `.sort-icon` раздел
                // объявлял ради того же отступа и цвета.
                th.appendChild(iconNode(key, 'xs', 'ui-table__sort-icon'));
            } else if (icon) {
                icon.remove();
            }
        });
    }

    // ЧЕТЫРЕ ЧИСЛА, И СЧИТАЮТСЯ ОНИ ПО ПОКАЗАННОМУ СПИСКУ — они отвечают на
    // вопрос «что сейчас на экране». Ровно поэтому (N) не ставится ещё и в
    // отбор состояния: при любом другом отборе (отдел, линия, поиск) числа
    // разошлись бы, и рядом стояли бы «уволены 0» и «Уволенные (4)» (И100).
    //
    // Условие ТО ЖЕ, что у отбора: «Активные» — это status === 'active', а не
    // «вид архива пуст». Две разные проверки на одно состояние разойдутся.
    function renderStatChips(list) {
        const archived = list.filter((e) => e.status === 'inactive');
        $('[data-role="stat-total"]').textContent = String(list.length);
        $('[data-role="stat-active"]').textContent = String(list.length - archived.length);
        $('[data-role="stat-dismissed"]').textContent =
            String(archived.filter((e) => e.archiveKind !== 'frozen').length);
        $('[data-role="stat-frozen"]').textContent =
            String(archived.filter((e) => e.archiveKind === 'frozen').length);
    }

    function currentFilters() {
        return { ...draftFilters };
    }

    /** Тулбар показывает набранное: отдел и линию видно и без окна. */
    function syncToolbar() {
        const set = (sel, value) => { const node = $(sel); if (node) node.value = value || ''; };
        set('[data-role="search"]', draftFilters.search);
        set('[data-role="quick-department"]', draftFilters.department);
        set('[data-role="quick-line"]', draftFilters.lineType);
    }

    /**
     * Счётчик на кнопке «Фильтры» считает ТОЛЬКО то, что лежит в этом окне
     * (К121). Линия и поиск — тулбарные, в окне их нет и по паспорту быть не
     * должно: кнопка обещала действующий отбор, а окно за ней показывало
     * пустоту. Обе они видны своими чипами в строке активных фильтров.
     */
    const MODAL_FILTER_KEYS = ['status', 'department', 'position', 'hireDateFrom', 'hireDateTo'];

    function updateFilterBadge(filters = {}) {
        const badge = $('[data-role="filter-badge"]');
        const activeCount = MODAL_FILTER_KEYS.filter((key) => filters[key]).length
            + (filters.hasWhatsapp ? 1 : 0) + (filters.hasTelegram ? 1 : 0);
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
        const positions = [...new Set(allEmployees.map((e) => e.position).filter(Boolean))];
        // Состав запоминается: окно фильтров собирается при открытии, и на
        // момент этого вызова его может не быть на экране.
        filterOptions = { departments: [...departments].sort(), positions: [...positions].sort() };
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
    /**
     * Одно значение отбора — два параметра сервера.
     *
     * status и archive_kind отвечают на РАЗНЫЕ вопросы, и сводить их в одно
     * условие нельзя (предупреждение куратора при И112): на status висят
     * освобождение добавочного и отзыв ключа туннеля, archive_kind — только
     * слово в карточке. «Активные» — это status === 'active', а не «вид архива
     * пуст».
     */
    function toServerFilters(filters) {
        const { status, ...rest } = filters;
        if (status === 'dismissed' || status === 'frozen') {
            return { ...rest, status: 'inactive', archiveKind: status };
        }
        return { ...rest, status };
    }

    async function load() {
        const filters = currentFilters();
        try {
            const list = await storage.fetchEmployees(toServerFilters(filters));
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
            showEmptyState();
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
            // Текст чипа — 11.5 px, значок рядом с ним по правилу ступеней
            // берёт `xs`: на `sm` крестик был почти вдвое выше букв слова,
            // которое снимает (К41).
            btn.appendChild(iconNode('close', 'xs'));
        });
    }

    function dropFilter(key) {
        if (!(key in draftFilters)) return;
        draftFilters[key] = typeof EMPTY_FILTERS[key] === 'boolean' ? false : '';
        syncToolbar();
    }

    function clearAllFilters() {
        draftFilters = { ...EMPTY_FILTERS };
        syncToolbar();
    }

    // ------------------------------------------------------------ выделение

    /**
     * Причина отказа — строкой в полосе, а не тостом (К95): полоса одна на три
     * раздела, и объясняться она обязана одинаково.
     */
    function showMassWarn(text) {
        const node = $('[data-role="mass-warn"]');
        if (!node) return;
        node.textContent = text;
        node.hidden = false;
    }

    function hideMassWarn() {
        const node = $('[data-role="mass-warn"]');
        if (!node) return;
        node.textContent = '';
        node.hidden = true;
    }

    function updateMassBar() {
        $('[data-role="selected-count"]').textContent = `Выбрано: ${selectedIds.size}`;
        $('[data-role="mass-bar"]').hidden = selectedIds.size === 0;
        // Выделение изменилось — прежняя причина могла перестать быть правдой.
        hideMassWarn();
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

    /**
     * Вопрос стоит в ЗАГОЛОВКЕ, а текст занят ПОСЛЕДСТВИЕМ (К114). Было
     * наоборот: заголовок спрашивал «Удалить сотрудника?», текст повторял тот
     * же вопрос с именем, и место последствия уходило на повтор — человек не
     * узнавал, что вместе с карточкой пропадёт весь проставленный ему месяц.
     * Ровно то же правилось у окна закрытия карточки (К92).
     */
    /**
     * «Вывести из работы» — одна строка.
     *
     * Числа последствий тянет само окно: они обязаны быть посчитаны ДО
     * действия, потому что человек принимает решение по ним. Показать их
     * следом, тостом, значит сообщить о случившемся вместо того, чтобы дать
     * выбрать (паспорт Р7).
     */
    async function handleArchive(id) {
        const emp = rows.find((e) => e.id === id);
        if (!emp) return;
        try {
            await openEmployeeArchive({
                scope: root,
                employee: emp,
                storage,
                toast,
                onDone: async () => { selectedIds.delete(id); await refresh(); }
            });
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
        }
    }

    /** «Вернуть в работу» — с обязательным добавочным (решение владельца 71). */
    async function handleReturn(id) {
        const emp = rows.find((e) => e.id === id);
        if (!emp) return;
        try {
            await openEmployeeReturn({
                scope: root,
                employee: emp,
                storage,
                toast,
                onDone: async () => { await refresh(); }
            });
        } catch (err) {
            if (!isAlive() || isAbort(err)) return;
            toast(err.message, 'error');
        }
    }

    async function handleMassApply() {
        // Второй щелчок, пока идёт первый, повторял бы весь проход по списку —
        // для удаления это второй заход по уже удалённым, где сервер на каждого
        // отвечает «не найден».
        if (massApplying) return;
        const action = $('[data-role="mass-action"]').value;
        if (!action) { showMassWarn('Выберите действие'); return; }
        if (selectedIds.size === 0) { showMassWarn('Выберите хотя бы одного сотрудника'); return; }
        hideMassWarn();
        const ids = Array.from(selectedIds);

        massApplying = true;
        const btn = $('[data-role="mass-apply"]');
        btn.disabled = true;
        try {
            // ОДНО ДЕЙСТВИЕ ЧЕЛОВЕКА — ОДНА ПАРТИЯ В ЖУРНАЛЕ (часть 3, Б2.10).
            // Массовое действие клиент делает чередой обычных запросов, и без
            // общего признака сто выделенных строк дали бы в журнале сто
            // отдельных правок, за которыми не видно одного нажатия.
            // ПАРТИЮ ЗДЕСЬ БОЛЬШЕ НЕ ЗАВОДИМ: массовый вывод из работы ушёл
            // на серверный маршрут bulk-archive, и партию заводит он сам —
            // одним запросом, а не чередой обычных. Признак партии от клиента
            // тут только раздвоил бы одно действие на две записи.
            if (action === 'archive') {
                await openEmployeeMassArchive({
                    scope: root,
                    ids,
                    storage,
                    toast,
                    onDone: async () => { clearSelection(); await refresh(); }
                });
            }
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

    // ------------------------------------------------------------ окно «Фильтры»

    /** Заполнить <select> окна значениями, собранными из самих сотрудников. */
    function fillModalSelect(select, values, placeholder, selected) {
        select.innerHTML = `<option value="">${placeholder}</option>`;
        values.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            select.appendChild(opt);
        });
        select.value = values.includes(selected) ? selected : '';
    }

    function openFilterModal() {
        if (filterModal) return;
        const body = document.createElement('div');
        body.appendChild($('[data-role="filter-tpl"]').content.cloneNode(true));

        const field = (sel) => body.querySelector(sel);
        // Окно открывается на НАБРАННОМ отборе, а не на применённом: тулбар и
        // окно держат одно состояние (паспорт: «сменил в одном — видно в другом»).
        field('#empFilterStatus').value = draftFilters.status || '';
        fillModalSelect(field('#empFilterDepartment'), filterOptions.departments, 'Все отделы', draftFilters.department);
        fillModalSelect(field('#empFilterPosition'), filterOptions.positions, 'Все должности', draftFilters.position);
        field('#empFilterWhatsapp').checked = Boolean(draftFilters.hasWhatsapp);
        field('#empFilterTelegram').checked = Boolean(draftFilters.hasTelegram);
        field('#empFilterHireFrom').value = draftFilters.hireDateFrom || '';
        field('#empFilterHireTo').value = draftFilters.hireDateTo || '';

        const readModal = () => {
            draftFilters = {
                ...draftFilters,
                status: field('#empFilterStatus').value,
                department: field('#empFilterDepartment').value,
                position: field('#empFilterPosition').value,
                hasWhatsapp: field('#empFilterWhatsapp').checked,
                hasTelegram: field('#empFilterTelegram').checked,
                hireDateFrom: field('#empFilterHireFrom').value,
                hireDateTo: field('#empFilterHireTo').value
            };
            syncToolbar();
        };

        filterModal = openModal({
            title: 'Фильтры',
            body,
            scope: root,
            spread: true,
            actions: [
                // «Сбросить» сбрасывает и применяет разом: держать в окне
                // пустые поля, пока список показывает прежний отбор, незачем.
                {
                    label: 'Сбросить',
                    variant: 'secondary',
                    side: 'start',
                    role: 'filter-clear',
                    onClick: () => { clearAllFilters(); currentPage = 1; reload(); }
                },
                // «Отмена» — выход, названный словом (К56). Набранное в окне
                // просто не читается: отбор остаётся тем, что был.
                { label: 'Отмена', variant: 'ghost', role: 'filter-cancel', value: false },
                {
                    label: 'Применить',
                    role: 'filter-apply',
                    onClick: () => { readModal(); currentPage = 1; reload(); }
                }
            ]
        });
        filterModal.result.then(() => { filterModal = null; });

        // Фокус — в первое поле окна, а не на крестик (К110).
        field('#empFilterStatus').focus();
    }

    function init() {
        $('[data-role="search"]').addEventListener('input', (e) => {
            draftFilters.search = e.target.value.trim();
            renderDebounced();
        });

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
            const archiveBtn = e.target.closest('[data-archive]');
            if (archiveBtn) { handleArchive(Number(archiveBtn.dataset.archive)); return; }
            const returnBtn = e.target.closest('[data-return]');
            if (returnBtn) { handleReturn(Number(returnBtn.dataset.return)); return; }

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
        $('[data-role="filter-toggle"]').addEventListener('click', openFilterModal);

        // --- тулбар: отдел и линия ---
        //
        // Отдел выбирается и здесь, и в окне «Фильтры»; состояние одно — оба
        // пишут в один объект отбора, а не проставляют значение друг другу.
        $('[data-role="quick-department"]').addEventListener('change', (e) => {
            draftFilters.department = e.target.value;
            currentPage = 1;
            reload();
        });
        $('[data-role="quick-line"]').addEventListener('change', (e) => {
            draftFilters.lineType = e.target.value;
            currentPage = 1;
            reload();
        });

        // --- строка активных фильтров ---
        //
        // Слушатель на контейнере: чипы перерисовываются при каждом изменении
        // отбора, и вешать обработчики на них пришлось бы заново.
        // Кнопка сброса из пустого состояния делает то же, что «Сбросить все»
        // в строке чипов: строки чипов в этот момент человек может и не видеть.
        $('[data-role="empty-action"]').addEventListener('click', () => {
            clearAllFilters();
            currentPage = 1;
            reload();
        });

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
