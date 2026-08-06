// --- mainApp.js: главная страница-хаб — точка входа приложения, вкладка "Реквизиты" ---
// Банковские счета/налоги привязаны к organization_id — пока организация не создана,
// секции скрыты (нечего привязывать), см. renderLockedNote().

import { initConfirmModal, confirmAction } from './mainConfirm.js';
import { showToast } from './mainToast.js';
import {
    fetchOrganization, createOrganization, updateOrganization,
    createBankAccount, updateBankAccount, deleteBankAccount,
    createTax, updateTax, deleteTax
} from './mainStorage.js';
import { renderOrganizationForm, renderRecordsSection, BANK_ACCOUNT_FIELDS, TAX_FIELDS } from './mainRequisites.js';

const orgFormContainer = document.getElementById('mOrgFormContainer');
const bankAccountsContainer = document.getElementById('mBankAccountsContainer');
const taxesContainer = document.getElementById('mTaxesContainer');
const lockedNote = document.getElementById('mSubRecordsLockedNote');

let organization = null;
const bankUiState = { adding: false, editingId: null };
const taxUiState = { adding: false, editingId: null };

function renderOrg() {
    renderOrganizationForm(orgFormContainer, organization, { onSave: handleOrgSave });
}

function renderSubRecordsVisibility() {
    const hasOrg = organization !== null;
    lockedNote.hidden = hasOrg;
    bankAccountsContainer.hidden = !hasOrg;
    taxesContainer.hidden = !hasOrg;
}

function renderBankAccounts() {
    if (organization === null) return;
    renderRecordsSection(bankAccountsContainer, {
        title: 'Банковские счета',
        records: organization.bankAccounts,
        fields: BANK_ACCOUNT_FIELDS,
        uiState: bankUiState,
        idPrefix: 'mBank',
        emptyText: 'Пока нет добавленных счетов.',
        addButtonLabel: '+ Добавить счёт',
        handlers: {
            onAddStart: () => { bankUiState.adding = true; renderBankAccounts(); },
            onAddCancel: () => { bankUiState.adding = false; renderBankAccounts(); },
            onCreate: (data) => handleBankCreate(data),
            onEditStart: (id) => { bankUiState.editingId = id; renderBankAccounts(); },
            onEditCancel: () => { bankUiState.editingId = null; renderBankAccounts(); },
            onSave: (record, data) => handleBankSave(record, data),
            onDelete: (id) => handleBankDelete(id)
        }
    });
}

function renderTaxes() {
    if (organization === null) return;
    renderRecordsSection(taxesContainer, {
        title: 'Налоги',
        records: organization.taxes,
        fields: TAX_FIELDS,
        uiState: taxUiState,
        idPrefix: 'mTax',
        emptyText: 'Пока нет добавленных налоговых записей.',
        addButtonLabel: '+ Добавить налог',
        handlers: {
            onAddStart: () => { taxUiState.adding = true; renderTaxes(); },
            onAddCancel: () => { taxUiState.adding = false; renderTaxes(); },
            onCreate: (data) => handleTaxCreate(data),
            onEditStart: (id) => { taxUiState.editingId = id; renderTaxes(); },
            onEditCancel: () => { taxUiState.editingId = null; renderTaxes(); },
            onSave: (record, data) => handleTaxSave(record, data),
            onDelete: (id) => handleTaxDelete(id)
        }
    });
}

function renderAll() {
    renderOrg();
    renderSubRecordsVisibility();
    renderBankAccounts();
    renderTaxes();
}

async function handleOrgSave(data) {
    try {
        if (organization === null) {
            organization = await createOrganization(data);
            showToast('Организация создана', 'success');
        } else {
            const updated = await updateOrganization(organization.id, data);
            organization = { ...organization, ...updated };
            showToast('Изменения сохранены', 'success');
        }
        renderAll();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleBankCreate(data) {
    try {
        const created = await createBankAccount(organization.id, data);
        organization.bankAccounts.push(created);
        bankUiState.adding = false;
        showToast('Счёт добавлен', 'success');
        renderBankAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleBankSave(record, data) {
    try {
        const updated = await updateBankAccount(organization.id, record.id, data);
        organization.bankAccounts = organization.bankAccounts.map((r) => (r.id === record.id ? updated : r));
        bankUiState.editingId = null;
        showToast('Изменения сохранены', 'success');
        renderBankAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleBankDelete(id) {
    const ok = await confirmAction('Удалить этот банковский счёт?');
    if (!ok) return;
    try {
        await deleteBankAccount(organization.id, id);
        organization.bankAccounts = organization.bankAccounts.filter((r) => r.id !== id);
        showToast('Счёт удалён', 'success');
        renderBankAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleTaxCreate(data) {
    try {
        const created = await createTax(organization.id, data);
        organization.taxes.push(created);
        taxUiState.adding = false;
        showToast('Налоговая запись добавлена', 'success');
        renderTaxes();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleTaxSave(record, data) {
    try {
        const updated = await updateTax(organization.id, record.id, data);
        organization.taxes = organization.taxes.map((r) => (r.id === record.id ? updated : r));
        taxUiState.editingId = null;
        showToast('Изменения сохранены', 'success');
        renderTaxes();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function handleTaxDelete(id) {
    const ok = await confirmAction('Удалить эту налоговую запись?');
    if (!ok) return;
    try {
        await deleteTax(organization.id, id);
        organization.taxes = organization.taxes.filter((r) => r.id !== id);
        showToast('Налоговая запись удалена', 'success');
        renderTaxes();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function init() {
    initConfirmModal();
    try {
        organization = await fetchOrganization();
    } catch (err) {
        showToast(err.message, 'error');
    }
    renderAll();
}

init();
