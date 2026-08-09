// --- scriptsAdminScriptForm.js: инлайн-панель создания/редактирования скрипта (только название) ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// state = { editingScript } — editingScript null означает создание. Оффер и
// статус воронки убраны без замены (report_2026-08-01.md, 09.08.2026) — скрипт
// теперь привязан только к оператору (employee_scripts).
export function renderScriptForm(container, state, onSave, onCancel) {
    const { editingScript } = state;
    const isEdit = !!editingScript;

    container.innerHTML = `
        <h2>${isEdit ? `Редактирование: ${escapeHtml(editingScript.title)}` : 'Новый скрипт'}</h2>
        <form id="saScriptForm">
            <div class="form-group">
                <label for="saScriptFormTitle">Название</label>
                <input type="text" id="saScriptFormTitle" name="title" required value="${isEdit ? escapeHtml(editingScript.title) : ''}">
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
        onSave({ title });
    });

    container.querySelector('#saScriptFormCancelBtn').addEventListener('click', onCancel);
}
