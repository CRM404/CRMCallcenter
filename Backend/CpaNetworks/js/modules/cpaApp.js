// --- cpaApp.js: страница "CPA-сети" — справочник партнёров, которым организация
// передаёт лиды дальше. Обычный список + модалка (паттерн Employees), а не
// инлайн-карточки, как в "Реквизиты" (там другой случай — вложенные под-сущности
// одной организации).

import { initHubNav } from './cpaNav.js';
import { showToast } from './cpaToast.js';
import { initConfirmModal, confirmAction } from './cpaConfirm.js';
import { fetchCpaNetworks, createCpaNetwork, updateCpaNetwork, deleteCpaNetwork, fetchOrganization } from './cpaStorage.js';

const STATUS_BADGE_CLASS = {
    'Активна': 'status-active',
    'Приостановлена': 'status-paused',
    'Отключена': 'status-disabled'
};

const addBtn = document.getElementById('cpaAddBtn');
const lockedNote = document.getElementById('cpaLockedNote');
const tableWrapper = document.getElementById('cpaTableWrapper');
const tableBody = document.getElementById('cpaTableBody');
const emptyMessage = document.getElementById('cpaEmptyMessage');

const modal = document.getElementById('cpaModal');
const modalTitle = document.getElementById('cpaModalTitle');
const form = document.getElementById('cpaForm');
const closeBtn = document.getElementById('cpaModalCloseBtn');
const cancelBtn = document.getElementById('cpaModalCancelBtn');

const nameInput = document.getElementById('cpaName');
const organizationSelect = document.getElementById('cpaOrganizationId');
const statusSelect = document.getElementById('cpaStatus');
const connectedAtInput = document.getElementById('cpaConnectedAt');
const payoutCurrencyInput = document.getElementById('cpaPayoutCurrency');
const commissionPercentInput = document.getElementById('cpaCommissionPercent');

let cpaNetworks = [];
let organization = null;
let editingId = null;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function renderTable() {
    const hasOrganization = organization !== null;
    lockedNote.hidden = hasOrganization;
    addBtn.disabled = !hasOrganization;
    tableWrapper.hidden = !hasOrganization || cpaNetworks.length === 0;
    emptyMessage.hidden = !hasOrganization || cpaNetworks.length > 0;

    if (!hasOrganization) {
        tableBody.innerHTML = '';
        return;
    }

    tableBody.innerHTML = cpaNetworks.map((c) => `
        <tr data-id="${c.id}">
            <td>${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.organizationName) || '—'}</td>
            <td><span class="status-badge ${STATUS_BADGE_CLASS[c.status] || ''}">${escapeHtml(c.status)}</span></td>
            <td>${formatDate(c.connectedAt) || '—'}</td>
            <td>${escapeHtml(c.payoutCurrency) || '—'}</td>
            <td>${c.commissionPercent !== null && c.commissionPercent !== undefined ? escapeHtml(c.commissionPercent) + '%' : '—'}</td>
            <td>
                <button type="button" class="action-btn btn-edit" data-id="${c.id}" aria-label="Редактировать" title="Изменить"><i class="fas fa-pencil-alt" aria-hidden="true"></i></button>
                <button type="button" class="action-btn btn-delete" data-id="${c.id}" aria-label="Удалить" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </td>
        </tr>
    `).join('');

    tableBody.querySelectorAll('.btn-edit').forEach((btn) => {
        btn.addEventListener('click', () => openEditModal(Number(btn.dataset.id)));
    });
    tableBody.querySelectorAll('.btn-delete').forEach((btn) => {
        btn.addEventListener('click', () => handleDelete(Number(btn.dataset.id)));
    });
}

function populateOrganizationSelect() {
    organizationSelect.innerHTML = '<option value="">— Выберите организацию —</option>';
    if (organization) {
        const opt = document.createElement('option');
        opt.value = organization.id;
        opt.textContent = organization.name;
        organizationSelect.appendChild(opt);
    }
}

function openCreateModal() {
    editingId = null;
    modalTitle.textContent = 'Новая CPA-сеть';
    form.reset();
    // "Юрлицо" остаётся на placeholder-опции даже когда доступна только одна
    // организация — привязка всегда явная, не автоматическая (dialog.md, п.3).
    organizationSelect.value = '';
    statusSelect.value = 'Активна';
    modal.hidden = false;
    nameInput.focus();
}

function openEditModal(id) {
    const record = cpaNetworks.find((c) => c.id === id);
    if (!record) return;
    editingId = id;
    modalTitle.textContent = 'Изменить CPA-сеть';
    nameInput.value = record.name || '';
    organizationSelect.value = record.organizationId != null ? String(record.organizationId) : '';
    statusSelect.value = record.status || 'Активна';
    connectedAtInput.value = record.connectedAt || '';
    payoutCurrencyInput.value = record.payoutCurrency || '';
    commissionPercentInput.value = record.commissionPercent ?? '';
    modal.hidden = false;
    nameInput.focus();
}

function closeModal() {
    modal.hidden = true;
    editingId = null;
}

// Валидация на фронте — то же, что бэк (routes/cpaNetworks.js), для мгновенной
// обратной связи; бэк — источник истины (можно постучаться в API напрямую).
function validateForm(data) {
    if (!data.name || !data.name.trim()) return 'Заполните обязательное поле: Название';
    if (!data.organizationId) return 'Заполните обязательное поле: Юрлицо';
    if (data.commissionPercent !== '') {
        const n = Number(data.commissionPercent);
        if (!Number.isFinite(n) || n < 0 || n > 100) return 'Комиссия должна быть числом от 0 до 100';
    }
    return null;
}

async function handleFormSubmit(e) {
    e.preventDefault();
    const data = {
        name: nameInput.value.trim(),
        organizationId: organizationSelect.value ? Number(organizationSelect.value) : null,
        status: statusSelect.value,
        connectedAt: connectedAtInput.value,
        payoutCurrency: payoutCurrencyInput.value,
        commissionPercent: commissionPercentInput.value
    };
    const error = validateForm(data);
    if (error) {
        showToast(error, 'error');
        return;
    }
    try {
        if (editingId === null) {
            await createCpaNetwork(data);
            showToast('CPA-сеть добавлена', 'success');
        } else {
            await updateCpaNetwork(editingId, data);
            showToast('Изменения сохранены', 'success');
        }
        closeModal();
        await loadCpaNetworks();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleDelete(id) {
    const record = cpaNetworks.find((c) => c.id === id);
    const ok = await confirmAction(`Удалить CPA-сеть «${record ? record.name : ''}»?`);
    if (!ok) return;
    try {
        await deleteCpaNetwork(id);
        showToast('CPA-сеть удалена', 'success');
        await loadCpaNetworks();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function loadCpaNetworks() {
    try {
        cpaNetworks = await fetchCpaNetworks();
    } catch (err) {
        showToast(err.message, 'error');
        cpaNetworks = [];
    }
    renderTable();
}

async function init() {
    initHubNav('cpa');
    initConfirmModal();

    addBtn.addEventListener('click', openCreateModal);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    form.addEventListener('submit', handleFormSubmit);

    try {
        organization = await fetchOrganization();
    } catch (err) {
        showToast(err.message, 'error');
    }
    populateOrganizationSelect();
    await loadCpaNetworks();
}

init();
