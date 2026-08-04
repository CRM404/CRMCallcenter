// --- render.js: отрисовка таблицы, фильтры, сортировка, пагинация ---

import { fetchEmployees } from './storage.js';
import { showDeleteConfirm } from './confirmModal.js';
import { openEditEmployee } from './modal.js';
import { updateSelectedCount } from './massActions.js';
import { showToast } from './toast.js';
import { getHiddenColumns, CONFIGURABLE_COLUMNS } from './columnSettings.js';

let sortField = 'id';
let sortDirection = 'asc';
let currentPage = 1;
const pageSize = 20;

const tbody = document.getElementById('employeeTableBody');
const emptyMessage = document.getElementById('emptyMessage');
const searchInput = document.getElementById('searchInput');
const tableHeadRow = document.getElementById('tableHeadRow');
const actionsHeader = document.getElementById('actionsHeader');

// Рендер значения ячейки для каждой настраиваемой колонки — переиспользуется и в <td>, и нигде больше.
const COLUMN_CELL_RENDERERS = {
    lastName: (emp) => escapeHtml(emp.lastName),
    firstName: (emp) => escapeHtml(emp.firstName),
    middleName: (emp) => escapeHtml(emp.middleName || '—'),
    email: (emp) => escapeHtml(emp.email),
    phone: (emp) => escapeHtml(emp.phone),
    whatsapp: (emp) => escapeHtml(emp.whatsapp || '—'),
    telegram: (emp) => escapeHtml(emp.telegram || '—'),
    position: (emp) => escapeHtml(emp.position || '—'),
    department: (emp) => escapeHtml(emp.department || '—'),
    managerName: (emp) => escapeHtml(emp.managerName || '—'),
    hireDate: (emp) => (emp.hireDate ? formatDate(emp.hireDate) : '—'),
    status: (emp) => {
        const statusClass = emp.status === 'active' ? 'status-active' : 'status-inactive';
        const statusText = emp.status === 'active' ? 'Активен' : 'Неактивен';
        return `<span class="status-badge ${statusClass}">${statusText}</span>`;
    }
};

function rebuildTableHead(visibleColumns) {
    tableHeadRow.querySelectorAll('th[data-dynamic-column]').forEach((th) => th.remove());
    visibleColumns.forEach((col) => {
        const th = document.createElement('th');
        th.dataset.field = col.key;
        th.dataset.dynamicColumn = 'true';
        th.textContent = col.label;
        tableHeadRow.insertBefore(th, actionsHeader);
    });
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
    const visibleColumns = CONFIGURABLE_COLUMNS.filter((col) => !hiddenColumns.has(col.key));
    rebuildTableHead(visibleColumns);

    // Колонка, по которой шла сортировка, скрыта — откатываем на дефолтную (по id)
    if (sortField !== 'id' && !visibleColumns.some((col) => col.key === sortField)) {
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

    // Генерация строк с чекбоксами
    let html = '';
    pageItems.forEach(emp => {
        const idFormatted = String(emp.id).padStart(4, '0');
        const dataCells = visibleColumns.map((col) => `<td>${COLUMN_CELL_RENDERERS[col.key](emp)}</td>`).join('');
        html += `
            <tr>
                <td><input type="checkbox" class="row-checkbox" data-id="${emp.id}"></td>
                <td>${idFormatted}</td>
                ${dataCells}
                <td>
                    <button class="action-btn btn-edit" data-id="${emp.id}" aria-label="Редактировать"><i class="fas fa-pencil-alt" aria-hidden="true"></i></button>
                    <button class="action-btn btn-delete" data-id="${emp.id}" aria-label="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // Обновляем индикатор сортировки
    document.querySelectorAll('thead th[data-field]').forEach(th => {
        const field = th.dataset.field;
        const icon = th.querySelector('.sort-icon');
        if (field === sortField) {
            if (!icon) {
                const span = document.createElement('span');
                span.className = 'sort-icon';
                span.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼';
                th.appendChild(span);
            } else {
                icon.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼';
            }
        } else {
            if (icon) icon.remove();
        }
    });

    updateSelectedCount();
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
            showDeleteConfirm(id);
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
