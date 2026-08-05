// --- scriptsAdminApp.js: инициализация страницы управления скриптом ---

import {
    fetchScripts, createScript, updateScript,
    fetchScriptNodes, createScriptNode, updateScriptNode, deleteScriptNode,
    fetchOffers, createOffer,
    fetchEmployees
} from './scriptsAdminStorage.js';
import { renderScriptList } from './scriptsAdminScriptList.js';
import { renderScriptForm } from './scriptsAdminScriptForm.js';
import { renderOffersList } from './scriptsAdminOffers.js';
import { renderNodesPanel } from './scriptsAdminNodes.js';
import { renderAssignmentPanel } from './scriptsAdminAssignment.js';
import { initConfirmModal, confirmAction } from './scriptsAdminConfirm.js';
import { showToast } from './scriptsAdminToast.js';

document.addEventListener('DOMContentLoaded', function() {
    initConfirmModal();

    const scriptListEl = document.getElementById('saScriptList');
    const scriptListWrap = document.getElementById('saScriptListWrap');
    const scriptFormPanel = document.getElementById('saScriptFormPanel');
    const nodesSection = document.getElementById('saNodesSection');
    const nodesTitle = document.getElementById('saNodesTitle');
    const nodesPanelEl = document.getElementById('saNodesPanel');
    const assignmentEl = document.getElementById('saAssignmentPanel');

    const newScriptBtn = document.getElementById('saNewScriptBtn');

    const offersToggleBtn = document.getElementById('saToggleOffersBtn');
    const offersPanel = document.getElementById('saOffersPanel');
    const offersListEl = document.getElementById('saOffersList');
    const offerNameInput = document.getElementById('saOfferNameInput');
    const offerAddBtn = document.getElementById('saOfferAddBtn');

    let offers = [];
    let selectedScript = null;
    let currentNodes = [];
    let editingScript = null; // null = создание, объект = редактирование
    let nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };

    async function reloadOffers() {
        try {
            offers = await fetchOffers();
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    async function reloadScripts() {
        try {
            const scripts = await fetchScripts();
            renderScriptList(scriptListEl, scripts, selectedScript ? selectedScript.id : null, openScript, openScriptFormPanel, async () => {
                await reloadScripts();
            });
            if (selectedScript) {
                const refreshed = scripts.find((s) => s.id === selectedScript.id);
                if (!refreshed) {
                    selectedScript = null;
                    nodesSection.classList.remove('visible');
                } else {
                    selectedScript = refreshed;
                    nodesTitle.textContent = `Узлы скрипта: ${refreshed.title}`;
                    await reloadAssignment();
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

    async function reloadAssignment() {
        try {
            const employees = await fetchEmployees();
            renderAssignmentPanel(assignmentEl, selectedScript, employees, async () => {
                await reloadScripts();
            });
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
                } catch (e) {
                    showToast(e.message, 'error');
                }
            }
        });
    }

    async function openScript(script) {
        selectedScript = script;
        nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };
        nodesTitle.textContent = `Узлы скрипта: ${script.title}`;
        nodesSection.classList.add('visible');
        await reloadNodes();
        await reloadAssignment();
        nodesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function openScriptFormPanel(script) {
        editingScript = script || null;
        scriptListWrap.hidden = true;
        scriptFormPanel.hidden = false;
        renderScriptForm(scriptFormPanel, { editingScript, offers }, handleScriptFormSave, closeScriptFormPanel);
    }

    function closeScriptFormPanel() {
        scriptFormPanel.hidden = true;
        scriptFormPanel.innerHTML = '';
        scriptListWrap.hidden = false;
        editingScript = null;
    }

    async function handleScriptFormSave({ title, offerId }) {
        try {
            if (editingScript) {
                await updateScript(editingScript.id, { title, offerId, status: editingScript.status });
                showToast('Скрипт сохранён', 'success');
            } else {
                await createScript({ title, offerId });
                showToast('Скрипт создан', 'success');
            }
            closeScriptFormPanel();
            await reloadScripts();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    newScriptBtn.addEventListener('click', () => openScriptFormPanel(null));

    offersToggleBtn.addEventListener('click', () => {
        offersPanel.hidden = !offersPanel.hidden;
        if (!offersPanel.hidden) renderOffersList(offersListEl, offers);
    });

    offerAddBtn.addEventListener('click', async () => {
        const name = offerNameInput.value;
        if (!name || !name.trim()) {
            showToast('Укажите название оффера', 'error');
            return;
        }
        try {
            await createOffer(name);
            showToast('Оффер добавлен', 'success');
            offerNameInput.value = '';
            await reloadOffers();
            renderOffersList(offersListEl, offers);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });

    (async () => {
        await reloadOffers();
        await reloadScripts();
    })();
});
