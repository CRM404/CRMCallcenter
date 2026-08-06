// --- departments.js: модалка "Управление отделами" (report_2026-08-01.md, п.1)
// Список + инлайн-добавление/редактирование (композиция — Отчёт Дизайн.md,
// раздел "Сотрудники" → "Открыто", п.1, с уточнением из dialog.md: форма — не
// однострочная, а .form-grid на 2 поля, т.к. организаций может быть больше
// одной). Удаление переиспользует общий #deleteModal через
// showDepartmentDeleteConfirm (confirmModal.js).

import { fetchDepartments, createDepartment, updateDepartment, fetchOrganization } from './storage.js';
import { showDepartmentDeleteConfirm } from './confirmModal.js';
import { showToast } from './toast.js';

const departmentsBtn = document.getElementById('departmentsBtn');
const departmentsModal = document.getElementById('departmentsModal');
const departmentsCloseBtn = document.getElementById('departmentsCloseBtn');
const departmentsList = document.getElementById('departmentsList');
const departmentsEmptyMessage = document.getElementById('departmentsEmptyMessage');

let departments = [];
let organization = null;
let activeForm = null; // null | { mode: 'add' } | { mode: 'edit', id }

export function initDepartments() {
    departmentsBtn.addEventListener('click', openDepartmentsModal);
    departmentsCloseBtn.addEventListener('click', closeDepartmentsModal);
    departmentsModal.addEventListener('click', (e) => { if (e.target === departmentsModal) closeDepartmentsModal(); });
}

async function openDepartmentsModal() {
    activeForm = null;
    departmentsModal.style.display = 'flex';
    await loadAndRender();
}

function closeDepartmentsModal() {
    departmentsModal.style.display = 'none';
    activeForm = null;
}

async function loadAndRender() {
    try {
        const [depts, org] = await Promise.all([fetchDepartments(), fetchOrganization()]);
        departments = depts;
        organization = org;
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    renderList();
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

function orgOptionsHtml(selectedId) {
    let html = '<option value="">— Выберите организацию —</option>';
    if (organization) {
        const selected = selectedId != null && String(selectedId) === String(organization.id) ? ' selected' : '';
        html += `<option value="${organization.id}"${selected}>${escapeHtml(organization.name)}</option>`;
    }
    return html;
}

function formRowHtml(current) {
    const name = current ? current.name : '';
    const orgId = current ? current.organizationId : (organization ? organization.id : null);
    return `
        <div class="department-row department-row-form">
            <div class="form-grid" style="margin-bottom: 0;">
                <div class="form-group">
                    <label for="departmentNameInput">Название отдела *</label>
                    <input type="text" id="departmentNameInput" value="${escapeHtml(name)}" placeholder="Отдел продаж" />
                </div>
                <div class="form-group">
                    <label for="departmentOrgSelect">Юрлицо *</label>
                    <select id="departmentOrgSelect">${orgOptionsHtml(orgId)}</select>
                </div>
            </div>
            <div style="display:flex; gap:12px; justify-content:flex-end; margin-top:10px;">
                <button type="button" class="btn btn-secondary btn-sm" id="departmentCancelBtn">Отмена</button>
                <button type="button" class="btn btn-primary btn-sm" id="departmentSaveBtn">Сохранить</button>
            </div>
        </div>
    `;
}

function rowHtml(d) {
    if (activeForm && activeForm.mode === 'edit' && activeForm.id === d.id) {
        return formRowHtml(d);
    }
    return `
        <div class="department-row" data-id="${d.id}">
            <div class="department-row-info">
                <span class="department-row-name">${escapeHtml(d.name)}</span>
                <span class="department-row-org">${escapeHtml(d.organizationName || '—')}</span>
            </div>
            <div class="department-row-actions">
                <button class="action-btn" data-action="edit" data-id="${d.id}" aria-label="Редактировать" title="Редактировать"><i class="fas fa-pencil" aria-hidden="true"></i></button>
                <button class="action-btn btn-delete" data-action="delete" data-id="${d.id}" data-name="${escapeHtml(d.name)}" aria-label="Удалить" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </div>
        </div>
    `;
}

function renderList() {
    const showEmptyMessage = departments.length === 0 && !(activeForm && activeForm.mode === 'add');
    departmentsEmptyMessage.classList.toggle('visible', showEmptyMessage);

    const rowsHtml = departments.map(rowHtml).join('');
    const addRowHtml = activeForm && activeForm.mode === 'add'
        ? formRowHtml(null)
        : `<button type="button" class="department-add-row" id="departmentAddBtn"><i class="fas fa-plus" aria-hidden="true"></i> Добавить отдел</button>`;

    departmentsList.innerHTML = rowsHtml + addRowHtml;

    departmentsList.querySelectorAll('[data-action="edit"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            activeForm = { mode: 'edit', id: Number(btn.dataset.id) };
            renderList();
        });
    });
    departmentsList.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const confirmed = await showDepartmentDeleteConfirm(Number(btn.dataset.id), btn.dataset.name);
            if (confirmed) {
                await loadAndRender();
                showToast('Отдел удалён', 'success');
            }
        });
    });

    const addBtn = document.getElementById('departmentAddBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            activeForm = { mode: 'add' };
            renderList();
        });
    }

    const cancelBtn = document.getElementById('departmentCancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            activeForm = null;
            renderList();
        });
    }

    const saveBtn = document.getElementById('departmentSaveBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', handleSave);
    }
}

async function handleSave() {
    const name = document.getElementById('departmentNameInput').value.trim();
    const organizationId = document.getElementById('departmentOrgSelect').value;

    if (!name) {
        showToast('Заполните обязательное поле: Название', 'error');
        return;
    }
    if (!organizationId) {
        showToast('Заполните обязательное поле: Юрлицо', 'error');
        return;
    }

    const data = { name, organizationId: Number(organizationId) };

    try {
        if (activeForm.mode === 'edit') {
            await updateDepartment(activeForm.id, data);
            showToast('Отдел обновлён', 'success');
        } else {
            await createDepartment(data);
            showToast('Отдел добавлен', 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    activeForm = null;
    await loadAndRender();
}
