// --- scriptsAdminScriptForm.js: инлайн-панель создания/редактирования скрипта (название + оффер + статус воронки) ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Статусы группируются по этапу (stageNumber) — тот же паттерн, что в
// Operator/js/modules/operatorLeadForm.js (независимая копия, т.к. это разные
// страницы со своими storage/render модулями).
function buildFunnelStatusOptions(funnelStatuses, selectedId) {
    const byStage = new Map();
    funnelStatuses.forEach((s) => {
        if (!byStage.has(s.stageNumber)) byStage.set(s.stageNumber, { stageName: s.stageName, items: [] });
        byStage.get(s.stageNumber).items.push(s);
    });
    const stageNumbers = Array.from(byStage.keys()).sort((a, b) => a - b);
    return stageNumbers.map((num) => {
        const { stageName, items } = byStage.get(num);
        const options = items.map((s) => `
            <option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.statusName)}</option>
        `).join('');
        return `<optgroup label="${escapeHtml(`${num}. ${stageName}`)}">${options}</optgroup>`;
    }).join('');
}

// state = { editingScript, offers, funnelStatuses } — editingScript null означает создание.
// Оффер и статус воронки — оба обязательны (пара однозначно определяет скрипт).
export function renderScriptForm(container, state, onSave, onCancel) {
    const { editingScript, offers, funnelStatuses } = state;
    const isEdit = !!editingScript;
    const selectedOfferId = isEdit ? editingScript.offerId : null;
    const selectedFunnelStatusId = isEdit ? editingScript.funnelStatusId : null;

    const offerOptions = offers.map((o) => `<option value="${o.id}" ${o.id === selectedOfferId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');
    const funnelStatusOptions = buildFunnelStatusOptions(funnelStatuses, selectedFunnelStatusId);

    container.innerHTML = `
        <h2>${isEdit ? `Редактирование: ${escapeHtml(editingScript.title)}` : 'Новый скрипт'}</h2>
        <form id="saScriptForm">
            <div class="form-group">
                <label for="saScriptFormTitle">Название</label>
                <input type="text" id="saScriptFormTitle" name="title" required value="${isEdit ? escapeHtml(editingScript.title) : ''}">
            </div>
            <div class="form-group">
                <label for="saScriptFormOffer">Оффер</label>
                <select id="saScriptFormOffer" name="offerId" required>
                    <option value="">— выберите —</option>
                    ${offerOptions}
                </select>
            </div>
            <div class="form-group">
                <label for="saScriptFormFunnelStatus">Статус воронки</label>
                <select id="saScriptFormFunnelStatus" name="funnelStatusId" required>
                    <option value="">— выберите —</option>
                    ${funnelStatusOptions}
                </select>
            </div>
            <div class="sa-actions">
                <button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Сохранить' : 'Создать'}</button>
                <button type="button" class="btn btn-secondary btn-sm" id="saScriptFormCancelBtn">Отмена</button>
            </div>
        </form>
    `;

    container.querySelector('#saScriptForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const title = container.querySelector('#saScriptFormTitle').value;
        const offerId = Number(container.querySelector('#saScriptFormOffer').value);
        const funnelStatusId = Number(container.querySelector('#saScriptFormFunnelStatus').value);
        onSave({ title, offerId, funnelStatusId });
    });

    container.querySelector('#saScriptFormCancelBtn').addEventListener('click', onCancel);
}
