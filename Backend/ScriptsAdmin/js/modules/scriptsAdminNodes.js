// --- scriptsAdminNodes.js: узлы скрипта — основной текст (корень) + плоский список возражений ---
// Модель без вложенности: ровно один корневой узел (node_type='statement', parent_id=NULL)
// и плоский список возражений (node_type='objection', parent_id = id корня). Корень
// определяется по parent_id IS NULL, а не по node_type — в существующих данных
// возможен корень с "неправильным" node_type от старой формы; сохранение через
// эту панель всегда принудительно проставляет node_type='statement' корню, само
// исправляя такие записи.

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderRootBlock(root, editing) {
    if (!root) {
        return `
            <div class="sa-root-box">
                <h3>Основной текст</h3>
                <div class="sa-empty-state">У скрипта пока нет основного текста.</div>
                <div class="form-group">
                    <label for="saRootNewContent">Текст</label>
                    <textarea id="saRootNewContent" rows="4" placeholder="Текст, который видит оператор"></textarea>
                </div>
                <div class="sa-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="saRootCreateBtn">Создать основной текст</button>
                </div>
            </div>
        `;
    }
    if (editing) {
        return `
            <div class="sa-root-box">
                <h3>Основной текст</h3>
                <div class="form-group">
                    <label for="saRootEditContent">Текст</label>
                    <textarea id="saRootEditContent" rows="4">${escapeHtml(root.content)}</textarea>
                </div>
                <div class="sa-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="saRootSaveBtn">Сохранить</button>
                    <button type="button" class="btn btn-secondary btn-sm" id="saRootCancelBtn">Отмена</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="sa-root-box">
            <h3>Основной текст</h3>
            <div class="sa-node-content">${escapeHtml(root.content)}</div>
            <div class="sa-actions" style="margin-top:10px;">
                <button type="button" class="btn btn-secondary btn-sm" id="saRootEditBtn">Изменить</button>
            </div>
        </div>
    `;
}

function renderObjectionCard(node, editing) {
    if (editing) {
        return `
            <div class="sa-objection-card" data-id="${node.id}">
                <div class="form-group">
                    <label for="saObjectionEditLabel-${node.id}">Метка</label>
                    <input type="text" id="saObjectionEditLabel-${node.id}" value="${escapeHtml(node.label || '')}">
                </div>
                <div class="form-group">
                    <label for="saObjectionEditContent-${node.id}">Текст</label>
                    <textarea id="saObjectionEditContent-${node.id}" rows="3">${escapeHtml(node.content)}</textarea>
                </div>
                <div class="sa-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="save-objection" data-id="${node.id}">Сохранить</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="cancel-edit-objection" data-id="${node.id}">Отмена</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="sa-objection-card" data-id="${node.id}">
            <div class="sa-node-label">${escapeHtml(node.label || '(без метки)')}</div>
            <div class="sa-node-content">${escapeHtml(node.content)}</div>
            <div class="sa-actions" style="margin-top:8px;">
                <button type="button" class="btn btn-secondary btn-sm" data-action="edit-objection" data-id="${node.id}">Изменить</button>
                <button type="button" class="btn btn-danger btn-sm" data-action="delete-objection" data-id="${node.id}">Удалить</button>
            </div>
        </div>
    `;
}

function renderObjectionsBlock(objections, uiState) {
    const cards = objections.map((o) => renderObjectionCard(o, uiState.editingObjectionId === o.id)).join('');
    const addForm = uiState.addingObjection ? `
        <div class="sa-objection-card">
            <div class="form-group">
                <label for="saObjectionNewLabel">Метка</label>
                <input type="text" id="saObjectionNewLabel" placeholder="Например: Возражение: дорого">
            </div>
            <div class="form-group">
                <label for="saObjectionNewContent">Текст</label>
                <textarea id="saObjectionNewContent" rows="3"></textarea>
            </div>
            <div class="sa-actions">
                <button type="button" class="btn btn-primary btn-sm" id="saObjectionCreateBtn">Добавить</button>
                <button type="button" class="btn btn-secondary btn-sm" id="saObjectionCreateCancelBtn">Отмена</button>
            </div>
        </div>
    ` : '';

    return `
        <div class="sa-objections-box">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
                <h3 style="margin:0;">Возражения</h3>
                ${!uiState.addingObjection ? '<button type="button" class="btn btn-secondary btn-sm" id="saObjectionAddBtn">+ Добавить возражение</button>' : ''}
            </div>
            ${objections.length ? `<div class="sa-objections-list">${cards}</div>` : '<div class="sa-empty-state">Пока нет возражений.</div>'}
            ${addForm}
        </div>
    `;
}

// uiState = { rootEditing, addingObjection, editingObjectionId }
// handlers = { onEditRootStart, onCancelRootEdit, onCreateRoot(content), onSaveRoot(root, content),
//              onAddObjectionStart, onAddObjectionCancel, onCreateObjection({label, content}),
//              onEditObjectionStart(id), onEditObjectionCancel, onSaveObjection(node, {label, content}),
//              onDeleteObjection(id) }
export function renderNodesPanel(container, nodes, uiState, handlers) {
    const root = nodes.find((n) => n.parentId === null) || null;
    const objections = root ? nodes.filter((n) => n.parentId === root.id) : [];

    container.innerHTML = renderRootBlock(root, uiState.rootEditing) + (root ? renderObjectionsBlock(objections, uiState) : '');

    if (!root) {
        container.querySelector('#saRootCreateBtn').addEventListener('click', () => {
            const content = container.querySelector('#saRootNewContent').value;
            handlers.onCreateRoot(content);
        });
        return;
    }

    if (uiState.rootEditing) {
        container.querySelector('#saRootSaveBtn').addEventListener('click', () => {
            const content = container.querySelector('#saRootEditContent').value;
            handlers.onSaveRoot(root, content);
        });
        container.querySelector('#saRootCancelBtn').addEventListener('click', handlers.onCancelRootEdit);
    } else {
        container.querySelector('#saRootEditBtn').addEventListener('click', handlers.onEditRootStart);
    }

    const addBtn = container.querySelector('#saObjectionAddBtn');
    if (addBtn) addBtn.addEventListener('click', handlers.onAddObjectionStart);

    const createBtn = container.querySelector('#saObjectionCreateBtn');
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            const label = container.querySelector('#saObjectionNewLabel').value;
            const content = container.querySelector('#saObjectionNewContent').value;
            handlers.onCreateObjection({ label, content });
        });
        container.querySelector('#saObjectionCreateCancelBtn').addEventListener('click', handlers.onAddObjectionCancel);
    }

    container.querySelectorAll('[data-action="edit-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onEditObjectionStart(Number(btn.dataset.id)));
    });
    container.querySelectorAll('[data-action="cancel-edit-objection"]').forEach((btn) => {
        btn.addEventListener('click', handlers.onEditObjectionCancel);
    });
    container.querySelectorAll('[data-action="save-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.id);
            const label = container.querySelector(`#saObjectionEditLabel-${id}`).value;
            const content = container.querySelector(`#saObjectionEditContent-${id}`).value;
            const node = objections.find((o) => o.id === id);
            handlers.onSaveObjection(node, { label, content });
        });
    });
    container.querySelectorAll('[data-action="delete-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onDeleteObjection(Number(btn.dataset.id)));
    });
}
