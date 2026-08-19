// --- mainApp.js: раздел «Реквизиты» -----------------------------------------
//
// КОНТРАКТ РАЗДЕЛА:
//     export async function mount(container, ctx)
//     export function unmount()
//
// ПЕРЕДЕЛАН 19.08.2026 ПО МАКЕТУ. Было: одиннадцать полей ввода, открытых на
// правку всегда. Стало: режим чтения по умолчанию, правка по кнопке с липкой
// полосой сохранения, а счета, налоги и бланк письма правятся своими окнами.
//
// ЧТО ЭТО МЕНЯЕТ ПО СУЩЕСТВУ, а не по виду:
//
// 1. Правка стала НАМЕРЕННОЙ. Открытая форма принимает случайный ввод молча;
//    полоса внизу говорит, сколько полей изменено, и прямо предупреждает, что
//    до сохранения в документы уходит прежняя версия.
// 2. Отмена стала возможной. Раньше отменить набранное можно было только
//    перезагрузкой панели: черновика не существовало, ввод шёл сразу в поля.
// 3. Значение можно скопировать. ИНН, КПП и ОГРН переносят в чужие формы
//    руками чаще, чем правят.
//
// Три правила переноса, которые остаются в силе: нет обращений к document,
// нет глобальных id, состояние сбрасывается при каждом монтировании.

import { createStorage } from './mainStorage.js';
import {
    renderOrganization, makeDraft, countChanges, validateDraft, fieldsWord, ORG_FIELDS
} from './mainRequisites.js';
import { renderAccounts, renderTaxes, renderLetterhead, defaultLetterhead, defaultSignature } from './mainLetterhead.js';
import { validateFields } from './mainValidation.js';
import { BANK_ACCOUNT_FIELD_VALIDATORS } from './mainValidation.js';
// Путь АБСОЛЮТНЫЙ: физическая структура папок не совпадает с адресами —
// Backend/Shell/ монтируется в корень «/».
import { isAbort } from '/api.js';

let root = null;
let shell = null;
let storage = null;
let nodes = null;

// Номер монтирования: панель закрывают и открывают заново, а ответ на запрос,
// ушедший до закрытия, приходит после.
let generation = 0;

let organization = null;
let editing = false;
let draft = {};
let errors = {};
let editingAccountId = null;
let editingTaxId = null;

export async function mount(container, ctx) {
    const my = ++generation;
    root = container;
    shell = ctx;
    storage = createStorage(ctx.api);

    const $ = (role) => container.querySelector(`[data-role="${role}"]`);
    nodes = {
        orgName: $('org-name'),
        pageActs: $('page-acts'),
        orgCol: $('org-col'),
        asideCol: $('aside-col'),
        editHint: $('edit-hint'),
        lockedNote: $('locked-note'),
        accountsSec: $('accounts-sec'),
        accountsBody: $('accounts-body'),
        taxesSec: $('taxes-sec'),
        taxesBody: $('taxes-body'),
        letterheadSec: $('letterhead-sec'),
        letterheadBody: $('letterhead-body'),
        secondOrg: $('second-org'),
        saveBar: $('save-bar'),
        saveNote: $('save-note'),
        accountModal: $('account-modal'),
        accountForm: $('account-form'),
        accountTitle: $('account-title'),
        taxModal: $('tax-modal'),
        taxForm: $('tax-form'),
        taxTitle: $('tax-title'),
        letterheadModal: $('letterhead-modal'),
        letterheadForm: $('letterhead-form')
    };

    organization = null;
    editing = false;
    draft = {};
    errors = {};
    editingAccountId = null;
    editingTaxId = null;

    bindEvents(container);

    try {
        const data = await storage.fetchOrganization();
        if (my !== generation) return;
        organization = data;
    } catch (err) {
        if (my !== generation) return;
        if (isAbort(err)) return;
        ctx.toast(err.message, 'error');
    }

    if (my !== generation || root !== container) return;
    renderAll();
}

export function unmount() {
    generation += 1;
    root = null;
    shell = null;
    storage = null;
    nodes = null;
    organization = null;
    editing = false;
    draft = {};
    errors = {};
    editingAccountId = null;
    editingTaxId = null;
}

// ---------------------------------------------------------------- события
//
// Один слушатель на контейнер вместо слушателя на каждую кнопку: содержимое
// колонок перерисовывается целиком, и слушатели на узлах пришлось бы вешать
// заново после каждой отрисовки — привычный источник «кнопка работает через
// раз» и утечки слушателей.

function bindEvents(container) {
    container.addEventListener('click', onClick);
    container.addEventListener('input', onInput);
    container.addEventListener('submit', onSubmit);
}

function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn || !nodes) return;
    const role = btn.dataset.role;

    if (role === 'edit-start') return startEdit();
    if (role === 'edit-cancel') return cancelEdit();
    if (role === 'edit-save') return saveOrganization();
    if (role === 'account-add') return openAccountModal(null);
    if (role === 'tax-add') return openTaxModal(null);
    if (role === 'letterhead-edit') return openLetterheadModal();
    if (role === 'org-add') return shell.toast('Добавление второй организации — отдельный сценарий, он ещё не сделан');
    if (role === 'account-close' || role === 'account-cancel') return closeModal(nodes.accountModal);
    if (role === 'tax-close' || role === 'tax-cancel') return closeModal(nodes.taxModal);
    if (role === 'letterhead-close' || role === 'letterhead-cancel') return closeModal(nodes.letterheadModal);

    if (btn.dataset.copy !== undefined) return copyValue(btn);
    if (btn.dataset.accountEdit) return openAccountModal(Number(btn.dataset.accountEdit));
    if (btn.dataset.accountDel) return deleteAccount(Number(btn.dataset.accountDel));
    if (btn.dataset.taxEdit) return openTaxModal(Number(btn.dataset.taxEdit));
    if (btn.dataset.taxDel) return deleteTax(Number(btn.dataset.taxDel));
}

// Ввод в форму организации идёт в ЧЕРНОВИК, а не в объект организации: без
// этого «Отмена» нечего было бы отменять.
function onInput(event) {
    if (!editing) return;
    const field = event.target.dataset.field;
    if (!field || !ORG_FIELDS.some((f) => f.key === field)) return;
    draft[field] = event.target.value;
    updateSaveBar();
}

function onSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (form === nodes.accountForm) return saveAccount();
    if (form === nodes.taxForm) return saveTax();
    if (form === nodes.letterheadForm) return saveLetterhead();
}

// ---------------------------------------------------------------- отрисовка

function renderAll() {
    renderHead();
    renderOrganization(nodes.orgCol, organization, { editing, draft, errors });
    renderAside();
    renderSaveBar();
}

function renderHead() {
    nodes.orgName.textContent = organization ? (organization.name || '') : '';

    if (editing) {
        nodes.pageActs.innerHTML = '<span class="ui-pill ui-pill--warn">Режим правки</span>';
        return;
    }

    // Кнопка «Бланк письма» появляется только когда организация есть: бланк
    // привязан к ней, как счета и налоги.
    nodes.pageActs.innerHTML = `
        ${organization ? '<button type="button" class="ui-btn ui-btn--ghost" data-role="letterhead-edit">Бланк письма</button>' : ''}
        <button type="button" class="ui-btn" data-role="edit-start">
            <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg>${organization ? 'Изменить' : 'Создать организацию'}
        </button>`;
}

function renderAside() {
    const hasOrg = organization !== null;

    nodes.lockedNote.hidden = hasOrg;
    nodes.accountsSec.hidden = !hasOrg;
    nodes.taxesSec.hidden = !hasOrg;
    nodes.letterheadSec.hidden = !hasOrg;
    nodes.secondOrg.hidden = !hasOrg;

    // В режиме правки правая колонка приглушается: она правится своими окнами,
    // и это надо показать, а не объяснять словами задним числом.
    nodes.editHint.hidden = !editing || !hasOrg;
    nodes.asideCol.classList.toggle('is-dim', editing && hasOrg);

    if (!hasOrg) return;
    renderAccounts(nodes.accountsBody, organization.bankAccounts);
    renderTaxes(nodes.taxesBody, organization.taxes);
    renderLetterhead(nodes.letterheadBody, organization);
}

function renderSaveBar() {
    nodes.saveBar.hidden = !editing;
    if (editing) updateSaveBar();
}

function updateSaveBar() {
    const changed = countChanges(organization, draft);
    nodes.saveNote.textContent = changed === 0
        ? 'Пока ничего не изменено.'
        : `Изменено ${changed} ${fieldsWord(changed)}. Пока не сохранили — в документы уходит прежняя версия.`;
}

// ---------------------------------------------------------------- режимы

function startEdit() {
    editing = true;
    draft = makeDraft(organization);
    errors = {};
    renderAll();
    const first = nodes.orgCol.querySelector('.ui-field__control');
    if (first) first.focus();
}

function cancelEdit() {
    editing = false;
    draft = {};
    errors = {};
    renderAll();
}

async function saveOrganization() {
    errors = validateDraft(draft);
    if (Object.keys(errors).length) {
        renderOrganization(nodes.orgCol, organization, { editing, draft, errors });
        shell.toast(Object.values(errors)[0], 'error');
        return;
    }
    if (!String(draft.name || '').trim()) {
        shell.toast('Заполните обязательное поле: Название', 'error');
        return;
    }

    const my = generation;
    const payload = {};
    ORG_FIELDS.forEach((field) => { payload[field.key] = draft[field.key] === '' ? null : draft[field.key]; });

    try {
        if (organization === null) {
            const created = await storage.createOrganization(payload);
            if (!alive(my)) return;
            organization = created;
            shell.toast('Организация создана', 'success');
        } else {
            const updated = await storage.updateOrganization(organization.id, payload);
            if (!alive(my)) return;
            organization = { ...organization, ...updated };
            shell.toast('Изменения сохранены', 'success');
        }
        editing = false;
        draft = {};
        errors = {};
        renderAll();
    } catch (err) {
        fail(my, err);
    }
}

// ---------------------------------------------------------------- окна

function openModal(modal) {
    modal.hidden = false;
    const first = modal.querySelector('.ui-field__control');
    if (first) first.focus();
}

function closeModal(modal) {
    modal.hidden = true;
}

function fillForm(form, values) {
    form.querySelectorAll('[data-field]').forEach((control) => {
        const value = values[control.dataset.field];
        control.value = value === null || value === undefined ? '' : String(value).slice(0, control.type === 'date' ? 10 : undefined);
    });
}

function readForm(form) {
    const data = {};
    form.querySelectorAll('[data-field]').forEach((control) => {
        data[control.dataset.field] = control.value.trim() === '' ? null : control.value.trim();
    });
    return data;
}

function openAccountModal(id) {
    editingAccountId = id;
    const record = id === null ? {} : (organization.bankAccounts || []).find((a) => a.id === id) || {};
    nodes.accountTitle.textContent = id === null ? 'Новый счёт' : 'Банковский счёт';
    fillForm(nodes.accountForm, { currency: '₽', ...record });
    openModal(nodes.accountModal);
}

function openTaxModal(id) {
    editingTaxId = id;
    const record = id === null ? {} : (organization.taxes || []).find((t) => t.id === id) || {};
    nodes.taxTitle.textContent = id === null ? 'Новый налог' : 'Налог';
    fillForm(nodes.taxForm, { periodicity: 'Ежеквартально', ...record });
    openModal(nodes.taxModal);
}

function openLetterheadModal() {
    // В окно подставляется то, что человек видит в карточке: если своего
    // текста нет, там стоит собранный из реквизитов. Пустое окно заставило бы
    // набирать заново то, что уже показано рядом.
    fillForm(nodes.letterheadForm, {
        letterheadHeader: organization.letterheadHeader || defaultLetterhead(organization),
        letterheadSignature: organization.letterheadSignature || defaultSignature(organization)
    });
    openModal(nodes.letterheadModal);
}

// ---------------------------------------------------------------- счета

async function saveAccount() {
    const data = readForm(nodes.accountForm);
    if (!data.bankName) {
        shell.toast('Заполните обязательное поле: Название банка', 'error');
        return;
    }
    const error = validateFields(data, BANK_ACCOUNT_FIELD_VALIDATORS);
    if (error) {
        shell.toast(error, 'error');
        return;
    }

    const my = generation;
    try {
        if (editingAccountId === null) {
            const created = await storage.createBankAccount(organization.id, data);
            if (!alive(my)) return;
            organization.bankAccounts = [...(organization.bankAccounts || []), created];
            shell.toast('Счёт добавлен', 'success');
        } else {
            const updated = await storage.updateBankAccount(organization.id, editingAccountId, data);
            if (!alive(my)) return;
            organization.bankAccounts = organization.bankAccounts.map((a) => (a.id === editingAccountId ? updated : a));
            shell.toast('Изменения сохранены', 'success');
        }
        closeModal(nodes.accountModal);
        renderAside();
    } catch (err) {
        fail(my, err);
    }
}

async function deleteAccount(id) {
    const my = generation;
    const account = (organization.bankAccounts || []).find((a) => a.id === id);
    // Подтверждение называет ПОСЛЕДСТВИЕ и сам объект, а не «этот элемент»:
    // счетов в списке несколько, и они похожи.
    const ok = await shell.confirmDanger({
        title: 'Удалить счёт?',
        message: account
            ? `Счёт ${account.bankName}${account.checkingAccount ? ` ${account.checkingAccount}` : ''} будет удалён из карточки организации.`
            : 'Счёт будет удалён из карточки организации.',
        confirmLabel: 'Удалить'
    });
    if (!ok || !alive(my)) return;

    try {
        await storage.deleteBankAccount(organization.id, id);
        if (!alive(my)) return;
        organization.bankAccounts = organization.bankAccounts.filter((a) => a.id !== id);
        shell.toast('Счёт удалён', 'success');
        renderAside();
    } catch (err) {
        fail(my, err);
    }
}

// ---------------------------------------------------------------- налоги

async function saveTax() {
    const data = readForm(nodes.taxForm);
    if (!data.taxType) {
        shell.toast('Заполните обязательное поле: Вид налога', 'error');
        return;
    }

    const my = generation;
    try {
        if (editingTaxId === null) {
            const created = await storage.createTax(organization.id, data);
            if (!alive(my)) return;
            organization.taxes = [...(organization.taxes || []), created];
            shell.toast('Налоговая запись добавлена', 'success');
        } else {
            const updated = await storage.updateTax(organization.id, editingTaxId, data);
            if (!alive(my)) return;
            organization.taxes = organization.taxes.map((t) => (t.id === editingTaxId ? updated : t));
            shell.toast('Изменения сохранены', 'success');
        }
        closeModal(nodes.taxModal);
        renderAside();
    } catch (err) {
        fail(my, err);
    }
}

async function deleteTax(id) {
    const my = generation;
    const tax = (organization.taxes || []).find((t) => t.id === id);
    const ok = await shell.confirmDanger({
        title: 'Удалить налоговую запись?',
        message: tax
            ? `Запись «${tax.taxType}» будет удалена из карточки организации.`
            : 'Запись будет удалена из карточки организации.',
        confirmLabel: 'Удалить'
    });
    if (!ok || !alive(my)) return;

    try {
        await storage.deleteTax(organization.id, id);
        if (!alive(my)) return;
        organization.taxes = organization.taxes.filter((t) => t.id !== id);
        shell.toast('Налоговая запись удалена', 'success');
        renderAside();
    } catch (err) {
        fail(my, err);
    }
}

// ---------------------------------------------------------------- бланк

async function saveLetterhead() {
    const data = readForm(nodes.letterheadForm);
    const my = generation;
    try {
        // ПОЛНЫЙ набор полей, а не только два своих. PUT организации — полная
        // замена (тот же контракт, что у сотрудников): непереданное поле
        // становится NULL. Отправив здесь одну шапку, окно бланка обнулило бы
        // ИНН, адрес и всё остальное. Сейчас это ловится проверкой «Название
        // обязательно» на сервере и кончается отказом, но полагаться на то,
        // что чужая проверка прикроет наш неполный запрос, нельзя.
        const updated = await storage.updateOrganization(organization.id, orgPayload({
            letterheadHeader: data.letterheadHeader,
            letterheadSignature: data.letterheadSignature
        }));
        if (!alive(my)) return;
        organization = { ...organization, ...updated };
        closeModal(nodes.letterheadModal);
        shell.toast('Бланк сохранён', 'success');
        renderAside();
    } catch (err) {
        fail(my, err);
    }
}

// Полный набор полей организации с точечной заменой. Нужен всем, кто правит
// организацию не целиком: PUT заменяет запись целиком.
function orgPayload(overrides = {}) {
    const payload = {};
    ORG_FIELDS.forEach((field) => {
        const value = organization ? organization[field.key] : null;
        payload[field.key] = value === undefined ? null : value;
    });
    payload.letterheadHeader = organization ? organization.letterheadHeader ?? null : null;
    payload.letterheadSignature = organization ? organization.letterheadSignature ?? null : null;
    return { ...payload, ...overrides };
}

// ---------------------------------------------------------------- копирование

async function copyValue(btn) {
    const value = btn.dataset.copy;
    try {
        await navigator.clipboard.writeText(value);
        shell.toast(`${btn.dataset.label} скопирован`, 'success');
    } catch (e) {
        // Буфер обмена недоступен без защищённого соединения и без разрешения.
        // Молчать нельзя: человек нажал и ждёт результата.
        shell.toast('Браузер не дал доступ к буферу обмена', 'error');
    }
}

// ---------------------------------------------------------------- служебное

function alive(mountId) {
    return root !== null && nodes !== null && mountId === generation;
}

function fail(mountId, err) {
    if (isAbort(err) || !alive(mountId)) return;
    shell.toast(err.message, 'error');
}
