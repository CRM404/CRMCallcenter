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
import { openModal } from '/ui/modal.js';
import { findFieldError } from './mainValidation.js';
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
        // Панель нужна окнам: затемнение накрывает свою панель, а не весь
        // экран, — иначе непонятно, к какой из двух открытых панелей окно
        // относится.
        panel: container.closest('.shell-panel'),
        accountTpl: $('account-tpl'),
        taxTpl: $('tax-tpl'),
        letterheadTpl: $('letterhead-tpl')
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

// Форма организации отправляется Enter'ом и в режиме правки — перехватываем,
// чтобы браузер не перезагрузил страницу. Окна раздела своих форм больше не
// держат: их отправляет кнопка подвала окна слоя.
function onSubmit(event) {
    event.preventDefault();
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

/**
 * Окно раздела = окно СЛОЯ с полями из шаблона (К25).
 *
 * Раньше три окна были объявлены разметкой целиком, и вместе с разметкой
 * приходилось бы писать своё поведение — чего никто не сделал: Esc не
 * закрывал, щелчок по затемнению не закрывал, Tab уходил из окна в страницу
 * под затемнением, фокус после закрытия падал в BODY. Теперь всё это даёт
 * слой, а раздел отвечает только за поля и за то, что с ними делать.
 *
 * @param {Object} opts { tpl, title, sub, size, values, save }
 *        save(body) → false, если окно закрывать нельзя (ошибка в полях).
 */
function openFormModal({ tpl, title, sub, size, values, save }) {
    const body = document.createElement('div');
    body.appendChild(tpl.content.cloneNode(true));

    const modal = openModal({
        title,
        sub,
        body,
        scope: nodes.panel,
        size,
        actions: [
            { label: 'Отмена', variant: 'ghost', value: false },
            { label: 'Сохранить', onClick: () => save(body) }
        ]
    });

    fillForm(body, values);

    // Фокус — в ПЕРВОЕ ПОЛЕ, а не на крестик. Слой по умолчанию берёт первый
    // фокусируемый элемент коробки, а это кнопка закрытия: она стоит выше по
    // разметке. Для окна-формы это неверно — паспорт обещает поле, и человек,
    // открывший окно, начинает печатать.
    const firstControl = body.querySelector('.ui-field__control');
    if (firstControl) firstControl.focus();

    // Enter в поле отправляет форму — это давала разметочная <form>, и терять
    // привычку из-за переезда незачем. В многострочном поле Enter остаётся
    // переводом строки.
    body.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.target.tagName === 'TEXTAREA') return;
        event.preventDefault();
        const saveBtn = modal.box.querySelectorAll('.ui-modal__actions .ui-btn')[1];
        if (saveBtn && !saveBtn.disabled) saveBtn.click();
    });

    return modal;
}

/**
 * Ошибка в окне: поле краснеет, под полем подсказка, и первая ошибка
 * дополнительно уходит тостом (К26). До этого окна отвечали ТОЛЬКО тостом —
 * он говорил «БИК должен содержать 9 цифр» и исчезал, а какое из шести полей
 * виновато, человек искал глазами.
 *
 * Механизм тот же, что у формы организации (mainRequisites.js): класс `is-bad`
 * на обёртке поля и `.m-hint-bad` под ним.
 */
function showFieldError(form, key, message) {
    const control = form.querySelector(`[data-field="${key}"]`);
    if (!control) return;
    const field = control.closest('.ui-field');
    if (!field) return;
    field.classList.add('is-bad');
    let hint = field.querySelector('.m-hint-bad');
    if (!hint) {
        hint = document.createElement('span');
        hint.className = 'ui-field__hint m-hint-bad';
        field.appendChild(hint);
    }
    hint.textContent = message;
    control.focus();
}

/** Снять прошлые ошибки — иначе исправленное поле остаётся красным. */
function clearFieldErrors(form) {
    form.querySelectorAll('.ui-field.is-bad').forEach((field) => field.classList.remove('is-bad'));
    form.querySelectorAll('.m-hint-bad').forEach((hint) => hint.remove());
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
    openFormModal({
        tpl: nodes.accountTpl,
        title: id === null ? 'Новый счёт' : 'Банковский счёт',
        values: { currency: '₽', ...record },
        save: saveAccount
    });
}

function openTaxModal(id) {
    editingTaxId = id;
    const record = id === null ? {} : (organization.taxes || []).find((t) => t.id === id) || {};
    openFormModal({
        tpl: nodes.taxTpl,
        title: id === null ? 'Новый налог' : 'Налог',
        values: { periodicity: 'Ежеквартально', ...record },
        save: saveTax
    });
}

function openLetterheadModal() {
    // В окно подставляется то, что человек видит в карточке: если своего
    // текста нет, там стоит собранный из реквизитов. Пустое окно заставило бы
    // набирать заново то, что уже показано рядом.
    openFormModal({
        tpl: nodes.letterheadTpl,
        title: 'Бланк письма',
        sub: 'подставляется в документы',
        values: {
            letterheadHeader: organization.letterheadHeader || defaultLetterhead(organization),
            letterheadSignature: organization.letterheadSignature || defaultSignature(organization)
        },
        save: saveLetterhead
    });
}

// ---------------------------------------------------------------- счета

/**
 * Возвращает false, когда окно закрывать НЕЛЬЗЯ: не заполнено обязательное
 * поле, не сошёлся формат или отказал сервер. Это язык кнопок слоя — false
 * оставляет окно открытым и разблокирует кнопку, чтобы набранное не пропало
 * вместе с окном.
 */
async function saveAccount(form) {
    const data = readForm(form);
    clearFieldErrors(form);
    if (!data.bankName) {
        showFieldError(form, 'bankName', 'Без названия банка счёт не опознать');
        shell.toast('Заполните обязательное поле: Название банка', 'error');
        return false;
    }
    const bad = findFieldError(data, BANK_ACCOUNT_FIELD_VALIDATORS);
    if (bad) {
        showFieldError(form, bad.key, bad.message);
        shell.toast(bad.message, 'error');
        return false;
    }

    const my = generation;
    try {
        if (editingAccountId === null) {
            const created = await storage.createBankAccount(organization.id, data);
            if (!alive(my)) return true;
            organization.bankAccounts = [...(organization.bankAccounts || []), created];
            shell.toast('Счёт добавлен', 'success');
        } else {
            const updated = await storage.updateBankAccount(organization.id, editingAccountId, data);
            if (!alive(my)) return true;
            organization.bankAccounts = organization.bankAccounts.map((a) => (a.id === editingAccountId ? updated : a));
            shell.toast('Изменения сохранены', 'success');
        }
        renderAside();
        return true;
    } catch (err) {
        fail(my, err);
        // Окно остаётся открытым: набранное человеком не должно пропадать
        // из-за отказа сервера.
        return false;
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

async function saveTax(form) {
    const data = readForm(form);
    clearFieldErrors(form);
    if (!data.taxType) {
        showFieldError(form, 'taxType', 'Без вида налога запись ничего не значит');
        shell.toast('Заполните обязательное поле: Вид налога', 'error');
        return false;
    }

    const my = generation;
    try {
        if (editingTaxId === null) {
            const created = await storage.createTax(organization.id, data);
            if (!alive(my)) return true;
            organization.taxes = [...(organization.taxes || []), created];
            shell.toast('Налоговая запись добавлена', 'success');
        } else {
            const updated = await storage.updateTax(organization.id, editingTaxId, data);
            if (!alive(my)) return true;
            organization.taxes = organization.taxes.map((t) => (t.id === editingTaxId ? updated : t));
            shell.toast('Изменения сохранены', 'success');
        }
        renderAside();
        return true;
    } catch (err) {
        fail(my, err);
        return false;
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

async function saveLetterhead(form) {
    const data = readForm(form);
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
        if (!alive(my)) return true;
        organization = { ...organization, ...updated };
        shell.toast('Бланк сохранён', 'success');
        renderAside();
        return true;
    } catch (err) {
        fail(my, err);
        return false;
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
