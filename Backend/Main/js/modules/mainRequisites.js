// --- mainRequisites.js: раздел "Реквизиты" — форма организации (подсекции) +
// инлайн-списки банковских счетов и налогов (тот же паттерн карточек, что
// возражения в scriptsAdminNodes.js: список + "+ Добавить" + Изменить/Удалить
// на каждой карточке, без модалок). DATE-колонки БД (см. db.js — глобальный
// type parser 1082) приходят строкой 'YYYY-MM-DD', поэтому значение можно
// класть в <input type="date"> напрямую, без пересчёта.

import { showToast } from './mainToast.js';
import { ORG_FIELD_VALIDATORS, validateFields } from './mainValidation.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// "Общие данные" — фиксированная сетка (не auto-fill, см. dialog.md п.3): Название
// на одном уровне с остальными короткими полями (не отдельной строкой, см. п.2),
// ОПФ — короткая подпись + узкий инпут (значения вида "ООО"/"ИП"), Юридический
// адрес — осознанно full-width отдельной строкой (длинное поле).
const ORG_GENERAL_FIELDS = [
    { key: 'name', label: 'Название', type: 'text', required: true },
    { key: 'legalForm', label: 'ОПФ', type: 'text', narrow: true },
    { key: 'generalDirector', label: 'Генеральный директор', type: 'text' },
    { key: 'registrationCountry', label: 'Страна регистрации', type: 'text' },
    { key: 'registrationDate', label: 'Дата регистрации', type: 'date' },
    { key: 'legalAddress', label: 'Юридический адрес', type: 'text', fullWidth: true }
];

const ORG_LEGAL_FIELDS = [
    { key: 'inn', label: 'ИНН', type: 'text' },
    { key: 'kpp', label: 'КПП', type: 'text' },
    { key: 'ogrn', label: 'ОГРН', type: 'text' },
    { key: 'okved', label: 'ОКВЭД', type: 'text' },
    { key: 'authorizedCapital', label: 'Уставный капитал', type: 'number' }
];

export const BANK_ACCOUNT_FIELDS = [
    { key: 'bankName', label: 'Название банка', type: 'text', required: true },
    { key: 'checkingAccount', label: 'Расчётный счёт', type: 'text' },
    { key: 'correspondentAccount', label: 'Корреспондентский счёт', type: 'text' },
    { key: 'bik', label: 'БИК', type: 'text' },
    { key: 'currency', label: 'Валюта', type: 'text' },
    { key: 'openedAt', label: 'Дата открытия', type: 'date' }
];

// Периодичность — фиксированный список (dialog.md, п.4, отменяет прошлое решение
// "свободный текст"), rate остаётся свободным текстом, это разные поля.
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
    const inputClass = field.narrow ? ' class="m-input-narrow"' : '';
    return `
        <div class="${groupClass}">
            <label for="${idAttr}">${field.label}</label>
            <input type="${field.type}" id="${idAttr}"${inputClass} value="${escapeHtml(value ?? '')}">
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
        ${isNew ? '<div class="m-empty-state">Организация ещё не создана.</div>' : ''}
        <div class="m-org-section">
            <h3>Общие данные</h3>
            <div class="m-org-grid">
                ${ORG_GENERAL_FIELDS.map((f) => renderFieldGroup(f, org[f.key], `mOrg-${f.key}`)).join('')}
            </div>
        </div>
        <div class="m-org-section">
            <h3>Юридические реквизиты</h3>
            <div class="form-grid">
                ${ORG_LEGAL_FIELDS.map((f) => renderFieldGroup(f, org[f.key], `mOrg-${f.key}`)).join('')}
            </div>
        </div>
        <div class="m-actions">
            <button type="button" class="btn btn-primary btn-sm" id="mOrgSaveBtn">${isNew ? 'Создать организацию' : 'Сохранить изменения'}</button>
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

function renderRecordCard(record, fields, editing, idPrefix) {
    if (editing) {
        return `
            <div class="m-record-card" data-id="${record.id}">
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
        <div class="m-record-card" data-id="${record.id}">
            <div class="m-record-fields">
                ${fields.map((f) => `<div class="m-record-field"><span class="m-record-label">${escapeHtml(f.label)}:</span> ${escapeHtml(record[f.key]) || '—'}</div>`).join('')}
            </div>
            <div class="m-actions m-actions-icons">
                <button type="button" class="m-icon-btn" data-action="edit" data-id="${record.id}" title="Изменить" aria-label="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                <button type="button" class="m-icon-btn m-icon-btn-danger" data-action="delete" data-id="${record.id}" title="Удалить" aria-label="Удалить"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
            </div>
        </div>
    `;
}

// Общий рендер для списка "однотипных записей" (банковские счета/налоги) —
// список карточек + "+ Добавить" форма + инлайн-редактирование карточки,
// один и тот же паттерн для обеих сущностей, отличается только набором полей.
// uiState = { adding, editingId }
// handlers = { onAddStart, onAddCancel, onCreate(data), onEditStart(id),
//              onEditCancel, onSave(record, data), onDelete(id) }
export function renderRecordsSection(container, { title, records, fields, uiState, idPrefix, emptyText, addButtonLabel, handlers, validators }) {
    const cards = records.map((r) => renderRecordCard(r, fields, uiState.editingId === r.id, idPrefix)).join('');
    const addForm = uiState.adding ? `
        <div class="m-record-card">
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
        <div class="m-records-header">
            <h3>${title}</h3>
            ${!uiState.adding ? `<button type="button" class="btn btn-secondary btn-sm" id="${idPrefix}AddBtn">${addButtonLabel}</button>` : ''}
        </div>
        ${records.length ? `<div class="m-records-list">${cards}</div>` : `<div class="m-empty-state">${emptyText}</div>`}
        ${addForm}
    `;

    const addBtn = container.querySelector(`#${idPrefix}AddBtn`);
    if (addBtn) addBtn.addEventListener('click', handlers.onAddStart);

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
