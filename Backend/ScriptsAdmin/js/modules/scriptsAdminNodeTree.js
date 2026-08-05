// --- scriptsAdminNodeTree.js: read-only дерево узлов скрипта (для навигации/контекста) ---

import { deleteScriptNode } from './scriptsAdminStorage.js';
import { confirmAction } from './scriptsAdminConfirm.js';
import { showToast } from './scriptsAdminToast.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderNodeLi(node, childrenByParent, selectedId) {
    const children = childrenByParent.get(node.id) || [];
    const childrenHtml = children.length
        ? `<ul>${children.map((c) => renderNodeLi(c, childrenByParent, selectedId)).join('')}</ul>`
        : '';
    const typeLabel = node.nodeType === 'objection' ? 'Возражение' : 'Реплика';
    const labelHtml = node.label ? `<div class="sa-node-label">${escapeHtml(node.label)}</div>` : '';
    const preview = node.content.length > 140 ? node.content.slice(0, 140) + '…' : node.content;

    return `
        <li>
            <div class="sa-node-row${node.id === selectedId ? ' sa-node-selected' : ''}" data-node-id="${node.id}">
                <div class="sa-node-main">
                    <span class="sa-node-type${node.nodeType === 'objection' ? ' objection' : ''}">${typeLabel} · #${node.id}</span>
                    ${labelHtml}
                    <div class="sa-node-content">${escapeHtml(preview)}</div>
                </div>
                <div class="sa-node-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${node.id}">Изменить</button>
                    <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${node.id}">Удалить</button>
                </div>
            </div>
            ${childrenHtml}
        </li>
    `;
}

// onEdit(node) — загрузить узел в форму редактирования; onChanged() — перезагрузить после удаления.
export function renderNodeTree(container, nodes, selectedId, onEdit, onChanged) {
    if (!nodes.length) {
        container.innerHTML = '<div class="sa-empty-state">У скрипта пока нет узлов — добавьте корневой узел справа.</div>';
        return;
    }

    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const childrenByParent = new Map();
    nodes.forEach((n) => {
        if (n.parentId === null) return;
        if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
        childrenByParent.get(n.parentId).push(n);
    });
    childrenByParent.forEach((list) => list.sort((a, b) => a.sortOrder - b.sortOrder));

    const roots = nodes.filter((n) => n.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder);

    container.innerHTML = roots.length
        ? `<div class="sa-tree"><ul>${roots.map((r) => renderNodeLi(r, childrenByParent, selectedId)).join('')}</ul></div>`
        : '<div class="sa-empty-state">Нет корневого узла (это не должно случаться — обратитесь к разработчику).</div>';

    container.querySelectorAll('[data-action="edit"]').forEach((btn) => {
        btn.addEventListener('click', () => onEdit(nodesById.get(Number(btn.dataset.id))));
    });

    container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const node = nodesById.get(Number(btn.dataset.id));
            const childCount = (childrenByParent.get(node.id) || []).length;
            const warning = childCount > 0
                ? ` У узла есть ${childCount} дочерних — они тоже будут удалены.`
                : '';
            const ok = await confirmAction(`Удалить узел #${node.id}?${warning}`);
            if (!ok) return;
            try {
                await deleteScriptNode(node.id);
                showToast('Узел удалён', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });
}
