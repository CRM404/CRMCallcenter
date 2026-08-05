// --- scriptsAdminNodeForm.js: форма добавления/редактирования узла скрипта ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function nodePreviewLabel(node) {
    const type = node.nodeType === 'objection' ? 'Возражение' : 'Реплика';
    const text = node.label || node.content;
    const short = text.length > 40 ? text.slice(0, 40) + '…' : text;
    return `#${node.id} · ${type}: ${short}`;
}

function getDescendantIds(nodeId, nodes) {
    const childrenByParent = new Map();
    nodes.forEach((n) => {
        if (n.parentId === null) return;
        if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
        childrenByParent.get(n.parentId).push(n.id);
    });
    const result = new Set();
    const stack = [nodeId];
    while (stack.length) {
        const current = stack.pop();
        const children = childrenByParent.get(current) || [];
        children.forEach((childId) => {
            if (!result.has(childId)) {
                result.add(childId);
                stack.push(childId);
            }
        });
    }
    return result;
}

// state = { nodes, editingNode } — editingNode null означает режим добавления.
export function renderNodeForm(container, state, onSave, onCancelEdit) {
    const { nodes, editingNode } = state;
    const hasRoot = nodes.some((n) => n.parentId === null);
    const isEdit = !!editingNode;

    const excludedIds = isEdit ? new Set([editingNode.id, ...getDescendantIds(editingNode.id, nodes)]) : new Set();
    const parentCandidates = nodes.filter((n) => !excludedIds.has(n.id));

    // Добавление первого узла скрипта — авто-корень, поля "родитель" вообще нет.
    // Иначе — поле обязательно; вариант "без родителя" доступен только когда
    // редактируемый узел уже и есть текущий корень (иначе получим второй корень).
    const showParentField = isEdit || hasRoot;
    const showNullOption = isEdit && editingNode.parentId === null;
    const currentParentId = isEdit ? editingNode.parentId : null;

    const parentOptions = [
        showNullOption ? `<option value="" ${currentParentId === null ? 'selected' : ''}>— без родителя (корень) —</option>` : '',
        ...parentCandidates.map((n) => `<option value="${n.id}" ${n.id === currentParentId ? 'selected' : ''}>${escapeHtml(nodePreviewLabel(n))}</option>`)
    ].filter(Boolean).join('');

    container.innerHTML = `
        <h2>${isEdit ? `Редактирование узла #${editingNode.id}` : 'Добавить узел'}</h2>
        <form id="saNodeForm">
            <div class="form-grid">
                <div class="form-group">
                    <label for="saNodeType">Тип узла</label>
                    <select id="saNodeType" name="nodeType">
                        <option value="statement" ${(!isEdit || editingNode.nodeType === 'statement') ? 'selected' : ''}>Реплика (statement)</option>
                        <option value="objection" ${isEdit && editingNode.nodeType === 'objection' ? 'selected' : ''}>Возражение (objection)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="saNodeLabel">Метка ветки (для возражения)</label>
                    <input id="saNodeLabel" name="label" type="text" value="${escapeHtml(isEdit ? editingNode.label : '')}" placeholder="Например: Возражение: дорого">
                </div>
                ${showParentField ? `
                <div class="form-group">
                    <label for="saNodeParent">Родительский узел</label>
                    <select id="saNodeParent" name="parentId">${parentOptions}</select>
                </div>
                ` : `<input type="hidden" id="saNodeParent" value="">`}
                <div class="form-group">
                    <label for="saNodeSortOrder">Порядок (sort_order)</label>
                    <input id="saNodeSortOrder" name="sortOrder" type="number" value="${isEdit ? editingNode.sortOrder : 0}">
                </div>
            </div>
            <div class="form-group" style="margin-bottom: 16px;">
                <label for="saNodeContent">Текст узла</label>
                <textarea id="saNodeContent" name="content" rows="5">${escapeHtml(isEdit ? editingNode.content : '')}</textarea>
            </div>
            <div class="sa-actions">
                <button type="submit" class="btn btn-primary">${isEdit ? 'Сохранить' : 'Добавить'}</button>
                ${isEdit ? '<button type="button" class="btn btn-secondary" id="saNodeCancelBtn">Отменить редактирование</button>' : ''}
            </div>
        </form>
    `;

    container.querySelector('#saNodeForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const parentField = container.querySelector('#saNodeParent');
        const data = {
            nodeType: container.querySelector('#saNodeType').value,
            label: container.querySelector('#saNodeLabel').value,
            parentId: parentField.value === '' ? null : Number(parentField.value),
            sortOrder: Number(container.querySelector('#saNodeSortOrder').value) || 0,
            content: container.querySelector('#saNodeContent').value
        };
        onSave(data);
    });

    if (isEdit) {
        container.querySelector('#saNodeCancelBtn').addEventListener('click', onCancelEdit);
    }
}
