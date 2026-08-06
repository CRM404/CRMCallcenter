// --- mainRequisites.js: раздел "Реквизиты" — карточка организации (подсекции)
// + карточки-списки банковских счетов и налогов в виде "строк-карточек"
// (аватар-иконка + заголовок + чип/моноширинные подполя + иконки действий
// в конце строки, паттерн из демо-макета редизайна). DATE-колонки БД (см.
// db.js — глобальный type parser 1082) приходят строкой 'YYYY-MM-DD',
// поэтому значение можно класть в <input type="date"> напрямую, без пересчёта.

import { showToast } from './mainToast.js';
import { ORG_FIELD_VALIDATORS, validateFields } from './mainValidation.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// "Общие данные" — фиксированная сетка (см. m-org-grid в CSS): Название на
// одном уровне с остальными короткими полями, ОПФ — короткая подпись + узкий
// инпут, Юридический адрес — осознанно full-width отдельной строкой.
const ORG_GENERAL_FIELDS = [
    { key: 'name', label: 'Название', type: 'text', required: true },
    { key: 'legalForm', label: 'ОПФ', type: 'text', narrow: true },
    { key: 'generalDirector', label: 'Генеральный директор', type: 'text' },
    { key: 'registrationCountry', label: 'Страна регистрации', type: 'text' },
    { key: 'registrationDate', label: 'Дата регистрации', type: 'date' },
    { key: 'legalAddress', label: 'Юридический адрес', type: 'text', fullWidth: true }
];

// Идентификаторы/числа — моноширинный шрифт с табличными цифрами (mono),
// как в остальных полях-идентификаторах проекта (см. CSS .m-mono).
const ORG_LEGAL_FIELDS = [
    { key: 'inn', label: 'ИНН', type: 'text', mono: true },
    { key: 'kpp', label: 'КПП', type: 'text', mono: true },
    { key: 'ogrn', label: 'ОГРН', type: 'text', mono: true },
    { key: 'okved', label: 'ОКВЭД', type: 'text', mono: true },
    { key: 'authorizedCapital', label: 'Уставный капитал', type: 'number', mono: true }
];

export const BANK_ACCOUNT_FIELDS = [
    { key: 'bankName', label: 'Название банка', type: 'text', required: true },
    { key: 'checkingAccount', label: 'Расчётный счёт', type: 'text', mono: true },
    { key: 'correspondentAccount', label: 'Корреспондентский счёт', type: 'text', mono: true },
    { key: 'bik', label: 'БИК', type: 'text', mono: true },
    { key: 'currency', label: 'Валюта', type: 'text' },
    { key: 'openedAt', label: 'Дата открытия', type: 'date' }
];

// Периодичность — фиксированный список (dialog.md, п.4), rate остаётся
// свободным текстом, это разные поля.
const PERIODICITY_OPTIONS = ['Неделя', 'Месяц', 'Квартал', 'Год'];

export const TAX_FIELDS = [
    { key: 'taxType', label: 'Вид налога', type: 'text', required: true },
    { key: 'rate', label: 'Ставка', type: 'text' },
    { key: 'periodicity', label: 'Периодичность', type: 'select', options: PERIODICITY_OPTIONS }
];

function renderFieldGroup(field, value, idAttr) {
    const groupClass = 'form-group' + (field.fullWidth ? ' m-field-full' : '');
    if (field.type === 'select') {
        const options = field.options.map((opt) =>
            `<option value="${escapeHtml(opt)}"${value === opt ? ' selected' : ''}>${escapeHtml(opt)}</option>`
        ).join('');
        return `
            <div class="${groupClass}">
                <label for="${idAttr}">${field.label}</label>
                <select id="${idAttr}">
                    <option value=""${!value ? ' selected' : ''}>Не указано</option>
                    ${options}
                </select>
            </div>
        `;
    }
    const inputClasses = [field.narrow ? 'm-input-narrow' : '', field.mono ? 'm-mono' : ''].filter(Boolean).join(' ');
    const classAttr = inputClasses ? ` class="${inputClasses}"` : '';
    return `
        <div class="${groupClass}">
            <label for="${idAttr}">${field.label}</label>
            <input type="${field.type}" id="${idAttr}"${classAttr} value="${escapeHtml(value ?? '')}">
        </div>
    `;
}

function readFieldValue(container, idAttr) {
    return container.querySelector(`#${idAttr}`).value;
}

// organization === null — организация ещё не создана: пустая форма + пустой стейт,
// кнопка "Создать организацию" (POST). Иначе — форма предзаполнена, кнопка
// "Сохранить изменения" (PUT) — одна и та же кнопка/обработчик решает, что вызвать.
export function renderOrganizationForm(container, organization, handlers) {
    const isNew = organization === null;
    const org = organization || {};

    container.innerHTML = `
        <div class="m-card-head">
            <div class="m-card-title">
                <span class="m-card-icon"><i class="fas fa-building" aria-hidden="true"></i></span>
                <div>
                    <h2>Организация</h2>
                    <small>Общие и юридические данные компании</small>
                </div>
            </div>
            <button type="button" class="btn btn-primary btn-sm" id="mOrgSaveBtn">${isNew ? 'Создать организацию' : 'Сохранить изменения'}</button>
        </div>
        ${isNew ? '<div class="m-empty-state">Организация ещё не создана.</div>' : ''}
        <div class="m-section">
            <div class="m-section-label">Общие данные</div>
            <div class="m-org-grid">
                ${ORG_GENERAL_FIELDS.map((f) => renderFieldGroup(f, org[f.key], `mOrg-${f.key}`)).join('')}
            </div>
        </div>
        <div class="m-section">
            <div class="m-section-label">Юридические реквизиты</div>
            <div class="m-org-grid">
                ${ORG_LEGAL_FIELDS.map((f) => renderFieldGroup(f, org[f.key], `mOrg-${f.key}`)).join('')}
            </div>
        </div>
    `;

    container.querySelector('#mOrgSaveBtn').addEventListener('click', () => {
        const data = {};
        [...ORG_GENERAL_FIELDS, ...ORG_LEGAL_FIELDS].forEach((f) => {
            data[f.key] = readFieldValue(container, `mOrg-${f.key}`);
        });
        const error = validateFields(data, ORG_FIELD_VALIDATORS);
        if (error) {
            showToast(error, 'error');
            return;
        }
        handlers.onSave(data);
    });
}

// Аватар строки-карточки: для банковского счёта — всегда иконка банка; для
// налога — короткая ставка текстом (как "6%"/"30%" в демо), если она похожа
// на короткое значение, иначе иконка-заглушка.
function renderRowAvatar(record, idPrefix) {
    if (idPrefix === 'mTax') {
        const rate = (record.rate || '').trim();
        if (rate && rate.length <= 5) {
            return `<span class="m-row-avatar m-row-avatar-text">${escapeHtml(rate)}</span>`;
        }
        return '<span class="m-row-avatar"><i class="fas fa-percent" aria-hidden="true"></i></span>';
    }
    return '<span class="m-row-avatar"><i class="fas fa-landmark" aria-hidden="true"></i></span>';
}

function renderRowMain(record, idPrefix) {
    if (idPrefix === 'mTax') {
        return `
            <div class="m-row-main m-row-main-2col">
                <div class="m-row-title">${escapeHtml(record.taxType)}</div>
                ${record.periodicity ? `<div class="m-row-sub"><span class="m-row-sub-lbl">Периодичность</span>${escapeHtml(record.periodicity)}</div>` : ''}
            </div>
        `;
    }
    const chip = record.currency ? `<span class="m-chip">${escapeHtml(record.currency)}</span>` : '';
    return `
        <div class="m-row-main">
            <div>
                <div class="m-row-title">${escapeHtml(record.bankName)}</div>
                ${chip}
            </div>
            ${record.checkingAccount ? `<div class="m-row-sub m-mono"><span class="m-row-sub-lbl">Р/с</span>${escapeHtml(record.checkingAccount)}</div>` : ''}
            ${record.bik ? `<div class="m-row-sub m-mono"><span class="m-row-sub-lbl">БИК</span>${escapeHtml(record.bik)}</div>` : ''}
        </div>
    `;
}

function renderRecordCard(record, fields, editing, idPrefix) {
    if (editing) {
        return `
            <div class="m-record-card m-record-card-editing" data-id="${record.id}">
                <div class="form-grid">
                    ${fields.map((f) => renderFieldGroup(f, record[f.key], `${idPrefix}Edit-${f.key}-${record.id}`)).join('')}
                </div>
                <div class="m-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="save" data-id="${record.id}">Сохранить</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="cancel" data-id="${record.id}">Отмена</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="m-row-card" data-id="${record.id}">
            ${renderRowAvatar(record, idPrefix)}
            ${renderRowMain(record, idPrefix)}
            <div class="m-row-actions">
                <button type="button" class="m-icon-btn" data-action="edit" data-id="${record.id}" title="Изменить" aria-label="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                <button type="button" class="m-icon-btn m-icon-btn-danger" data-action="delete" data-id="${record.id}" title="Удалить" aria-label="Удалить"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
            </div>
        </div>
    `;
}

const CARD_ICONS = { mBank: 'fa-landmark', mTax: 'fa-percent' };

function recordsWord(count, forms) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
    return forms[2];
}

// Общий рендер для списка "однотипных записей" (банковские счета/налоги) —
// карточка с заголовком (иконка + кол-во записей), список строк-карточек,
// пунктирная строка "+ Добавить..." снизу (вместо кнопки в заголовке) и
// инлайн-форма добавления/редактирования записи, по клику на неё/на карандаш.
// uiState = { adding, editingId }
// handlers = { onAddStart, onAddCancel, onCreate(data), onEditStart(id),
//              onEditCancel, onSave(record, data), onDelete(id) }
export function renderRecordsSection(container, { title, records, fields, uiState, idPrefix, emptyText, addButtonLabel, wordForms, handlers, validators }) {
    const cards = records.map((r) => renderRecordCard(r, fields, uiState.editingId === r.id, idPrefix)).join('');
    const countText = records.length && wordForms ? `${records.length} ${recordsWord(records.length, wordForms)}` : '';
    const addForm = uiState.adding ? `
        <div class="m-record-card m-record-card-editing">
            <div class="form-grid">
                ${fields.map((f) => renderFieldGroup(f, '', `${idPrefix}New-${f.key}`)).join('')}
            </div>
            <div class="m-actions">
                <button type="button" class="btn btn-primary btn-sm" id="${idPrefix}CreateBtn">Добавить</button>
                <button type="button" class="btn btn-secondary btn-sm" id="${idPrefix}CreateCancelBtn">Отмена</button>
            </div>
        </div>
    ` : '';

    container.innerHTML = `
        <div class="m-card-head">
            <div class="m-card-title">
                <span class="m-card-icon"><i class="fas ${CARD_ICONS[idPrefix] || 'fa-list'}" aria-hidden="true"></i></span>
                <div><h2>${title}</h2>${countText ? `<small>${countText}</small>` : ''}</div>
            </div>
        </div>
        ${records.length ? `<div class="m-row-list">${cards}</div>` : `<div class="m-empty-state">${emptyText}</div>`}
        ${!uiState.adding ? `
            <div class="m-add-row" id="${idPrefix}AddBtn" role="button" tabindex="0">
                <i class="fas fa-plus" aria-hidden="true"></i>${addButtonLabel}
            </div>
        ` : addForm}
    `;

    const addBtn = container.querySelector(`#${idPrefix}AddBtn`);
    if (addBtn) {
        addBtn.addEventListener('click', handlers.onAddStart);
        addBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onAddStart(); }
        });
    }

    const createBtn = container.querySelector(`#${idPrefix}CreateBtn`);
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            const data = {};
            fields.forEach((f) => {
                data[f.key] = readFieldValue(container, `${idPrefix}New-${f.key}`);
            });
            const error = validateFields(data, validators || {});
            if (error) {
                showToast(error, 'error');
                return;
            }
            handlers.onCreate(data);
        });
        container.querySelector(`#${idPrefix}CreateCancelBtn`).addEventListener('click', handlers.onAddCancel);
    }

    container.querySelectorAll('[data-action="edit"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onEditStart(Number(btn.dataset.id)));
    });
    container.querySelectorAll('[data-action="cancel"]').forEach((btn) => {
        btn.addEventListener('click', handlers.onEditCancel);
    });
    container.querySelectorAll('[data-action="save"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.id);
            const record = records.find((r) => r.id === id);
            const data = {};
            fields.forEach((f) => {
                data[f.key] = readFieldValue(container, `${idPrefix}Edit-${f.key}-${id}`);
            });
            const error = validateFields(data, validators || {});
            if (error) {
                showToast(error, 'error');
                return;
            }
            handlers.onSave(record, data);
        });
    });
    container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onDelete(Number(btn.dataset.id)));
    });
}
