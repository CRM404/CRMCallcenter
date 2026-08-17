// --- mainApp.js: раздел «Реквизиты» ---
//
// Банковские счета и налоги привязаны к organization_id — пока организация не
// создана, секции скрыты (нечего привязывать), см. renderSubRecordsVisibility.
//
// КОНТРАКТ РАЗДЕЛА (первый переведённый на него, образец для остальных пяти):
//
//     export async function mount(container, ctx)  — рисует себя внутрь
//                                                    container, грузит данные
//     export function unmount()                    — снимает состояние
//
// Три правила, из-за которых модуль переписан, а не просто перенесён:
//
// 1. НЕТ ОБРАЩЕНИЙ К document. Раньше шесть узлов брались через
//    getElementById на верхнем уровне модуля — то есть один раз, при импорте.
//    В оболочке модуль импортируется один раз, а монтируется много: ссылки
//    указывали бы на узлы первой панели даже после её закрытия.
//
// 2. НЕТ ГЛОБАЛЬНЫХ id. Поиск по data-role в границах своего контейнера.
//
// 3. СОСТОЯНИЕ СБРАСЫВАЕТСЯ ПРИ КАЖДОМ МОНТИРОВАНИИ. organization и состояния
//    форм лежат на уровне модуля, а модуль общий: без сброса второе открытие
//    раздела показало бы данные, оставшиеся от первого.

import { createStorage } from './mainStorage.js';
import { renderOrganizationForm, renderRecordsSection, BANK_ACCOUNT_FIELDS, TAX_FIELDS } from './mainRequisites.js';
import { renderCompletion, renderPreview } from './mainLetterhead.js';
import { BANK_ACCOUNT_FIELD_VALIDATORS } from './mainValidation.js';
// Путь АБСОЛЮТНЫЙ, а не относительный: физическая структура папок не
// совпадает с адресами. Backend/Shell/ монтируется в корень «/», поэтому
// api.js доступен как /api.js, а «../../../Shell/api.js» указывало бы на
// несуществующий /Shell/api.js.
import { isAbort } from '/api.js';

let root = null;
let shell = null;
let storage = null;
let nodes = null;

// Номер монтирования. Раздел закрывают и открывают заново — а ответ на
// запрос, отправленный ДО закрытия, может прийти уже после. Отмена запросов
// обычно срабатывает раньше, но полагаться только на неё нельзя: гонку
// выигрывает то один, то другой, и проявится это один раз из ста — данными
// прошлой панели, дорисованными в новую.
let generation = 0;

let organization = null;
let bankUiState = { adding: false, editingId: null };
let taxUiState = { adding: false, editingId: null };

export async function mount(container, ctx) {
    const my = ++generation;
    root = container;
    shell = ctx;
    storage = createStorage(ctx.api);

    nodes = {
        orgForm: container.querySelector('[data-role="org-form"]'),
        bankAccounts: container.querySelector('[data-role="bank-accounts"]'),
        taxes: container.querySelector('[data-role="taxes"]'),
        lockedNote: container.querySelector('[data-role="locked-note"]'),
        completion: container.querySelector('[data-role="completion"]'),
        preview: container.querySelector('[data-role="preview"]')
    };

    organization = null;
    bankUiState = { adding: false, editingId: null };
    taxUiState = { adding: false, editingId: null };

    try {
        const data = await storage.fetchOrganization();
        if (my !== generation) return;   // за время запроса раздел перемонтировали
        organization = data;
    } catch (err) {
        if (my !== generation) return;
        // Отмена — не ошибка пользователя: панель просто закрыли во время
        // загрузки. Показывать «не удалось связаться с сервером» тут нельзя.
        if (isAbort(err)) return;
        ctx.toast(err.message, 'error');
    }

    // Панель могли закрыть, пока шёл запрос: рисовать в вырезанный из
    // документа контейнер нечего.
    if (my !== generation || root !== container) return;
    renderAll();
}

export function unmount() {
    generation += 1;   // всё, что было в полёте, теперь чужое
    root = null;
    shell = null;
    storage = null;
    nodes = null;
    organization = null;
    bankUiState = { adding: false, editingId: null };
    taxUiState = { adding: false, editingId: null };
}

// ---------------------------------------------------------------- отрисовка

function renderAll() {
    renderOrg();
    renderSubRecordsVisibility();
    renderBankAccounts();
    renderTaxes();
    renderPreviewPanel();
}

function renderOrg() {
    renderOrganizationForm(nodes.orgForm, organization, {
        onSave: handleOrgSave,
        toast: shell.toast
    });
    renderCompletion(nodes.completion, organization);
}

function renderPreviewPanel() {
    renderPreview(nodes.preview, organization);
}

function renderSubRecordsVisibility() {
    const hasOrg = organization !== null;
    nodes.lockedNote.hidden = hasOrg;
    nodes.bankAccounts.hidden = !hasOrg;
    nodes.taxes.hidden = !hasOrg;
}

function renderBankAccounts() {
    if (organization === null) return;
    // Массивы страхуем: сервер их гарантирует (GET и POST отдают вложенные
    // bankAccounts/taxes), но раздел падал целиком от одного отсутствующего
    // поля — и падал молча, панель показывала «раздел не открылся». Цена
    // страховки — два символа, цена падения — весь раздел.
    if (!Array.isArray(organization.bankAccounts)) organization.bankAccounts = [];
    renderRecordsSection(nodes.bankAccounts, {
        title: 'Банковские счета',
        records: organization.bankAccounts,
        fields: BANK_ACCOUNT_FIELDS,
        uiState: bankUiState,
        idPrefix: 'mBank',
        emptyText: 'Пока нет добавленных счетов.',
        addButtonLabel: 'Добавить счёт',
        wordForms: ['счёт', 'счёта', 'счетов'],
        validators: BANK_ACCOUNT_FIELD_VALIDATORS,
        toast: shell.toast,
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
    if (!Array.isArray(organization.taxes)) organization.taxes = [];
    renderRecordsSection(nodes.taxes, {
        title: 'Налоги',
        records: organization.taxes,
        fields: TAX_FIELDS,
        uiState: taxUiState,
        idPrefix: 'mTax',
        emptyText: 'Пока нет добавленных налоговых записей.',
        addButtonLabel: 'Добавить налог',
        wordForms: ['запись', 'записи', 'записей'],
        toast: shell.toast,
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

// ---------------------------------------------------------------- действия
//
// Каждый обработчик проверяет, что панель ещё жива: между отправкой запроса и
// ответом её могли закрыть. Отменённый запрос молчит, остальные ошибки
// по-прежнему показываются пользователем.

// Жив ли ТОТ ЖЕ раздел, из которого ушёл запрос. Проверять только «root !==
// null» мало: панель могли закрыть и открыть заново, и тогда ответ старого
// запроса дорисовался бы в новую панель.
function alive(mountId) {
    return root !== null && nodes !== null && mountId === generation;
}

function fail(mountId, err) {
    if (isAbort(err) || !alive(mountId)) return;
    shell.toast(err.message, 'error');
}

async function handleOrgSave(data) {
    const my = generation;
    try {
        if (organization === null) {
            const created = await storage.createOrganization(data);
            if (!alive(my)) return;
            organization = created;
            shell.toast('Организация создана', 'success');
        } else {
            const updated = await storage.updateOrganization(organization.id, data);
            if (!alive(my)) return;
            organization = { ...organization, ...updated };
            shell.toast('Изменения сохранены', 'success');
        }
        renderAll();
    } catch (err) {
        fail(my, err);
    }
}

async function handleBankCreate(data) {
    const my = generation;
    try {
        const created = await storage.createBankAccount(organization.id, data);
        if (!alive(my)) return;
        organization.bankAccounts.push(created);
        bankUiState.adding = false;
        shell.toast('Счёт добавлен', 'success');
        renderBankAccounts();
        renderPreviewPanel();
    } catch (err) {
        fail(my, err);
    }
}

async function handleBankSave(record, data) {
    const my = generation;
    try {
        const updated = await storage.updateBankAccount(organization.id, record.id, data);
        if (!alive(my)) return;
        organization.bankAccounts = organization.bankAccounts.map((r) => (r.id === record.id ? updated : r));
        bankUiState.editingId = null;
        shell.toast('Изменения сохранены', 'success');
        renderBankAccounts();
        renderPreviewPanel();
    } catch (err) {
        fail(my, err);
    }
}

async function handleBankDelete(id) {
    const my = generation;
    // Удаление необратимо — подтверждение накрывает весь экран, а не только
    // свою панель (правило дизайн-сессии, бриф 5.4).
    const account = organization.bankAccounts.find((r) => r.id === id);
    const ok = await shell.confirmDanger({
        title: 'Удаление счёта',
        message: account && account.bankName
            ? `Удалить банковский счёт «${account.bankName}»? Действие необратимо.`
            : 'Удалить этот банковский счёт? Действие необратимо.'
    });
    if (!ok || !alive(my)) return;
    try {
        await storage.deleteBankAccount(organization.id, id);
        if (!alive(my)) return;
        organization.bankAccounts = organization.bankAccounts.filter((r) => r.id !== id);
        shell.toast('Счёт удалён', 'success');
        renderBankAccounts();
        renderPreviewPanel();
    } catch (err) {
        fail(my, err);
    }
}

async function handleTaxCreate(data) {
    const my = generation;
    try {
        const created = await storage.createTax(organization.id, data);
        if (!alive(my)) return;
        organization.taxes.push(created);
        taxUiState.adding = false;
        shell.toast('Налоговая запись добавлена', 'success');
        renderTaxes();
    } catch (err) {
        fail(my, err);
    }
}

async function handleTaxSave(record, data) {
    const my = generation;
    try {
        const updated = await storage.updateTax(organization.id, record.id, data);
        if (!alive(my)) return;
        organization.taxes = organization.taxes.map((r) => (r.id === record.id ? updated : r));
        taxUiState.editingId = null;
        shell.toast('Изменения сохранены', 'success');
        renderTaxes();
    } catch (err) {
        fail(my, err);
    }
}

async function handleTaxDelete(id) {
    const my = generation;
    const tax = organization.taxes.find((r) => r.id === id);
    const ok = await shell.confirmDanger({
        title: 'Удаление налоговой записи',
        message: tax && tax.taxType
            ? `Удалить налоговую запись «${tax.taxType}»? Действие необратимо.`
            : 'Удалить эту налоговую запись? Действие необратимо.'
    });
    if (!ok || !alive(my)) return;
    try {
        await storage.deleteTax(organization.id, id);
        if (!alive(my)) return;
        organization.taxes = organization.taxes.filter((r) => r.id !== id);
        shell.toast('Налоговая запись удалена', 'success');
        renderTaxes();
    } catch (err) {
        fail(my, err);
    }
}
