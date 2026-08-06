// --- scriptsAdminApp.js: инициализация страницы управления скриптом ---

import {
    fetchScripts, createScript, updateScript,
    fetchScriptNodes, createScriptNode, updateScriptNode, deleteScriptNode,
    fetchOffers, fetchFunnelStatuses,
    fetchEmployees
} from './scriptsAdminStorage.js';
import { renderScriptList } from './scriptsAdminScriptList.js';
import { renderScriptForm } from './scriptsAdminScriptForm.js';
import { renderNodesPanel } from './scriptsAdminNodes.js';
import { renderAssignmentPanel } from './scriptsAdminAssignment.js';
import { initConfirmModal, confirmAction } from './scriptsAdminConfirm.js';
import { initReassignModal } from './scriptsAdminReassignModal.js';
import { showToast } from './scriptsAdminToast.js';

document.addEventListener('DOMContentLoaded', function() {
    initConfirmModal();
    initReassignModal();

    const scriptListEl = document.getElementById('saScriptList');
    const scriptListWrap = document.getElementById('saScriptListWrap');
    const scriptFormPanel = document.getElementById('saScriptFormPanel');
    const nodesSection = document.getElementById('saNodesSection');
    const nodesMetaPanel = document.getElementById('saNodesMetaPanel');
    const nodesPanelEl = document.getElementById('saNodesPanel');
    const assignmentEl = document.getElementById('saAssignmentPanel');
    const hideNodesBtn = document.getElementById('saHideNodesBtn');

    const newScriptBtn = document.getElementById('saNewScriptBtn');

    let offers = [];
    let funnelStatuses = [];
    let selectedScript = null;
    let currentNodes = [];
    let editingScript = null; // используется только формой создания нового скрипта
    let nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };

    async function reloadOffers() {
        try {
            offers = await fetchOffers();
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    async function reloadFunnelStatuses() {
        try {
            funnelStatuses = await fetchFunnelStatuses();
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    async function reloadScripts() {
        try {
            const scripts = await fetchScripts();
            renderScriptList(scriptListEl, scripts, selectedScript ? selectedScript.id : null, openScript, async () => {
                await reloadScripts();
            });
            if (selectedScript) {
                const refreshed = scripts.find((s) => s.id === selectedScript.id);
                if (!refreshed) {
                    selectedScript = null;
                    currentNodes = [];
                    nodesSection.classList.remove('visible');
                    scriptListWrap.hidden = false;
                } else {
                    selectedScript = refreshed;
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

    // Метаданные (Название/Оффер/Статус воронки) — та же форма, что раньше жила
    // в отдельной панели редактирования, теперь встроена в верх открытой панели
    // "Открыть" (кнопка "Изменить" убрана, см. бриф). "Отмена" здесь просто
    // перерисовывает форму текущими сохранёнными значениями — не закрывает и не
    // трогает узлы/операторы ниже (тот же паттерн, что у "Отмена" в редактировании
    // основного текста узла).
    function renderScriptMeta() {
        renderScriptForm(nodesMetaPanel, { editingScript: selectedScript, offers, funnelStatuses }, handleMetaSave, renderScriptMeta);
    }

    async function handleMetaSave({ title, offerId, funnelStatusId }) {
        try {
            await updateScript(selectedScript.id, { title, offerId, funnelStatusId, status: selectedScript.status });
            showToast('Скрипт сохранён', 'success');
            await reloadScripts();
            renderScriptMeta();
        } catch (err) {
            showToast(err.message, 'error');
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

    // "Открыть" — единая панель: метаданные (Название/Оффер/Статус воронки) +
    // узлы + назначение операторов. Замещает список скриптов, как раньше делала
    // отдельная форма редактирования (кнопка "Изменить" убрана, см. бриф).
    async function openScript(script) {
        selectedScript = script;
        nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };
        scriptListWrap.hidden = true;
        nodesSection.classList.add('visible');
        renderScriptMeta();
        await reloadNodes();
        await reloadAssignment();
        nodesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function openScriptFormPanel(script) {
        editingScript = script || null;
        scriptListWrap.hidden = true;
        scriptFormPanel.hidden = false;
        renderScriptForm(scriptFormPanel, { editingScript, offers, funnelStatuses }, handleScriptFormSave, closeScriptFormPanel);
    }

    function closeScriptFormPanel() {
        scriptFormPanel.hidden = true;
        scriptFormPanel.innerHTML = '';
        scriptListWrap.hidden = false;
        editingScript = null;
    }

    async function handleScriptFormSave({ title, offerId, funnelStatusId }) {
        try {
            if (editingScript) {
                await updateScript(editingScript.id, { title, offerId, funnelStatusId, status: editingScript.status });
                showToast('Скрипт сохранён', 'success');
            } else {
                await createScript({ title, offerId, funnelStatusId });
                showToast('Скрипт создан', 'success');
            }
            closeScriptFormPanel();
            await reloadScripts();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    newScriptBtn.addEventListener('click', () => openScriptFormPanel(null));

    // "Скрыть" — полностью убирает объединённую панель (метаданные + узлы +
    // операторы), возвращает к чистому виду "только таблица скриптов".
    hideNodesBtn.addEventListener('click', async () => {
        selectedScript = null;
        currentNodes = [];
        nodesUiState = { rootEditing: false, addingObjection: false, editingObjectionId: null };
        nodesSection.classList.remove('visible');
        nodesMetaPanel.innerHTML = '';
        nodesPanelEl.innerHTML = '';
        assignmentEl.innerHTML = '';
        scriptListWrap.hidden = false;
        await reloadScripts();
    });

    (async () => {
        await reloadOffers();
        await reloadFunnelStatuses();
        await reloadScripts();
    })();
});
