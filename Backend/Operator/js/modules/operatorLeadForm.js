// --- operatorLeadForm.js: карточка клиента (лид) — форма редактирования ---
// Состав, порядок и раскладка — по согласованному владельцем макету
// дизайн-сессии (report_designer.md, версия «script-order», 14.08.2026).
//
// ПОРЯДОК ПОЛЕЙ — ТРЕБОВАНИЕ, А НЕ ОФОРМЛЕНИЕ. Владелец перечислил поля как
// последовательность вопросов оператора в разговоре, и первая редакция макета,
// сгруппированная «по смыслу», была им отклонена. Два места выглядят
// непривычно и переставлять их нельзя:
//   • «Срок покупки» стоит в секции «Клиент», сразу за ЛПР, — его спрашивают
//     в начале разговора, а не вместе с оплатой;
//   • «Вид клиента» стоит ПОСЛЕ «Способа покупки» — чекбокс «иной заёмщик»
//     зависит от обоих полей, и при обратном порядке оператор, выбрав ипотеку
//     ниже, был бы вынужден возвращаться вверх к появившемуся чекбоксу.
// По той же причине лесенка разрезана по границе «География | Бюджет»: ни один
// каскад не попадает на стык ступеней.

import { initGeoBlocks } from './operatorGeo.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

function buildFunnelStatusOptions(statuses, selectedId) {
    const byStage = new Map();
    statuses.forEach((s) => {
        if (!byStage.has(s.stageNumber)) byStage.set(s.stageNumber, { stageName: s.stageName, items: [] });
        byStage.get(s.stageNumber).items.push(s);
    });
    const stageNumbers = Array.from(byStage.keys()).sort((a, b) => a - b);
    const groups = stageNumbers.map((num) => {
        const { stageName, items } = byStage.get(num);
        const options = items.map((s) => `
            <option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.statusName)}</option>
        `).join('');
        return `<optgroup label="${escapeHtml(`${num}. ${stageName}`)}">${options}</optgroup>`;
    }).join('');
    return `<option value="">— не выбран —</option>${groups}`;
}

// Значение, сохранённое у лида, но отсутствующее в справочнике (владелец удалил
// или лид заведён до появления списка), показывается ОТДЕЛЬНЫМ пунктом с
// пометкой — первым после пустого (dialog.md C1/C2).
// Почему не «как у офферов»: там такого поведения нет. Проверено — селект
// оффера при значении вне списка подставляет ПЕРВОЕ значение справочника, и
// следующее сохранение пишет подмену в базу; админская карточка лида в том же
// случае даёт пустую строку и обнуляет поле. Оба варианта теряют данные молча.
function buildOptions(values, selected, emptyLabel) {
    const list = values || [];
    const saved = selected === null || selected === undefined ? '' : String(selected);
    const options = [`<option value="">${escapeHtml(emptyLabel || '— не выбрано —')}</option>`];
    if (saved && !list.includes(saved)) {
        options.push(`<option value="${escapeHtml(saved)}" selected>${escapeHtml(saved)} — вне списка</option>`);
    }
    list.forEach((value) => {
        options.push(`<option value="${escapeHtml(value)}"${value === saved ? ' selected' : ''}>${escapeHtml(value)}</option>`);
    });
    return options.join('');
}

function textField(key, label, lead, type) {
    return `
        <div class="form-group">
            <label for="op-field-${key}">${escapeHtml(label)}</label>
            <input id="op-field-${key}" name="${key}" type="${type || 'text'}" value="${escapeHtml(lead[key])}">
        </div>
    `;
}

function selectField(key, label, values, lead, emptyLabel, hint) {
    const hintHtml = hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : '';
    return `
        <div class="form-group">
            <label for="op-field-${key}">${escapeHtml(label)}${hintHtml}</label>
            <select id="op-field-${key}" name="${key}">${buildOptions(values, lead[key], emptyLabel)}</select>
        </div>
    `;
}

// Пара «от — до»: два поля базы под одной подписью, подпись по центру над
// обеими ячейками, занимает две колонки из трёх.
function rangePair(label, hint, fromKey, toKey, lead) {
    return `
        <div class="form-group centered span-2">
            <label>${escapeHtml(label)} <span class="hint">${escapeHtml(hint)}</span></label>
            <div class="range-pair">
                <input id="op-field-${fromKey}" name="${fromKey}" type="number" value="${escapeHtml(lead[fromKey])}" placeholder="от" aria-label="${escapeHtml(label)} от">
                <span class="sep">—</span>
                <input id="op-field-${toKey}" name="${toKey}" type="number" value="${escapeHtml(lead[toKey])}" placeholder="до" aria-label="${escapeHtml(label)} до">
            </div>
        </div>
    `;
}

const GEO_LEVELS = [
    { level: 'region', label: 'Регион' },
    { level: 'city', label: 'Город' },
    { level: 'district', label: 'Район' },
    { level: 'locality', label: 'Населённый пункт' }
];

// prefix: '' — адрес объекта (region/city/...), 'client' — адрес клиента
// (clientRegion/clientCity/...). Разметка одинаковая, различаются только ключи.
function geoFieldKey(prefix, level) {
    return prefix ? prefix + level.charAt(0).toUpperCase() + level.slice(1) : level;
}

function geoBlock(title, prefix, lead) {
    const fields = GEO_LEVELS.map(({ level, label }) => {
        const key = geoFieldKey(prefix, level);
        return `
            <div class="form-group">
                <label for="op-field-${key}">${label}</label>
                <div class="geo-field">
                    <input id="op-field-${key}" name="${key}" type="text" data-geo-level="${level}"
                           value="${escapeHtml(lead[key])}" placeholder="Начните вводить…" autocomplete="off">
                </div>
            </div>
        `;
    }).join('');
    return `
        <div class="geo-block">
            <div class="geo-block-title"><i class="fas fa-location-dot" aria-hidden="true"></i>${escapeHtml(title)}</div>
            <div class="geo-grid">${fields}</div>
        </div>
    `;
}

// Ключи полей по ступеням лесенки. Разбиение нужно не только для сбора данных
// на сохранение, но и для автораскрытия: ступень раскрывается, если непусто
// хоть одно ЕЁ поле. otherBorrower собирается отдельно — он трёхзначный и
// зависит от каскада.
const GEO_KEYS = GEO_LEVELS.map((g) => g.level).concat(GEO_LEVELS.map((g) => geoFieldKey('client', g.level)));
const ALWAYS_VISIBLE_KEYS = [
    'phone', 'lastName', 'firstName', 'middleName', 'decisionMaker', 'purchaseTimeframe',
    'notes', 'funnelStatusId'
];
const PARAMS_KEYS = [
    'priceFrom', 'priceTo', 'purchaseMethod', 'downPaymentPercent', 'mortgageType', 'clientType',
    'category', 'propertyType', 'propertyClass', 'roomCount', 'areaFrom', 'areaTo', 'finish', 'deliveryDeadline'
];
const FIELD_KEYS = [...ALWAYS_VISIBLE_KEYS, ...GEO_KEYS, ...PARAMS_KEYS];

// Каскады — та же логика, что в форме оффера (cpaApp.js), включая нестрогое
// сравнение по подстроке: значение могли переименовать через «Настройку
// списков», и строгое равенство перестало бы срабатывать молча.
const DOWN_PAYMENT_WORDS = ['ипотек', 'материнск', 'рассрочк'];
const RETIREE_VALUE = 'Пенсионер';

function needsDownPayment(paymentMethod) {
    const value = (paymentMethod || '').toLowerCase();
    return DOWN_PAYMENT_WORDS.some((word) => value.includes(word));
}

function isMortgage(paymentMethod) {
    return (paymentMethod || '').toLowerCase().includes('ипотек');
}

function hasAnyValue(container, keys) {
    return keys.some((key) => {
        const el = container.querySelector(`#op-field-${key}`);
        return el && String(el.value).trim() !== '';
    });
}

export function renderLeadForm(container, lead, statuses, paramLists, onSave) {
    const lists = paramLists || {};
    const savedAt = formatDateTime(lead.updatedAt);

    container.innerHTML = `
        <div class="op-card-head">
            <h2><span class="op-card-icon"><i class="fas fa-user" aria-hidden="true"></i></span>Карточка клиента</h2>
            <span class="op-lead-no" title="Номер лида — из базы, не редактируется">
                <i class="fas fa-hashtag" aria-hidden="true"></i>Лид <span class="n">№&nbsp;${lead.id}</span>
            </span>
            <div class="op-lead-meta">Создан ${escapeHtml(formatDateTime(lead.createdAt)) || '—'} · источник: ${escapeHtml(lead.sourceName) || '—'}</div>
        </div>

        <div class="op-lead-phone">
            <i class="fas fa-phone" aria-hidden="true"></i>
            <input id="op-field-phone" name="phone" type="tel" value="${escapeHtml(lead.phone)}" aria-label="Телефон">
        </div>

        <div class="op-form-section">
            <div class="op-section-label">Клиент</div>
            <div class="form-grid cols-3">
                ${textField('lastName', 'Фамилия', lead)}
                ${textField('firstName', 'Имя', lead)}
                ${textField('middleName', 'Отчество', lead)}
                ${selectField('decisionMaker', 'ЛПР', lists.decisionMaker, lead)}
                ${selectField('purchaseTimeframe', 'Срок покупки', lists.purchaseTerm, lead)}
            </div>
        </div>

        <div class="op-form-section">
            <div class="op-section-label">География</div>
            <button type="button" class="op-dashed-row" id="opShowGeoBtn">
                <i class="fas fa-location-dot" aria-hidden="true"></i>
                Показать географию <span class="count">— гео объекта и гео клиента</span>
            </button>
            <div id="opGeoBody" hidden>
                ${geoBlock('Гео объекта', '', lead)}
                ${geoBlock('Гео клиента', 'client', lead)}
            </div>
        </div>

        <div class="op-form-section" id="opParamsStep" hidden>
            <button type="button" class="op-dashed-row" id="opShowParamsBtn">
                <i class="fas fa-magnifying-glass" aria-hidden="true"></i>
                Показать бюджет и объект <span class="count">— цена, способ покупки, параметры объекта</span>
            </button>
        </div>

        <div id="opParamsBody" hidden>
            <div class="op-form-section">
                <div class="op-section-label">Бюджет и оплата</div>
                <div class="form-grid cols-3">
                    ${rangePair('Цена, ₽', '— от и до', 'priceFrom', 'priceTo', lead)}
                </div>
                <div class="form-grid cols-3">
                    ${selectField('purchaseMethod', 'Способ покупки', lists.paymentMethod, lead)}
                    <div class="form-group" id="opDownPaymentGroup" hidden>
                        <label for="op-field-downPaymentPercent">Первоначальный взнос, %</label>
                        <input id="op-field-downPaymentPercent" name="downPaymentPercent" type="number" min="0" max="100" value="${escapeHtml(lead.downPaymentPercent)}">
                    </div>
                    <div class="form-group" id="opMortgageTypeGroup" hidden>
                        <label for="op-field-mortgageType">Вид ипотеки</label>
                        <select id="op-field-mortgageType" name="mortgageType">${buildOptions(lists.mortgageType, lead.mortgageType)}</select>
                    </div>
                    ${selectField('clientType', 'Вид клиента', lists.clientType, lead)}
                    <div class="form-group span-full" id="opOtherBorrowerGroup" hidden>
                        <label class="op-checkbox-row" for="op-field-otherBorrower">
                            <input id="op-field-otherBorrower" name="otherBorrower" type="checkbox" ${lead.otherBorrower ? 'checked' : ''}>
                            <span class="txt">Заёмщик может быть другим человеком
                                <span class="sub">Показано, потому что вид клиента «Пенсионер» и способ покупки — ипотека</span>
                            </span>
                        </label>
                    </div>
                </div>
            </div>

            <div class="op-form-section">
                <div class="op-section-label">Объект</div>
                <div class="form-grid cols-3">
                    ${selectField('category', 'Категория', lists.category, lead)}
                    ${selectField('propertyType', 'Тип объекта', lists.objType, lead, '— не выбран: жилое —')}
                    ${selectField('propertyClass', 'Класс объекта', lists.objClass, lead, '— не выбран: все классы —')}
                    ${selectField('roomCount', 'Комнатность', lists.rooms, lead)}
                    ${rangePair('Площадь, м²', '— от и до', 'areaFrom', 'areaTo', lead)}
                    ${selectField('finish', 'Отделка', lists.finish, lead)}
                    ${selectField('deliveryDeadline', 'Срок сдачи', lists.deadline, lead, undefined, '— не позже')}
                </div>
            </div>
        </div>

        <div class="op-form-section">
            <div class="op-section-label">Комментарии</div>
            <div class="form-group">
                <textarea id="op-field-notes" name="notes" rows="3">${escapeHtml(lead.notes)}</textarea>
            </div>
        </div>

        <div class="op-form-section">
            <div class="op-section-label">Статус звонка</div>
            <div class="form-group">
                <select id="op-field-funnelStatusId" name="funnelStatusId">
                    ${buildFunnelStatusOptions(statuses, lead.funnelStatusId)}
                </select>
            </div>
        </div>

        <div class="op-card-actions">
            <span class="op-saved-at" id="opSavedAt">${savedAt ? `Последнее сохранение: ${escapeHtml(savedAt)}` : ''}</span>
            <button type="button" class="btn btn-primary" id="opSaveLeadBtn">Сохранить</button>
        </div>
    `;

    initGeoBlocks(container);

    // --- Каскады -----------------------------------------------------------
    const paymentSelect = container.querySelector('#op-field-purchaseMethod');
    const clientTypeSelect = container.querySelector('#op-field-clientType');
    const downPaymentGroup = container.querySelector('#opDownPaymentGroup');
    const downPaymentInput = container.querySelector('#op-field-downPaymentPercent');
    const mortgageGroup = container.querySelector('#opMortgageTypeGroup');
    const mortgageSelect = container.querySelector('#op-field-mortgageType');
    const otherBorrowerGroup = container.querySelector('#opOtherBorrowerGroup');
    const otherBorrowerInput = container.querySelector('#op-field-otherBorrower');

    // Скрытое поле ОБНУЛЯЕТСЯ — у лида это критерий будущего подбора, и
    // «Наличные + первоначальный взнос 20 %» молча испортили бы подбор
    // (решение куратора, dialog.md F3; в форме оффера взнос не сбрасывается —
    // там поле означает условие площадки, а не запрос клиента).
    //
    // НО только при действии оператора. На первой отрисовке (keepValues) поля
    // прячутся без обнуления: у лида, заведённого до появления каскадов, взнос
    // может лежать при пустом способе покупки, и обнуление на открытии стёрло
    // бы его первым же сохранением — данные, которых оператор даже не видел.
    // Это ровно тот класс молчаливой потери, против которого правило C1.
    // Мусор всё равно вычищается, как только оператор трогает способ покупки.
    function applyCascades(keepValues) {
        const payment = paymentSelect.value;

        const showDownPayment = needsDownPayment(payment);
        downPaymentGroup.hidden = !showDownPayment;
        if (!showDownPayment && !keepValues) downPaymentInput.value = '';

        const showMortgage = isMortgage(payment);
        mortgageGroup.hidden = !showMortgage;
        if (!showMortgage && !keepValues) mortgageSelect.value = '';

        const showOtherBorrower = clientTypeSelect.value === RETIREE_VALUE && showMortgage;
        otherBorrowerGroup.hidden = !showOtherBorrower;
        if (!showOtherBorrower && !keepValues) otherBorrowerInput.checked = false;
    }

    // Тронул ли оператор каскад в этом сеансе — от этого зависит, что писать в
    // «иного заёмщика», когда поле скрыто (см. сборку данных ниже).
    let cascadeTouched = false;
    const handleCascadeChange = () => { cascadeTouched = true; applyCascades(false); };
    paymentSelect.addEventListener('change', handleCascadeChange);
    clientTypeSelect.addEventListener('change', handleCascadeChange);
    applyCascades(true);

    // --- Лесенка раскрытия -------------------------------------------------
    // Ступени раскрываются один раз и обратно не сворачиваются. Ступень с уже
    // заполненными данными раскрыта сразу: лесенка нужна, чтобы укоротить
    // форму в начале первого звонка, а не чтобы прятать собранные данные —
    // иначе оператор переспрашивает клиента то, что уже записано (dialog.md D4).
    const geoBody = container.querySelector('#opGeoBody');
    const geoBtn = container.querySelector('#opShowGeoBtn');
    const paramsStep = container.querySelector('#opParamsStep');
    const paramsBody = container.querySelector('#opParamsBody');
    const paramsBtn = container.querySelector('#opShowParamsBtn');

    function openGeoStep() {
        geoBody.hidden = false;
        geoBtn.remove();
        paramsStep.hidden = false;
    }

    function openParamsStep() {
        paramsBody.hidden = false;
        paramsStep.remove();
    }

    geoBtn.addEventListener('click', openGeoStep);
    paramsBtn.addEventListener('click', openParamsStep);

    // otherBorrower учитывается отдельно: он живёт в чекбоксе, а не в value,
    // и заполненный «нет» (false) — это тоже ответ оператора, а не пустота.
    const answeredOtherBorrower = lead.otherBorrower === true || lead.otherBorrower === false;
    const geoFilled = hasAnyValue(container, GEO_KEYS);
    const paramsFilled = hasAnyValue(container, PARAMS_KEYS) || answeredOtherBorrower;

    // Вторая ступень тянет за собой первую: иначе над раскрытым «Бюджетом»
    // висела бы кнопка «Показать географию».
    if (geoFilled || paramsFilled) openGeoStep();
    if (paramsFilled) openParamsStep();

    // --- Сохранение --------------------------------------------------------
    container.querySelector('#opSaveLeadBtn').addEventListener('click', () => {
        const data = {};
        FIELD_KEYS.forEach((key) => {
            const el = container.querySelector(`#op-field-${key}`);
            if (el) data[key] = el.value;
        });
        // Трёхзначность: null — условие показа не выполнено (не спрашивали),
        // true/false — оператор ответил. Не путать «нет» и «не спрашивали».
        // Если поле скрыто, но оператор каскад не трогал, отдаём то, что лежало
        // в базе: карточку могли просто открыть и сохранить, и обнуление стёрло
        // бы чужой ответ (та же логика, что у keepValues в applyCascades).
        if (!otherBorrowerGroup.hidden) {
            data.otherBorrower = otherBorrowerInput.checked;
        } else {
            data.otherBorrower = cascadeTouched ? null : (lead.otherBorrower ?? null);
        }
        onSave(data);
    });
}

// Обновление подписи о сохранении БЕЗ перерисовки формы: перерисовка схлопнула
// бы раскрытые ступени посреди звонка (dialog.md D2).
export function updateSavedAt(container, updatedAt) {
    const el = container.querySelector('#opSavedAt');
    if (!el) return;
    const text = formatDateTime(updatedAt);
    el.textContent = text ? `Последнее сохранение: ${text}` : '';
}
