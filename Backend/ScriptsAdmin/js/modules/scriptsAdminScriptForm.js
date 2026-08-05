// --- scriptsAdminScriptForm.js: инлайн-панель создания/редактирования скрипта (название + оффер) ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// state = { editingScript, offers } — editingScript null означает создание.
export function renderScriptForm(container, state, onSave, onCancel) {
    const { editingScript, offers } = state;
    const isEdit = !!editingScript;
    const selectedOfferId = isEdit ? editingScript.offerId : null;

    const offerOptions = offers.map((o) => `<option value="${o.id}" ${o.id === selectedOfferId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');

    container.innerHTML = `
        <h2>${isEdit ? `Редактирование: ${escapeHtml(editingScript.title)}` : 'Новый скрипт'}</h2>
        <form id="saScriptForm">
            <div class="form-group">
                <label for="saScriptFormTitle">Название</label>
                <input type="text" id="saScriptFormTitle" name="title" required value="${isEdit ? escapeHtml(editingScript.title) : ''}">
            </div>
            <div class="form-group">
                <label for="saScriptFormOffer">Оффер</label>
                <select id="saScriptFormOffer" name="offerId">
                    <option value="">— без оффера —</option>
                    ${offerOptions}
                </select>
            </div>
            <div class="sa-actions">
                <button type="submit" class="btn btn-primary">${isEdit ? 'Сохранить' : 'Создать'}</button>
                <button type="button" class="btn btn-secondary" id="saScriptFormCancelBtn">Отмена</button>
            </div>
        </form>
    `;

    container.querySelector('#saScriptForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const title = container.querySelector('#saScriptFormTitle').value;
        const offerValue = container.querySelector('#saScriptFormOffer').value;
        onSave({ title, offerId: offerValue === '' ? null : Number(offerValue) });
    });

    container.querySelector('#saScriptFormCancelBtn').addEventListener('click', onCancel);
}
