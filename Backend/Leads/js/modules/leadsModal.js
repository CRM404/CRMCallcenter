// --- leadsModal.js: модалка лида (создание/редактирование), report_2026-08-01.md, 13.08.2026 ---

import { createLead, updateLead, checkPhoneDuplicate } from './leadsStorage.js';
import { showToast } from './leadsToast.js';
import { initGeoAutocomplete, resetGeoContext } from './leadsGeo.js';

const $ = (sel) => document.querySelector(sel);

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Демо-набор куратор подтвердил как окончательный (report_2026-08-01.md,
// 13.08.2026) — своего param_list в БД под это нет, значения просто зашиты.
const DOWN_PAYMENT_OPTIONS = ['10', '15', '20', '25', '30', '50'];

// Простые текстовые поля, читаемые/заполняемые 1:1 по value (id = `ld` + key
// с большой первой буквы). Селекты (source/employee/offer/funnelStatus) и
// телефон обрабатываются отдельно.
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

export function initLeadModal({ sources, employees, offers, statuses, paramLists }, onSaved) {
    funnelStatuses = statuses;
    onSavedCallback = onSaved;

    fillSelectFromList($('#ldSource'), sources.map((s) => ({ id: s.id, name: s.rootSource })), '— не выбран —');
    fillSelectFromList($('#ldEmployee'), employees.map((e) => ({ id: e.id, name: `${e.lastName} ${e.firstName}` })), '— не назначен —');
    fillSelectFromList($('#ldOffer'), offers, '— не выбран —');
    fillFunnelStatusSelect($('#ldFunnelStatus'), funnelStatuses, true);

    fillPlainSelect($('#ldPropertyType'), paramLists.objType || [], '— не выбран —');
    fillPlainSelect($('#ldPropertyClass'), paramLists.objClass || [], '— не выбран —');
    fillPlainSelect($('#ldRoomCount'), paramLists.rooms || [], '— не выбрана —');
    fillPlainSelect($('#ldPurchaseMethod'), paramLists.paymentMethod || [], '— не выбран —');
    fillPlainSelect($('#ldMortgageType'), paramLists.mortgageType || [], '— не выбран —');
    fillPlainSelect($('#ldPurchaseTimeframe'), paramLists.purchaseTerm || [], '— не выбран —');
    fillPlainSelect($('#ldDownPaymentPercent'), DOWN_PAYMENT_OPTIONS, '— не выбран —');

    initGeoAutocomplete();

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

export function openLeadModal(lead) {
    editingLeadId = lead ? lead.id : null;
    resetGeoContext();
    $('#leadModalTitle').textContent = lead ? `Лид #${lead.id}` : 'Новый лид';
    $('#dupWarning').hidden = true;

    $('#ldPhone').value = lead ? (lead.phone || '') : '';
    PLAIN_FIELDS.forEach((key) => {
        $('#' + fieldId(key)).value = lead && lead[key] !== null && lead[key] !== undefined ? lead[key] : '';
    });
    $('#ldSource').value = lead && lead.sourceId ? lead.sourceId : '';
    $('#ldEmployee').value = lead && lead.employeeId ? lead.employeeId : '';
    $('#ldOffer').value = lead && lead.offerId ? lead.offerId : '';
    $('#ldFunnelStatus').value = lead && lead.funnelStatusId ? lead.funnelStatusId : '';

    $('#leadModal').hidden = false;
}

function closeLeadModal() {
    $('#leadModal').hidden = true;
    editingLeadId = null;
}

function gatherLeadData() {
    const data = { phone: $('#ldPhone').value.trim() };
    PLAIN_FIELDS.forEach((key) => { data[key] = $('#' + fieldId(key)).value.trim(); });
    data.sourceId = $('#ldSource').value || null;
    data.employeeId = $('#ldEmployee').value || null;
    data.offerId = $('#ldOffer').value || null;
    data.funnelStatusId = $('#ldFunnelStatus').value || null;
    return data;
}

async function handleSave() {
    const data = gatherLeadData();
    if (!data.phone) {
        showToast('Укажите номер телефона', 'error');
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
