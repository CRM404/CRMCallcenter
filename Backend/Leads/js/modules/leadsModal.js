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

// Поля, читаемые/заполняемые 1:1 по value (id = `ld` + key с большой первой
// буквы) — и текстовые, и выпадающие: у select тот же .value. Телефон, связки и
// чекбокс «иной заёмщик» обрабатываются отдельно.
const PLAIN_FIELDS = [
    'lastName', 'firstName', 'middleName', 'decisionMaker',
    'category', 'propertyType', 'propertyClass', 'roomCount', 'finish', 'deliveryDeadline',
    'priceFrom', 'priceTo', 'areaFrom', 'areaTo',
    'region', 'city', 'district', 'locality',
    'clientRegion', 'clientCity', 'clientDistrict', 'clientLocality',
    'purchaseMethod', 'mortgageType', 'downPaymentPercent', 'clientType', 'purchaseTimeframe',
    'notes'
];

function fieldId(key) {
    return 'ld' + key.charAt(0).toUpperCase() + key.slice(1);
}

// Каскады — та же логика, что в форме оффера и в карточке оператора, включая
// нестрогое сравнение по подстроке (значение могли переименовать через
// «Настройку списков»).
const DOWN_PAYMENT_WORDS = ['ипотек', 'материнск', 'рассрочк'];
const RETIREE_VALUE = 'Пенсионер';

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

// Значение, сохранённое у лида, но отсутствующее в справочнике (владелец удалил
// его через «Настройку списков» или лид заведён до появления списка), нельзя ни
// обнулять, ни подменять — оно показывается отдельным пунктом с пометкой, сразу
// после пустого (dialog.md C1/C2). До 14.08.2026 такое значение просто не
// попадало ни в один <option>, select становился пустым, и первое же сохранение
// карточки затирало данные оператора.
function setSelectValue(select, value) {
    const previousOrphan = select.querySelector('option[data-out-of-list]');
    if (previousOrphan) previousOrphan.remove();

    const raw = value === null || value === undefined ? '' : String(value);
    const known = Array.from(select.options).some((option) => option.value === raw);
    if (raw && !known) {
        const option = document.createElement('option');
        option.value = raw;
        option.textContent = `${raw} — вне списка`;
        option.dataset.outOfList = 'true';
        select.insertBefore(option, select.options[1] || null);
    }
    select.value = raw;
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

// Каскады «Покупки» — те же три правила, что в карточке оператора: без них
// администратор сохранил бы взнос без ипотеки или «иного заёмщика» без
// пенсионера, и данные разошлись бы с тем, что видит оператор (dialog.md G2).
// Скрытое поле обнуляется, включая первоначальный взнос: у лида это критерий
// будущего подбора, и «Наличные + взнос 20 %» — мусор (dialog.md F3).
// keepValues=true — открытие карточки: поля прячутся, но НЕ обнуляются, иначе
// первое же сохранение стёрло бы значения легаси-лида, которых администратор
// даже не видел на экране.
let cascadeTouched = false;
// Значение «иного заёмщика», с которым карточку открыли: чекбокс трёхзначное
// состояние не хранит (NULL и false выглядят одинаково), поэтому исходное
// состояние запоминается отдельно.
let openedOtherBorrower = null;

function syncPurchaseCascades(keepValues) {
    const payment = ($('#ldPurchaseMethod').value || '').toLowerCase();
    const showDownPayment = DOWN_PAYMENT_WORDS.some((word) => payment.includes(word));
    const showMortgage = payment.includes('ипотек');
    const showOtherBorrower = $('#ldClientType').value === RETIREE_VALUE && showMortgage;

    $('#ldDownPaymentWrap').hidden = !showDownPayment;
    if (!showDownPayment && !keepValues) $('#ldDownPaymentPercent').value = '';

    $('#ldMortgageWrap').hidden = !showMortgage;
    if (!showMortgage && !keepValues) $('#ldMortgageType').value = '';

    $('#ldOtherBorrowerWrap').hidden = !showOtherBorrower;
    if (!showOtherBorrower && !keepValues) $('#ldOtherBorrower').checked = false;
}

function handleCascadeChange() {
    cascadeTouched = true;
    syncPurchaseCascades(false);
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

    fillPlainSelect($('#ldDecisionMaker'), paramLists.decisionMaker || [], '— не выбран —');
    fillPlainSelect($('#ldCategory'), paramLists.category || [], '— не выбрана —');
    fillPlainSelect($('#ldPropertyType'), paramLists.objType || [], '— не выбран: жилое —');
    fillPlainSelect($('#ldPropertyClass'), paramLists.objClass || [], '— не выбран: все классы —');
    fillPlainSelect($('#ldRoomCount'), paramLists.rooms || [], '— не выбрана —');
    fillPlainSelect($('#ldFinish'), paramLists.finish || [], '— не выбрана —');
    fillPlainSelect($('#ldDeliveryDeadline'), paramLists.deadline || [], '— не выбран —');
    fillPlainSelect($('#ldPurchaseMethod'), paramLists.paymentMethod || [], '— не выбран —');
    fillPlainSelect($('#ldMortgageType'), paramLists.mortgageType || [], '— не выбран —');
    fillPlainSelect($('#ldClientType'), paramLists.clientType || [], '— не выбран —');
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
    $('#ldPurchaseMethod').addEventListener('change', handleCascadeChange);
    $('#ldClientType').addEventListener('change', handleCascadeChange);

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
        const el = $('#' + fieldId(key));
        const value = lead && lead[key] !== null && lead[key] !== undefined ? lead[key] : '';
        // Селекты — через setSelectValue: значение вне справочника должно
        // остаться в поле, а не превратиться в пустоту при сохранении.
        if (el.tagName === 'SELECT') setSelectValue(el, value);
        else el.value = value;
    });
    $('#ldOtherBorrower').checked = lead ? lead.otherBorrower === true : false;
    openedOtherBorrower = lead && (lead.otherBorrower === true || lead.otherBorrower === false) ? lead.otherBorrower : null;
    cascadeTouched = false;
    syncPurchaseCascades(true);
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
    // Трёхзначность: null — условие каскада не выполнено, поле неприменимо;
    // true/false — ответ. Не путать «нет» и «не спрашивали». Если поле скрыто,
    // но каскад в этом сеансе не трогали, отдаём то, что пришло из базы:
    // карточку могли просто открыть и сохранить.
    if (!$('#ldOtherBorrowerWrap').hidden) {
        data.otherBorrower = $('#ldOtherBorrower').checked;
    } else {
        data.otherBorrower = cascadeTouched ? null : (openedOtherBorrower ?? null);
    }
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
