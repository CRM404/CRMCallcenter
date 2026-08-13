// --- leadsModal.js: модалка лида (создание/редактирование) ---
// Две вкладки: «Данные лида» | «Офферы (N)» — счётчик выбранных прямо на
// ярлыке, сохранение без офферов само переключает на вкладку «Офферы»
// (композиция дизайн-сессии, report_designer.md, 13.08.2026).
//
// Обязательные поля: номер, линия, источник, минимум один оффер, скрипт и
// минимум один статус показа. «Скрипт для повторных» условный — появляется и
// становится обязательным, когда среди статусов показа есть этапы 5–6.

import { createLead, updateLead, checkPhoneDuplicate } from './leadsStorage.js';
import { showToast } from './leadsToast.js';
import { initGeoAutocomplete, resetGeoContext } from './leadsGeo.js';
import { createPickList } from './leadsPickList.js';
import { createOfferTabPicker } from './leadsOffers.js';

const $ = (sel) => document.querySelector(sel);

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Демо-набор куратор подтвердил как окончательный (report_2026-08-01.md,
// 13.08.2026) — своего param_list в БД под это нет, значения просто зашиты.
const DOWN_PAYMENT_OPTIONS = ['10', '15', '20', '25', '30', '50'];

// «Повторные» — этапы воронки 5 и 6 (решение владельца п.2).
const REPEAT_STAGE_FROM = 5;

// Простые текстовые поля, читаемые/заполняемые 1:1 по value (id = `ld` + key
// с большой первой буквы). Селекты и телефон обрабатываются отдельно.
const PLAIN_FIELDS = [
    'lastName', 'firstName', 'middleName',
    'propertyType', 'propertyClass', 'roomCount', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'deliveryDeadline',
    'region', 'city', 'district', 'locality',
    'purchaseMethod', 'mortgageType', 'downPaymentPercent', 'purchaseTimeframe',
    'notes'
];

function fieldId(key) {
    return 'ld' + key.charAt(0).toUpperCase() + key.slice(1);
}

let editingLeadId = null;
let funnelStatuses = [];
let onSavedCallback = null;
let statusPick = null;
let offerPicker = null;
let allEmployees = [];
// Сотрудник, уже назначенный открытому лиду. Нужен отдельно от списка: он
// остаётся доступным, даже если не проходит фильтр по линии или уволен
// (легаси-данные, dialog.md B1/B4) — иначе сохранение карточки молча обнулило
// бы существующее назначение.
let assignedEmployeeId = null;

function fillSelectFromList(select, items, placeholder, withNone) {
    let html = `<option value="">${escapeHtml(placeholder)}</option>`;
    if (withNone) html += `<option value="none">— без оператора —</option>`;
    html += items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
    select.innerHTML = html;
}

function fillPlainSelect(select, values, placeholder) {
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}`;
}

// Тот же паттерн, что buildFunnelStatusOptions в Operator/js/modules/operatorLeadForm.js.
// Экспортируется — переиспользуется в leadsApp.js для фильтра и массового
// действия "Сменить статус" (те же ~59 значений, тот же паттерн optgroup).
export function fillFunnelStatusSelect(select, statuses, includeEmpty) {
    let html = includeEmpty ? '<option value="">— не выбран —</option>' : '';
    const byStage = new Map();
    statuses.forEach((s) => {
        if (!byStage.has(s.stageNumber)) byStage.set(s.stageNumber, { stageName: s.stageName, items: [] });
        byStage.get(s.stageNumber).items.push(s);
    });
    Array.from(byStage.keys()).sort((a, b) => a - b).forEach((num) => {
        const { stageName, items } = byStage.get(num);
        const options = items.map((s) => `<option value="${s.id}">${escapeHtml(s.statusName)}</option>`).join('');
        html += `<optgroup label="${escapeHtml(`${num}. ${stageName}`)}">${options}</optgroup>`;
    });
    select.innerHTML = html;
}

// Живая маска "+7 (___) ___-__-__" — только российский формат (design-решение,
// report_designer.md, "правки по фидбеку владельца", 12.08.2026).
function maskRuPhone(raw) {
    let d = raw.replace(/\D/g, '');
    if (d.startsWith('8')) d = '7' + d.slice(1);
    if (!d.startsWith('7')) d = '7' + d;
    d = d.slice(0, 11);
    let out = '+7';
    if (d.length > 1) out += ' (' + d.slice(1, 4);
    if (d.length >= 4) out += ')';
    if (d.length > 4) out += ' ' + d.slice(4, 7);
    if (d.length > 7) out += '-' + d.slice(7, 9);
    if (d.length > 9) out += '-' + d.slice(9, 11);
    return out;
}

async function handlePhoneBlur() {
    const phone = $('#ldPhone').value.trim();
    const dupWarning = $('#dupWarning');
    if (!phone) {
        dupWarning.hidden = true;
        return;
    }
    try {
        const { duplicateId } = await checkPhoneDuplicate(phone);
        const isDuplicate = duplicateId && duplicateId !== editingLeadId;
        dupWarning.hidden = !isDuplicate;
        if (isDuplicate) $('#dupWarningId').textContent = '#' + duplicateId;
    } catch (e) {
        // Проверка дубля не блокирует работу с формой — тихо игнорируем сбой сервиса.
    }
}

function employeeName(employee) {
    return `${employee.lastName} ${employee.firstName}`;
}

// Раздача уводит лида только оператору его линии, поэтому и вручную назначить
// можно только такого же (`leadsUpload.js` фильтрует пул раздачи ровно так же).
// Исключение — уже назначенный сотрудник: он остаётся в списке с пометкой
// причины, по которой не прошёл бы фильтр, чтобы сохранение карточки не
// потеряло существующее назначение.
function syncEmployeesByLine() {
    const line = $('#ldLine').value;
    const select = $('#ldEmployee');
    const previous = select.value;

    if (!line) {
        select.innerHTML = '<option value="">— сначала выберите линию —</option>';
        select.disabled = true;
        select.value = '';
        return;
    }

    const matching = allEmployees.filter((e) => e.lineType === line && e.status === 'active');
    const options = matching.map((e) => ({ id: e.id, name: employeeName(e) }));

    const assigned = assignedEmployeeId ? allEmployees.find((e) => e.id === assignedEmployeeId) : null;
    if (assigned && !matching.some((e) => e.id === assigned.id)) {
        const reasons = [];
        if (assigned.lineType !== line) reasons.push('другая линия');
        if (assigned.status !== 'active') reasons.push('неактивен');
        options.unshift({ id: assigned.id, name: `${employeeName(assigned)} (${reasons.join(', ')})` });
    }

    select.disabled = false;
    fillSelectFromList(select, options, '— не назначен —');
    // Прежний выбор сохраняем, только если он всё ещё в списке: при смене
    // линии сотрудник старой линии из выбора уходит.
    select.value = options.some((o) => String(o.id) === previous) ? previous : '';
}

// Условный «Скрипт для повторных»: в скрытом виде места в сетке НЕ резервирует
// (display:none через [hidden], а не visibility) — фидбек владельца про пустоту
// в форме.
function syncRepeatVisibility() {
    const selectedStatusIds = new Set(statusPick.getValues());
    const needsRepeat = funnelStatuses.some((s) => selectedStatusIds.has(s.id) && s.stageNumber >= REPEAT_STAGE_FROM);
    $('#ldRepeatWrap').hidden = !needsRepeat;
    return needsRepeat;
}

function switchTab(tab) {
    const isMain = tab === 'main';
    $('#leadTabBtnMain').classList.toggle('active', isMain);
    $('#leadTabBtnOffers').classList.toggle('active', !isMain);
    $('#leadTabBtnMain').setAttribute('aria-selected', String(isMain));
    $('#leadTabBtnOffers').setAttribute('aria-selected', String(!isMain));
    $('#leadTabMain').hidden = !isMain;
    $('#leadTabOffers').hidden = isMain;
}

export function initLeadModal({ sources, employees, statuses, paramLists, scripts }, onSaved) {
    funnelStatuses = statuses;
    onSavedCallback = onSaved;

    allEmployees = employees;

    fillSelectFromList($('#ldSource'), sources.map((s) => ({ id: s.id, name: s.rootSource })), '— не выбран —');
    fillSelectFromList($('#ldScript'), scripts.map((s) => ({ id: s.id, name: s.title })), '— не выбран —');
    fillSelectFromList($('#ldRepeatScript'), scripts.map((s) => ({ id: s.id, name: s.title })), '— не выбран —');
    fillFunnelStatusSelect($('#ldFunnelStatus'), funnelStatuses, true);

    fillPlainSelect($('#ldPropertyType'), paramLists.objType || [], '— не выбран —');
    fillPlainSelect($('#ldPropertyClass'), paramLists.objClass || [], '— не выбран —');
    fillPlainSelect($('#ldRoomCount'), paramLists.rooms || [], '— не выбрана —');
    fillPlainSelect($('#ldPurchaseMethod'), paramLists.paymentMethod || [], '— не выбран —');
    fillPlainSelect($('#ldMortgageType'), paramLists.mortgageType || [], '— не выбран —');
    fillPlainSelect($('#ldPurchaseTimeframe'), paramLists.purchaseTerm || [], '— не выбран —');
    fillPlainSelect($('#ldDownPaymentPercent'), DOWN_PAYMENT_OPTIONS, '— не выбран —');

    statusPick = createPickList($('#ldStatusPick'), {
        emptyText: 'Ни один статус не выбран — обязателен минимум один.',
        onChange: syncRepeatVisibility
    });
    statusPick.setItems(funnelStatuses.map((s) => ({
        id: s.id, label: s.statusName, stageNumber: s.stageNumber, stageName: s.stageName
    })));

    offerPicker = createOfferTabPicker({
        rootSelect: $('#ofltRoot'), platSelect: $('#ofltPlat'),
        geoSelects: {
            region: $('#ofltRegion'), city: $('#ofltCity'),
            district: $('#ofltDistrict'), locality: $('#ofltLocality')
        },
        searchInput: $('#offerSearchInput'), resetBtn: $('#ofltResetBtn'),
        resultsEl: $('#offerResults'), tagsEl: $('#offerSelTags'), countEl: $('#offerSelCount'),
        emptyEl: $('#offerSelEmpty'), clearAllBtn: $('#offerClearAllBtn'), tabCountEl: $('#offerTabCount')
    });

    initGeoAutocomplete();

    $('#leadTabBtnMain').addEventListener('click', () => switchTab('main'));
    $('#leadTabBtnOffers').addEventListener('click', () => switchTab('offers'));
    $('#ldLine').addEventListener('change', syncEmployeesByLine);

    $('#ldPhone').addEventListener('input', (e) => {
        const pos = e.target.selectionStart;
        const before = e.target.value.length;
        e.target.value = maskRuPhone(e.target.value);
        const after = e.target.value.length;
        e.target.selectionEnd = Math.max(0, pos + (after - before));
    });
    $('#ldPhone').addEventListener('blur', handlePhoneBlur);

    $('#addLeadBtn').addEventListener('click', () => openLeadModal(null));
    $('#leadModalClose').addEventListener('click', closeLeadModal);
    $('#leadModalCancel').addEventListener('click', closeLeadModal);
    $('#leadModal').addEventListener('click', (e) => { if (e.target.id === 'leadModal') closeLeadModal(); });
    $('#leadModalSave').addEventListener('click', handleSave);
}

export async function openLeadModal(lead) {
    editingLeadId = lead ? lead.id : null;
    resetGeoContext();
    switchTab('main');
    $('#leadModalTitle').textContent = lead ? `Лид #${lead.id}` : 'Новый лид';
    $('#dupWarning').hidden = true;

    $('#ldPhone').value = lead ? (lead.phone || '') : '';
    PLAIN_FIELDS.forEach((key) => {
        $('#' + fieldId(key)).value = lead && lead[key] !== null && lead[key] !== undefined ? lead[key] : '';
    });
    $('#ldSource').value = lead && lead.sourceId ? lead.sourceId : '';
    $('#ldLine').value = lead && lead.lineType ? lead.lineType : '';
    // Список сотрудников зависит от линии, поэтому заполняется ПОСЛЕ неё, и
    // только потом выставляется текущее назначение.
    assignedEmployeeId = lead && lead.employeeId ? lead.employeeId : null;
    syncEmployeesByLine();
    $('#ldEmployee').value = lead && lead.employeeId ? lead.employeeId : '';
    $('#ldFunnelStatus').value = lead && lead.funnelStatusId ? lead.funnelStatusId : '';
    $('#ldScript').value = lead && lead.scriptId ? lead.scriptId : '';
    $('#ldRepeatScript').value = lead && lead.repeatScriptId ? lead.repeatScriptId : '';

    // «Новый» предвыбран у нового лида (требование куратора): иначе легко
    // создать лида, у которого оператор сразу не увидит скрипта.
    if (lead) {
        statusPick.setValues(lead.scriptStatusIds || []);
    } else {
        const newStatus = funnelStatuses.find((s) => s.stageNumber === 0);
        statusPick.setValues(newStatus ? [newStatus.id] : []);
    }
    syncRepeatVisibility();

    $('#leadModal').hidden = false;
    await offerPicker.open(lead ? lead.offers : []);
}

function closeLeadModal() {
    $('#leadModal').hidden = true;
    editingLeadId = null;
}

function gatherLeadData() {
    const data = { phone: $('#ldPhone').value.trim() };
    PLAIN_FIELDS.forEach((key) => { data[key] = $('#' + fieldId(key)).value.trim(); });
    data.sourceId = $('#ldSource').value || null;
    data.lineType = $('#ldLine').value || null;
    data.employeeId = $('#ldEmployee').value || null;
    data.funnelStatusId = $('#ldFunnelStatus').value || null;
    data.scriptId = $('#ldScript').value || null;
    data.repeatScriptId = $('#ldRepeatScript').value || null;
    data.scriptStatusIds = statusPick.getValues();
    data.offerIds = offerPicker.getValues();
    data.poolEmployeeIds = [];
    return data;
}

async function handleSave() {
    const data = gatherLeadData();

    // Клиентская валидация — ровно та же, что на сервере, чтобы пользователь
    // не ловил 400 на каждое пропущенное поле по очереди.
    if (!data.phone) { showToast('Укажите номер телефона', 'error'); switchTab('main'); return; }
    if (!data.lineType) { showToast('Выберите линию', 'error'); switchTab('main'); return; }
    if (!data.sourceId) { showToast('Выберите источник', 'error'); switchTab('main'); return; }
    if (!data.scriptId) { showToast('Выберите скрипт', 'error'); switchTab('main'); return; }
    if (data.scriptStatusIds.length === 0) { showToast('Выберите хотя бы один статус показа скрипта', 'error'); switchTab('main'); return; }
    if (syncRepeatVisibility() && !data.repeatScriptId) {
        showToast('Среди статусов показа есть этапы 5–6 — укажите скрипт для повторных', 'error');
        switchTab('main');
        return;
    }
    // Сохранение без офферов само переключает на вкладку «Офферы» — там же
    // и подсказка «обязателен минимум один» (решение дизайн-сессии).
    if (data.offerIds.length === 0) {
        showToast('Выберите хотя бы один оффер', 'error');
        switchTab('offers');
        return;
    }

    try {
        if (editingLeadId) {
            await updateLead(editingLeadId, data);
            showToast('Лид сохранён', 'success');
        } else {
            await createLead(data);
            showToast('Лид добавлен', 'success');
        }
    } catch (e) {
        showToast(e.message, 'error');
        return;
    }
    closeLeadModal();
    if (onSavedCallback) await onSavedCallback();
}
