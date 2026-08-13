// --- scriptsAdminApp.js: инициализация страницы «Скрипты» ---
// Панель «Операторы, использующие этот скрипт» удалена целиком вместе с
// модулями scriptsAdminAssignment.js / scriptsAdminReassignModal.js: ручной
// привязки операторов к скриптам больше нет, скрипт назначается ЛИДУ на
// странице «Лиды» (решение владельца, 13.08.2026).

import {
    fetchScripts, createScript, updateScript,
    fetchScriptNodes, createScriptNode, updateScriptNode, deleteScriptNode
} from './scriptsAdminStorage.js';
import { renderScriptList } from './scriptsAdminScriptList.js';
import { renderNodesPanel } from './scriptsAdminNodes.js';
import { initConfirmModal, confirmAction } from './scriptsAdminConfirm.js';
import { initHubNav } from './scriptsAdminNav.js';
import { showToast } from './scriptsAdminToast.js';

document.addEventListener('DOMContentLoaded', function() {
    initHubNav('scripts');
    initConfirmModal();

    const scriptListEl = document.getElementById('saScriptList');
    const scriptListWrap = document.getElementById('saScriptListWrap');
    const createPanel = document.getElementById('saCreatePanel');
    const openedSection = document.getElementById('saOpenedSection');
    const nodesPanelEl = document.getElementById('saNodesPanel');
    const metaTitleInput = document.getElementById('saMetaTitle');
    const openStatusChip = document.getElementById('saOpenStatusChip');

    let selectedScript = null;
    let currentNodes = [];
    let nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };

    // Стат-чипы считаются из уже загруженного списка — отдельного эндпоинта
    // под три числа заводить не нужно (решение куратора).
    function renderStats(scripts) {
        document.getElementById('saStatTotal').textContent = scripts.length;
        document.getElementById('saStatActive').textContent = scripts.filter((s) => s.status === 'active').length;
        document.getElementById('saStatDraft').textContent = scripts.filter((s) => s.status === 'draft').length;
    }

    function syncOpenStatusChip() {
        if (!selectedScript) return;
        openStatusChip.className = 'status-chip ' + selectedScript.status;
        openStatusChip.textContent = selectedScript.status === 'active' ? 'Активен' : 'Черновик';
    }

    async function reloadScripts() {
        try {
            const scripts = await fetchScripts();
            renderStats(scripts);
            renderScriptList(scriptListEl, scripts, selectedScript ? selectedScript.id : null, openScript, async () => {
                await reloadScripts();
            });
            if (selectedScript) {
                const refreshed = scripts.find((s) => s.id === selectedScript.id);
                if (!refreshed) {
                    hideOpened();
                } else {
                    selectedScript = refreshed;
                    syncOpenStatusChip();
                }
            }
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    async function reloadNodes() {
        try {
            currentNodes = await fetchScriptNodes(selectedScript.id);
            renderNodes();
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    function renderNodes() {
        renderNodesPanel(nodesPanelEl, currentNodes, nodesUiState, {
            onEditRootStart: () => { nodesUiState.rootEditing = true; renderNodes(); },
            onCancelRootEdit: () => { nodesUiState.rootEditing = false; renderNodes(); },
            onCreateRoot: async (content) => {
                if (!content || !content.trim()) {
                    showToast('Укажите текст', 'error');
                    return;
                }
                try {
                    await createScriptNode(selectedScript.id, { parentId: null, nodeType: 'statement', label: null, content, sortOrder: 0 });
                    showToast('Основной текст создан', 'success');
                    await reloadNodes();
                    await reloadScripts();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            },
            onSaveRoot: async (root, content) => {
                if (!content || !content.trim()) {
                    showToast('Укажите текст', 'error');
                    return;
                }
                try {
                    await updateScriptNode(root.id, { parentId: null, nodeType: 'statement', label: null, content, sortOrder: root.sortOrder });
                    showToast('Основной текст сохранён', 'success');
                    nodesUiState.rootEditing = false;
                    await reloadNodes();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            },
            onAddObjectionStart: () => { nodesUiState.addingObjection = true; renderNodes(); },
            onAddObjectionCancel: () => { nodesUiState.addingObjection = false; renderNodes(); },
            onCreateObjection: async ({ label, content }) => {
                if (!label || !label.trim()) {
                    showToast('Укажите метку возражения', 'error');
                    return;
                }
                if (!content || !content.trim()) {
                    showToast('Укажите текст возражения', 'error');
                    return;
                }
                const root = currentNodes.find((n) => n.parentId === null);
                const maxSortOrder = currentNodes
                    .filter((n) => n.parentId === root.id)
                    .reduce((max, n) => Math.max(max, n.sortOrder), 0);
                try {
                    await createScriptNode(selectedScript.id, { parentId: root.id, nodeType: 'objection', label, content, sortOrder: maxSortOrder + 1 });
                    showToast('Возражение добавлено', 'success');
                    nodesUiState.addingObjection = false;
                    await reloadNodes();
                    await reloadScripts();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            },
            onEditObjectionStart: (id) => { nodesUiState.editingObjectionId = id; renderNodes(); },
            onEditObjectionCancel: () => { nodesUiState.editingObjectionId = null; renderNodes(); },
            onSaveObjection: async (node, { label, content }) => {
                if (!label || !label.trim()) {
                    showToast('Укажите метку возражения', 'error');
                    return;
                }
                if (!content || !content.trim()) {
                    showToast('Укажите текст возражения', 'error');
                    return;
                }
                try {
                    await updateScriptNode(node.id, { parentId: node.parentId, nodeType: 'objection', label, content, sortOrder: node.sortOrder });
                    showToast('Возражение сохранено', 'success');
                    nodesUiState.editingObjectionId = null;
                    await reloadNodes();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            },
            onDeleteObjection: async (id) => {
                const ok = await confirmAction('Удалить это возражение?');
                if (!ok) return;
                try {
                    await deleteScriptNode(id);
                    showToast('Возражение удалено', 'success');
                    await reloadNodes();
                    await reloadScripts();
                } catch (e) {
                    showToast(e.message, 'error');
                }
            }
        });
    }

    // "Открыть" — шапка (название + статус) и наполнение (основной текст +
    // возражения). Список скриптов на это время прячется, как и раньше.
    async function openScript(script) {
        selectedScript = script;
        nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };
        createPanel.hidden = true;
        scriptListWrap.hidden = true;
        openedSection.hidden = false;
        metaTitleInput.value = script.title;
        syncOpenStatusChip();
        await reloadNodes();
        openedSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function hideOpened() {
        selectedScript = null;
        currentNodes = [];
        nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };
        openedSection.hidden = true;
        nodesPanelEl.innerHTML = '';
        scriptListWrap.hidden = false;
    }

    document.getElementById('saMetaSaveBtn').addEventListener('click', async () => {
        const title = metaTitleInput.value.trim();
        if (!title) {
            showToast('Название не может быть пустым', 'error');
            return;
        }
        try {
            await updateScript(selectedScript.id, { title, status: selectedScript.status });
            showToast('Название сохранено', 'success');
            await reloadScripts();
        } catch (e) {
            showToast(e.message, 'error');
        }
    });

    document.getElementById('saHideNodesBtn').addEventListener('click', async () => {
        hideOpened();
        await reloadScripts();
    });

    // Инлайн-создание: единственное поле — название, после создания скрипт
    // сразу открывается на наполнение (как в живой реализации и в макете).
    document.getElementById('saNewScriptBtn').addEventListener('click', () => {
        hideOpened();
        scriptListWrap.hidden = true;
        createPanel.hidden = false;
        document.getElementById('saNewTitle').value = '';
        document.getElementById('saNewTitle').focus();
    });

    function closeCreatePanel() {
        createPanel.hidden = true;
        scriptListWrap.hidden = false;
    }

    document.getElementById('saCreateCancelBtn').addEventListener('click', closeCreatePanel);

    document.getElementById('saCreateBtn').addEventListener('click', async () => {
        const title = document.getElementById('saNewTitle').value.trim();
        if (!title) {
            showToast('Укажите название скрипта', 'error');
            return;
        }
        try {
            const created = await createScript({ title });
            showToast('Скрипт создан', 'success');
            closeCreatePanel();
            await reloadScripts();
            await openScript(created);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });

    (async () => {
        await reloadScripts();
    })();
});
