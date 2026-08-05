// --- operatorScript.js: пошаговый показ дерева скрипта звонка ---
// Виден только текущий узел; под текстом — кнопки для перехода к дочерним узлам
// (в первую очередь это узлы-возражения, но переход поддержан для любого дочернего
// узла — у возражения тоже может быть своё продолжение). Кнопки "назад" нет
// (отклонено куратором). Если у узла нет детей — "Конец скрипта".

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function createScriptView(container, script) {
    const nodesById = new Map(script.nodes.map((n) => [n.id, n]));
    const childrenByParent = new Map();
    script.nodes.forEach((n) => {
        const key = n.parentId === null ? 'root' : n.parentId;
        if (!childrenByParent.has(key)) childrenByParent.set(key, []);
        childrenByParent.get(key).push(n);
    });
    childrenByParent.forEach((list) => list.sort((a, b) => a.sortOrder - b.sortOrder));

    const rootNodes = childrenByParent.get('root') || [];
    let currentNode = rootNodes[0] || null;

    function render() {
        if (!currentNode) {
            container.innerHTML = '<p class="op-script-end">Скрипт пуст.</p>';
            return;
        }

        const children = childrenByParent.get(currentNode.id) || [];
        const buttonsHtml = children.length
            ? `<div class="op-script-objections">${children.map((child) => `
                <button type="button" class="btn btn-secondary btn-sm" data-node-id="${child.id}">
                    ${escapeHtml(child.label || (child.nodeType === 'objection' ? 'Возражение' : 'Далее'))}
                </button>
            `).join('')}</div>`
            : '<p class="op-script-end">Конец скрипта</p>';

        container.innerHTML = `
            <div class="op-script-content">${escapeHtml(currentNode.content)}</div>
            ${buttonsHtml}
        `;

        container.querySelectorAll('[data-node-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                currentNode = nodesById.get(Number(btn.dataset.nodeId));
                render();
            });
        });
    }

    render();
}
