// --- leadsModal.js: окно лида (создание/редактирование) ---
// Две вкладки: «Данные лида» | «Офферы (N)» — счётчик выбранных прямо на
// ярлыке, сохранение без офферов само переключает на вкладку «Офферы»
// (композиция дизайн-сессии, report_designer.md, 13.08.2026).
//
// Обязательные поля: номер, линия, источник, минимум один оффер, скрипт и
// минимум один статус показа. «Скрипт для повторных» условный — появляется и
// становится обязательным, когда среди статусов показа есть этапы 5–6.
//
// ПЕРЕНОС В ОБОЛОЧКУ. Модуль был набором функций уровня файла: состояние в
// переменных модуля, узлы — через document. Одна открытая панель это терпела,
// две — нет. Теперь это фабрика на монтирование: createLeadModal(root, deps)
// возвращает объект окна, и всё его состояние живёт внутри замыкания.

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

// Каскады — та же логика, что в форме оффера и в карточке оператора, включая
// нестрогое сравнение по подстроке (значение могли переименовать через
// «Настройку списков»).
const DOWN_PAYMENT_WORDS = ['ипотек', 'материнск', 'рассрочк'];
const RETIREE_VALUE = 'Пенсионер';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fieldId(key) {
    return 'ld' + key.charAt(0).toUpperCase() + key.slice(1);
}

function fillSelectFromList(select, items, placeholder, withNone) {
    let html = `<option value="">${escapeHtml(placeholder)}</option>`;
    if (withNone) html += '<option value="none">— без оператора —</option>';
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
// действия «Сменить статус» (те же ~59 значений, тот же паттерн optgroup).
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

// Живая маска «+7 (___) ___-__-__» — только российский формат (design-решение,
// report_designer.md, «правки по фидбеку владельца», 12.08.2026).
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

function employeeName(employee) {
    return `${employee.lastName} ${employee.firstName}`;
}

/**
 * @param {HTMLElement} root   контейнер панели
 * @param {Object}      deps   { storage, toast, isAlive, isAbort, createPickList,
 *                               createOfferTabPicker, createGeo, onSaved }
 */
export function createLeadModal(root, deps) {
    const { storage, toast, isAlive, isAbort, createPickList, createOfferTabPicker, createGeo, onSaved } = deps;

    const $ = (sel) => root.querySelector(sel);
    const modal = $('[data-role="lead-modal"]');
    const saveBtn = $('[data-role="lead-save"]');

    let editingLeadId = null;
    let funnelStatuses = [];
    let allEmployees = [];
    let statusPick = null;
    let offerPicker = null;
    let geo = null;
    let saving = false;
    // Сотрудник, уже назначенный открытому лиду. Нужен отдельно от списка: он
    // остаётся доступным, даже если не проходит фильтр по линии или уволен
    // (легаси-данные, dialog.md B1/B4) — иначе сохранение карточки молча
    // обнулило бы существующее назначение.
    let assignedEmployeeId = null;
    let cascadeTouched = false;
    // Значение «иного заёмщика», с которым карточку открыли: чекбокс
    // трёхзначное состояние не хранит (NULL и false выглядят одинаково),
    // поэтому исходное состояние запоминается отдельно.
    let openedOtherBorrower = null;

    // ---------------------------------------------------------------- каскады

    // Раздача уводит лида только оператору его линии, поэтому и вручную
    // назначить можно только такого же (окно загрузки фильтрует пул раздачи
    // ровно так же). Исключение — уже назначенный сотрудник: он остаётся в
    // списке с пометкой причины, по которой не прошёл бы фильтр, чтобы
    // сохранение карточки не потеряло существующее назначение.
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
    // keepValues=true — открытие карточки: поля прячутся, но НЕ обнуляются,
    // иначе первое же сохранение стёрло бы значения легаси-лида, которых
    // администратор даже не видел на экране.
    function syncPurchaseCascades(keepValues) {
        const payment = ($('#ldPurchaseMethod').value || '').toLowerCase();
        const showDownPayment = DOWN_PAYMENT_WORDS.some((word) => payment.includes(word));
        const showMortgage = payment.includes('ипотек');
        const showOtherBorrower = $('#ldClientType').value === RETIREE_VALUE && showMortgage;

        $('[data-role="down-payment-wrap"]').hidden = !showDownPayment;
        if (!showDownPayment && !keepValues) $('#ldDownPaymentPercent').value = '';

        $('[data-role="mortgage-wrap"]').hidden = !showMortgage;
        if (!showMortgage && !keepValues) $('#ldMortgageType').value = '';

        $('[data-role="other-borrower-wrap"]').hidden = !showOtherBorrower;
        if (!showOtherBorrower && !keepValues) $('#ldOtherBorrower').checked = false;
    }

    function handleCascadeChange() {
        cascadeTouched = true;
        syncPurchaseCascades(false);
    }

    // Условный «Скрипт для повторных»: в скрытом виде места в сетке НЕ
    // резервирует (display:none через [hidden], а не visibility) — фидбек
    // владельца про пустоту в форме.
    function syncRepeatVisibility() {
        const selectedStatusIds = new Set(statusPick.getValues());
        const needsRepeat = funnelStatuses.some((s) => selectedStatusIds.has(s.id) && s.stageNumber >= REPEAT_STAGE_FROM);
        $('[data-role="repeat-wrap"]').hidden = !needsRepeat;
        return needsRepeat;
    }

    function switchTab(tab) {
        const isMain = tab === 'main';
        $('[data-role="tab-main"]').classList.toggle('ui-tabs__tab--active', isMain);
        $('[data-role="tab-offers"]').classList.toggle('ui-tabs__tab--active', !isMain);
        $('[data-role="tab-main"]').setAttribute('aria-selected', String(isMain));
        $('[data-role="tab-offers"]').setAttribute('aria-selected', String(!isMain));
        $('[data-role="tab-panel-main"]').hidden = !isMain;
        $('[data-role="tab-panel-offers"]').hidden = isMain;
    }

    async function handlePhoneBlur() {
        const phone = $('#ldPhone').value.trim();
        const dupWarning = $('[data-role="dup-warning"]');
        if (!phone) {
            dupWarning.hidden = true;
            return;
        }
        try {
            const { duplicateId } = await storage.checkPhoneDuplicate(phone);
            // Панель могли закрыть, пока шла проверка.
            if (!isAlive()) return;
            const isDuplicate = duplicateId && duplicateId !== editingLeadId;
            dupWarning.hidden = !isDuplicate;
            if (isDuplicate) $('[data-role="dup-warning-id"]').textContent = '#' + duplicateId;
        } catch (e) {
            // Проверка дубля не блокирует работу с формой — тихо игнорируем
            // сбой сервиса. Отмена запроса сюда же и приходит.
        }
    }

    // ---------------------------------------------------------------- сборка

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
        // true/false — ответ. Не путать «нет» и «не спрашивали». Если поле
        // скрыто, но каскад в этом сеансе не трогали, отдаём то, что пришло из
        // базы: карточку могли просто открыть и сохранить.
        if (!$('[data-role="other-borrower-wrap"]').hidden) {
            data.otherBorrower = $('#ldOtherBorrower').checked;
        } else {
            data.otherBorrower = cascadeTouched ? null : (openedOtherBorrower ?? null);
        }
        return data;
    }

    async function handleSave() {
        // Двойной клик по «Сохранить» до переноса создавал ДВА лида: запрос
        // идёт секунду, а кнопка всё это время активна. Слой блокирует кнопку
        // на время обработчика в своих окнах (ui/modal.js), это окно —
        // разметочное, поэтому блокировка здесь своя.
        if (saving) return;

        const data = gatherLeadData();

        // Клиентская проверка — ровно та же, что на сервере, чтобы пользователь
        // не ловил 400 на каждое пропущенное поле по очереди.
        if (!data.phone) { toast('Укажите номер телефона', 'error'); switchTab('main'); return; }
        if (!data.lineType) { toast('Выберите линию', 'error'); switchTab('main'); return; }
        if (!data.sourceId) { toast('Выберите источник', 'error'); switchTab('main'); return; }
        if (!data.scriptId) { toast('Выберите скрипт', 'error'); switchTab('main'); return; }
        if (data.scriptStatusIds.length === 0) { toast('Выберите хотя бы один статус показа скрипта', 'error'); switchTab('main'); return; }
        if (syncRepeatVisibility() && !data.repeatScriptId) {
            toast('Среди статусов показа есть этапы 5–6 — укажите скрипт для повторных', 'error');
            switchTab('main');
            return;
        }
        // Сохранение без офферов само переключает на вкладку «Офферы» — там же
        // и подсказка «обязателен минимум один» (решение дизайн-сессии).
        if (data.offerIds.length === 0) {
            toast('Выберите хотя бы один оффер', 'error');
            switchTab('offers');
            return;
        }

        saving = true;
        saveBtn.disabled = true;
        const savedId = editingLeadId;
        try {
            if (savedId) {
                await storage.updateLead(savedId, data);
            } else {
                await storage.createLead(data);
            }
        } catch (e) {
            if (!isAlive()) return;
            if (!isAbort(e)) toast(e.message, 'error');
            return;
        } finally {
            saving = false;
            // Панель могли закрыть — кнопки уже нет ни в документе, ни в
            // разметке, но ссылка на узел жива, и снимать блокировку безвредно.
            saveBtn.disabled = false;
        }
        if (!isAlive()) return;
        toast(savedId ? 'Лид сохранён' : 'Лид добавлен', 'success');
        close();
        if (onSaved) await onSaved();
    }

    function close() {
        modal.hidden = true;
        editingLeadId = null;
    }

    // ---------------------------------------------------------------- запуск

    function init({ sources, employees, statuses, paramLists, scripts }) {
        funnelStatuses = statuses;
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

        statusPick = createPickList($('[data-role="status-pick"]'), {
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
            searchInput: $('#offerSearchInput'), resetBtn: $('[data-role="offer-filters-reset"]'),
            resultsEl: $('[data-role="offer-results"]'), tagsEl: $('[data-role="offer-sel-tags"]'),
            countEl: $('[data-role="offer-sel-count"]'), emptyEl: $('[data-role="offer-sel-empty"]'),
            clearAllBtn: $('[data-role="offer-clear-all"]'), tabCountEl: $('[data-role="offer-tab-count"]')
        });

        geo = createGeo();

        $('[data-role="tab-main"]').addEventListener('click', () => switchTab('main'));
        $('[data-role="tab-offers"]').addEventListener('click', () => switchTab('offers'));
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

        $('[data-role="lead-close"]').addEventListener('click', close);
        $('[data-role="lead-cancel"]').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        saveBtn.addEventListener('click', handleSave);
    }

    async function open(lead) {
        editingLeadId = lead ? lead.id : null;
        geo.reset();
        switchTab('main');
        $('[data-role="lead-modal-title"]').textContent = lead ? `Лид #${lead.id}` : 'Новый лид';
        $('[data-role="dup-warning"]').hidden = true;

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

        modal.hidden = false;
        await offerPicker.open(lead ? lead.offers : []);
    }

    return {
        init,
        open,
        close,
        isOpen: () => !modal.hidden,
        destroy() {
            if (offerPicker) offerPicker.destroy();
            if (geo) geo.destroy();
        }
    };
}
