// --- operatorLeadForm.js: карточка клиента (лид) — форма редактирования ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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

const TEXT_FIELDS = [
    { key: 'lastName', label: 'Фамилия' },
    { key: 'firstName', label: 'Имя' },
    { key: 'middleName', label: 'Отчество' },
    { key: 'source', label: 'Источник' }
];

const SEARCH_FIELDS = [
    { key: 'propertyType', label: 'Тип объекта' },
    { key: 'propertyClass', label: 'Класс объекта' },
    { key: 'roomCount', label: 'Комнатность' },
    { key: 'priceFrom', label: 'Цена от', type: 'number' },
    { key: 'priceTo', label: 'Цена до', type: 'number' },
    { key: 'areaFrom', label: 'Площадь от', type: 'number' },
    { key: 'areaTo', label: 'Площадь до', type: 'number' },
    { key: 'deliveryDeadline', label: 'Срок сдачи' }
];

const GEO_FIELDS = [
    { key: 'region', label: 'Область' },
    { key: 'city', label: 'Город' },
    { key: 'district', label: 'Район' },
    { key: 'locality', label: 'Населённый пункт' }
];

const PURCHASE_FIELDS = [
    { key: 'purchaseMethod', label: 'Способ покупки' },
    { key: 'mortgageType', label: 'Вид ипотеки' },
    { key: 'downPaymentPercent', label: 'Первоначальный взнос, %', type: 'number' },
    { key: 'purchaseTimeframe', label: 'Срок покупки' }
];

function renderTextInputs(fields, lead) {
    return fields.map((f) => `
        <div class="form-group">
            <label for="op-field-${f.key}">${f.label}</label>
            <input id="op-field-${f.key}" name="${f.key}" type="${f.type || 'text'}" value="${escapeHtml(lead[f.key])}">
        </div>
    `).join('');
}

export function renderLeadForm(container, lead, statuses, onSave) {
    container.innerHTML = `
        <div class="op-lead-phone">
            <i class="fas fa-phone" aria-hidden="true"></i>
            <input id="op-field-phone" name="phone" type="tel" value="${escapeHtml(lead.phone)}">
        </div>

        <div class="form-group op-form-section">
            <label for="op-field-funnelStatusId">Статус воронки</label>
            <select id="op-field-funnelStatusId" name="funnelStatusId">
                ${buildFunnelStatusOptions(statuses, lead.funnelStatusId)}
            </select>
        </div>

        <div class="op-form-section">
            <h2>Контакты</h2>
            <div class="form-grid">${renderTextInputs(TEXT_FIELDS, lead)}</div>
        </div>

        <div class="op-form-section">
            <h2>Что ищет</h2>
            <div class="form-grid">${renderTextInputs(SEARCH_FIELDS, lead)}</div>
        </div>

        <div class="op-form-section">
            <h2>География</h2>
            <div class="form-grid">${renderTextInputs(GEO_FIELDS, lead)}</div>
        </div>

        <div class="op-form-section">
            <h2>Покупка</h2>
            <div class="form-grid">${renderTextInputs(PURCHASE_FIELDS, lead)}</div>
        </div>

        <div class="op-form-section">
            <h2>Заметки</h2>
            <div class="form-group">
                <textarea id="op-field-notes" name="notes" rows="4">${escapeHtml(lead.notes)}</textarea>
            </div>
        </div>

        <div class="op-card-actions">
            <button type="button" class="btn btn-primary" id="opSaveLeadBtn">Сохранить</button>
        </div>
    `;

    container.querySelector('#opSaveLeadBtn').addEventListener('click', () => {
        const allFields = [...TEXT_FIELDS, ...SEARCH_FIELDS, ...GEO_FIELDS, ...PURCHASE_FIELDS];
        const data = {};
        allFields.forEach((f) => {
            data[f.key] = container.querySelector(`#op-field-${f.key}`).value;
        });
        data.funnelStatusId = container.querySelector('#op-field-funnelStatusId').value;
        data.notes = container.querySelector('#op-field-notes').value;
        data.phone = container.querySelector('#op-field-phone').value;
        onSave(data);
    });
}
