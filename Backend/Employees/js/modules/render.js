// --- render.js: отрисовка таблицы, фильтры, сортировка, пагинация ---
//
// Редизайн (см. Отчёт Дизайн.md / dialog.md): вместо 12 независимых колонок
// таблица теперь строится вокруг составных ячеек "Сотрудник" (аватар+ФИО+
// должность), "Контакты" (телефон+email) и "Мессенджеры" (чипы WhatsApp/
// Telegram) — они структурные и присутствуют всегда, а "Отдел"/"Руководитель"/
// "Дата найма"/"Статус" остаются независимо переключаемыми колонками, как и
// раньше. Настройка видимых колонок (columnSettings.js) не менялась — 12
// чекбоксов управляют тем же Set скрытых ключей, изменилось только то, как
// composite-ячейки его учитывают (гранулярность внутри ячейки, не колонка
// целиком — dialog.md, п.1, ответ владельца).

import { fetchEmployees } from './storage.js';
import { showDeleteConfirm } from './confirmModal.js';
import { openEditEmployee } from './modal.js';
import { updateSelectedCount } from './massActions.js';
import { showToast } from './toast.js';
import { getHiddenColumns } from './columnSettings.js';

let sortField = 'id';
let sortDirection = 'asc';
let currentPage = 1;
const pageSize = 20;

const tbody = document.getElementById('employeeTableBody');
const emptyMessage = document.getElementById('emptyMessage');
const searchInput = document.getElementById('searchInput');

// Колонки, которые могут исчезать целиком (как и раньше) — их <th> статичны
// в HTML (id ниже), просто получают/теряют класс .col-hidden.
const STANDALONE_TH_IDS = {
    department: 'thDepartment',
    managerName: 'thManagerName',
    hireDate: 'thHireDate',
    status: 'thStatus',
    terminationDate: 'thTerminationDate',
    lineType: 'thLineType',
    workSchedule: 'thWorkSchedule'
};

function applyStandaloneColumnVisibility(hiddenColumns) {
    Object.entries(STANDALONE_TH_IDS).forEach(([key, thId]) => {
        const th = document.getElementById(thId);
        if (th) th.classList.toggle('col-hidden', hiddenColumns.has(key));
    });
}

// Цвет аватара стабилен на сотрудника (id % 4), не зависит от позиции строки
// в текущей отсортированной/отфильтрованной выдаче — dialog.md, п.5 (демо-
// упрощение "по индексу строки" в макете для реализации не переносится).
function renderAvatar(emp) {
    const last = (emp.lastName || '').trim().charAt(0).toUpperCase();
    const first = (emp.firstName || '').trim().charAt(0).toUpperCase();
    const initials = `${last}${first}` || '?';
    const colorIndex = Math.abs(Number(emp.id) || 0) % 4;
    return `<span class="avatar-initials av-${colorIndex}">${escapeHtml(initials)}</span>`;
}

// "Сотрудник" — составная ячейка. Каждая часть учитывает свой ключ из
// hiddenColumns независимо (гранулярность как и была, dialog.md п.1).
function renderEmployeeCell(emp, hiddenColumns) {
    const nameParts = [];
    if (!hiddenColumns.has('lastName')) nameParts.push(emp.lastName);
    if (!hiddenColumns.has('firstName')) nameParts.push(emp.firstName);
    if (!hiddenColumns.has('middleName') && emp.middleName) nameParts.push(emp.middleName);
    const fio = escapeHtml(nameParts.filter(Boolean).join(' '));
    const showPosition = !hiddenColumns.has('position') && emp.position;
    return `
        <div class="employee-cell">
            ${renderAvatar(emp)}
            <div class="employee-cell-text">
                <div class="employee-name">${fio}</div>
                ${showPosition ? `<div class="employee-position">${escapeHtml(emp.position)}</div>` : ''}
            </div>
        </div>
    `;
}

// "Контакты" — скрыт email → остаётся только телефон (и наоборот); скрыты
// оба → ячейка пустая (dialog.md п.1, ответ владельца, буквально).
function renderContactsCell(emp, hiddenColumns) {
    const lines = [];
    if (!hiddenColumns.has('phone') && emp.phone) {
        lines.push(`<div class="contact-line contact-phone"><i class="fas fa-phone" aria-hidden="true"></i>${escapeHtml(emp.phone)}</div>`);
    }
    if (!hiddenColumns.has('email') && emp.email) {
        lines.push(`<div class="contact-line"><i class="fas fa-envelope" aria-hidden="true"></i>${escapeHtml(emp.email)}</div>`);
    }
    return `<div class="contact-cell">${lines.join('')}</div>`;
}

// "Мессенджеры" — чип не показывается, если пусто поле у сотрудника ИЛИ
// колонка скрыта в настройках (оба условия вместе, не взаимоисключающе);
// если ни один чип не показан — тире (Отчёт Дизайн.md, п.6 ответов).
function renderMessengersCell(emp, hiddenColumns) {
    const chips = [];
    if (!hiddenColumns.has('whatsapp') && emp.whatsapp) {
        chips.push('<span class="messenger-chip chip-whatsapp" title="WhatsApp"><i class="fab fa-whatsapp" aria-hidden="true"></i></span>');
    }
    if (!hiddenColumns.has('telegram') && emp.telegram) {
        chips.push('<span class="messenger-chip chip-telegram" title="Telegram"><i class="fab fa-telegram" aria-hidden="true"></i></span>');
    }
    if (chips.length === 0) {
        return '<div class="messenger-cell messenger-empty">—</div>';
    }
    return `<div class="messenger-cell">${chips.join('')}</div>`;
}

function renderManagerCell(emp) {
    if (!emp.managerName) {
        return '<span class="manager-cell manager-empty">—</span>';
    }
    return `<span class="manager-cell"><i class="fas fa-share" aria-hidden="true"></i>${escapeHtml(emp.managerName)}</span>`;
}

function renderStatusBadge(emp) {
    const statusClass = emp.status === 'active' ? 'status-active' : 'status-inactive';
    const statusText = emp.status === 'active' ? 'Активен' : 'Неактивен';
    return `<span class="status-badge ${statusClass}">${statusText}</span>`;
}

// Живой пересчёт стат-чипов шапки — по всему текущему отфильтрованному
// набору (все страницы), не только по видимой странице пагинации
// (dialog.md, п.8, ответ владельца).
function renderStatChips(filtered) {
    const total = filtered.length;
    const active = filtered.filter((e) => e.status === 'active').length;
    const inactive = total - active;
    document.getElementById('statTotal').textContent = String(total);
    document.getElementById('statActive').textContent = String(active);
    document.getElementById('statInactive').textContent = String(inactive);
}

export async function renderTable() {
    // Значения фильтров — фильтрация теперь выполняется на сервере
    const filterText = searchInput.value;
    const status = document.getElementById('filterStatus')?.value || '';
    const department = document.getElementById('filterDepartment')?.value || '';
    const position = document.getElementById('filterPosition')?.value || '';
    const hasWhatsapp = document.getElementById('filterHasWhatsapp')?.checked || false;
    const hasTelegram = document.getElementById('filterHasTelegram')?.checked || false;
    const hireDateFrom = document.getElementById('filterHireDateFrom')?.value || '';
    const hireDateTo = document.getElementById('filterHireDateTo')?.value || '';

    let allEmployees, filtered;
    try {
        // Полный список (без фильтров) — только для наполнения выпадающих списков "Отдел"/"Должность"
        allEmployees = await fetchEmployees();
        filtered = await fetchEmployees({
            search: filterText.trim(),
            status,
            department,
            position,
            hasWhatsapp,
            hasTelegram,
            hireDateFrom,
            hireDateTo
        });
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    populateFilterOptions(allEmployees);

    const hiddenColumns = await getHiddenColumns();
    applyStandaloneColumnVisibility(hiddenColumns);
    updateFilterBadge({ status, department, position, hasWhatsapp, hasTelegram, hireDateFrom, hireDateTo });

    // Стат-чипы — по всему текущему отфильтрованному набору (все страницы),
    // не только по видимой странице (dialog.md, п.8).
    renderStatChips(filtered);

    // Колонка, по которой шла сортировка, скрыта — откатываем на дефолтную (по id).
    // "lastName" (заголовок "Сотрудник") и "id" никогда не скрываются целиком.
    if (sortField in STANDALONE_TH_IDS && hiddenColumns.has(sortField)) {
        sortField = 'id';
        sortDirection = 'asc';
    }

    // Сортировка
    filtered.sort((a, b) => {
        let valA = a[sortField] ?? '';
        let valB = b[sortField] ?? '';
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    // Пагинация
    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, totalItems);
    const pageItems = filtered.slice(startIndex, endIndex);

    if (filtered.length === 0) {
        tbody.innerHTML = '';
        emptyMessage.classList.add('visible');
        document.getElementById('paginationControls').innerHTML = '';
        updateSelectedCount();
        return;
    }
    emptyMessage.classList.remove('visible');

    // Генерация пагинации
    const paginationEl = document.getElementById('paginationControls');
    let pagesHtml = '';
    const maxVisible = 7;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }
    for (let i = startPage; i <= endPage; i++) {
        pagesHtml += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    paginationEl.innerHTML = pagesHtml;
    paginationEl.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const page = parseInt(this.dataset.page);
            if (page !== currentPage) {
                currentPage = page;
                renderTable();
            }
        });
    });

    // Генерация строк — Сотрудник/Контакты/Мессенджеры всегда рендерятся
    // (composite-ячейки), Отдел/Руководитель/Дата найма/Статус получают
    // .col-hidden, если скрыты в настройках (та же логика, что и для их <th>).
    let html = '';
    pageItems.forEach(emp => {
        const idFormatted = String(emp.id).padStart(4, '0');
        const hiddenCls = (key) => (hiddenColumns.has(key) ? ' col-hidden' : '');
        const fullName = `${emp.lastName || ''} ${emp.firstName || ''}`.trim();
        html += `
            <tr data-id="${emp.id}">
                <td><input type="checkbox" class="row-checkbox" data-id="${emp.id}"></td>
                <td>${idFormatted}</td>
                <td>${renderEmployeeCell(emp, hiddenColumns)}</td>
                <td class="department-cell${hiddenCls('department')}">${emp.department ? `<span class="department-tag">${escapeHtml(emp.department)}</span>` : '—'}</td>
                <td>${renderContactsCell(emp, hiddenColumns)}</td>
                <td>${renderMessengersCell(emp, hiddenColumns)}</td>
                <td class="manager-td${hiddenCls('managerName')}">${renderManagerCell(emp)}</td>
                <td class="hiredate-td${hiddenCls('hireDate')}">${emp.hireDate ? formatDate(emp.hireDate) : '—'}</td>
                <td class="status-td${hiddenCls('status')}">${renderStatusBadge(emp)}</td>
                <td class="termination-td${hiddenCls('terminationDate')}">${emp.terminationDate ? formatDate(emp.terminationDate) : '—'}</td>
                <td class="linetype-td${hiddenCls('lineType')}">${emp.lineType ? escapeHtml(emp.lineType) : '—'}</td>
                <td class="workschedule-td${hiddenCls('workSchedule')}">${emp.workSchedule ? escapeHtml(emp.workSchedule) : '—'}</td>
                <td>
                    <button class="action-btn btn-edit" data-id="${emp.id}" aria-label="Редактировать" title="Изменить"><i class="fas fa-pencil-alt" aria-hidden="true"></i></button>
                    <button class="action-btn btn-delete" data-id="${emp.id}" data-name="${escapeHtml(fullName)}" aria-label="Удалить" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // Обновляем индикатор сортировки — реальная FA-иконка вместо текстовых
    // символов ▲/▼ (Отчёт Дизайн.md исправлен, dialog.md п.4: этого не было
    // в текущей реализации, это новый элемент).
    document.querySelectorAll('thead th[data-field]').forEach(th => {
        const field = th.dataset.field;
        const icon = th.querySelector('.sort-icon');
        if (field === sortField) {
            const iconClass = sortDirection === 'asc' ? 'fa-arrow-down-short-wide' : 'fa-arrow-down-wide-short';
            if (!icon) {
                const i = document.createElement('i');
                i.className = `fas ${iconClass} sort-icon`;
                i.setAttribute('aria-hidden', 'true');
                th.appendChild(i);
            } else {
                icon.className = `fas ${iconClass} sort-icon`;
            }
        } else {
            if (icon) icon.remove();
        }
    });

    updateSelectedCount();
}

// Бейдж числа активных фильтров на кнопке "Фильтры" — живой счётчик, не
// демо-заглушка (в макете было жёстко "2" для иллюстрации).
function updateFilterBadge({ status, department, position, hasWhatsapp, hasTelegram, hireDateFrom, hireDateTo }) {
    const badge = document.getElementById('filterBadge');
    if (!badge) return;
    const activeCount = [status, department, position, hireDateFrom, hireDateTo].filter(Boolean).length
        + (hasWhatsapp ? 1 : 0) + (hasTelegram ? 1 : 0);
    badge.textContent = String(activeCount);
    badge.hidden = activeCount === 0;
}

function populateFilterOptions(employees) {
    const departments = [...new Set(employees.map(e => e.department).filter(Boolean))];
    const positions = [...new Set(employees.map(e => e.position).filter(Boolean))];

    const deptSelect = document.getElementById('filterDepartment');
    const posSelect = document.getElementById('filterPosition');
    if (deptSelect) {
        const currentVal = deptSelect.value;
        deptSelect.innerHTML = '<option value="">Все отделы</option>';
        departments.sort().forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            deptSelect.appendChild(opt);
        });
        deptSelect.value = currentVal;
    }
    if (posSelect) {
        const currentVal = posSelect.value;
        posSelect.innerHTML = '<option value="">Все должности</option>';
        positions.sort().forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            posSelect.appendChild(opt);
        });
        posSelect.value = currentVal;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"]/g, m => {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return m;
    });
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

// Обработчик сортировки по клику на заголовок
export function initSorting() {
    document.querySelector('thead').addEventListener('click', function(e) {
        const th = e.target.closest('th[data-field]');
        if (!th) return;
        const field = th.dataset.field;
        if (sortField === field) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            sortField = field;
            sortDirection = 'asc';
        }
        currentPage = 1;
        renderTable();
    });
}

// Обработчик действий в таблице (редактирование/удаление)
export function initTableActions() {
    tbody.addEventListener('click', function(e) {
        const target = e.target.closest('button');
        if (!target) return;
        if (target.classList.contains('btn-delete')) {
            const id = parseInt(target.dataset.id);
            showDeleteConfirm(id, target.dataset.name || '');
        } else if (target.classList.contains('btn-edit')) {
            const id = parseInt(target.dataset.id);
            openEditEmployee(id);
        }
    });
}

// Экспортируем переменные для управления пагинацией/сортировкой
export function setPage(page) { currentPage = page; }
export function getPage() { return currentPage; }
export function setSort(field, dir) { sortField = field; sortDirection = dir; }
