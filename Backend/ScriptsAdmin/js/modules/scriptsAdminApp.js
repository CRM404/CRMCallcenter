// --- scriptsAdminApp.js: инициализация страницы управления скриптом ---

import {
    fetchScripts, createScript, updateScript,
    fetchScriptNodes, createScriptNode, updateScriptNode,
    fetchOffers, createOffer,
    fetchEmployees
} from './scriptsAdminStorage.js';
import { renderScriptList } from './scriptsAdminScriptList.js';
import { renderNodeTree } from './scriptsAdminNodeTree.js';
import { renderNodeForm } from './scriptsAdminNodeForm.js';
import { renderAssignmentPanel } from './scriptsAdminAssignment.js';
import { initConfirmModal } from './scriptsAdminConfirm.js';
import { showToast } from './scriptsAdminToast.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

document.addEventListener('DOMContentLoaded', function() {
    initConfirmModal();

    const scriptListEl = document.getElementById('saScriptList');
    const nodesSection = document.getElementById('saNodesSection');
    const nodesTitle = document.getElementById('saNodesTitle');
    const treeEl = document.getElementById('saNodeTree');
    const formEl = document.getElementById('saNodeFormContainer');
    const assignmentEl = document.getElementById('saAssignmentPanel');

    const newScriptBtn = document.getElementById('saNewScriptBtn');
    const scriptModal = document.getElementById('scriptModal');
    const scriptModalTitle = document.getElementById('scriptModalTitle');
    const scriptForm = document.getElementById('scriptForm');
    const scriptFormTitle = document.getElementById('scriptFormTitle');
    const scriptFormOffer = document.getElementById('scriptFormOffer');
    const scriptFormNewOfferName = document.getElementById('scriptFormNewOfferName');
    const scriptFormAddOfferBtn = document.getElementById('scriptFormAddOfferBtn');
    const scriptFormSubmitBtn = document.getElementById('scriptFormSubmitBtn');
    const scriptModalCancelBtn = document.getElementById('scriptModalCancelBtn');
    const scriptModalCloseBtn = document.getElementById('scriptModalCloseBtn');

    let offers = [];
    let selectedScript = null;
    let currentNodes = [];
    let editingNode = null;
    let editingScript = null; // null = создание, объект = редактирование

    function renderOfferOptions(selectedOfferId) {
        const options = offers.map((o) => `<option value="${o.id}" ${o.id === selectedOfferId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('');
        scriptFormOffer.innerHTML = `<option value="">— без оффера —</option>${options}`;
    }

    async function reloadOffers(selectedOfferId) {
        try {
            offers = await fetchOffers();
            renderOfferOptions(selectedOfferId);
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    async function reloadScripts() {
        try {
            const scripts = await fetchScripts();
            renderScriptList(scriptListEl, scripts, selectedScript ? selectedScript.id : null, openScript, openEditScriptModal, async () => {
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
            editingNode = null;
            renderTreeAndForm();
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

    function renderTreeAndForm() {
        renderNodeTree(treeEl, currentNodes, editingNode ? editingNode.id : null, (node) => {
            editingNode = node;
            renderTreeAndForm();
        }, async () => {
            await reloadNodes();
            await reloadScripts();
        });

        renderNodeForm(formEl, { nodes: currentNodes, editingNode }, async (data) => {
            try {
                if (editingNode) {
                    await updateScriptNode(editingNode.id, data);
                    showToast('Узел сохранён', 'success');
                } else {
                    await createScriptNode(selectedScript.id, data);
                    showToast('Узел добавлен', 'success');
                }
                await reloadNodes();
            } catch (e) {
                showToast(e.message, 'error');
            }
        }, () => {
            editingNode = null;
            renderTreeAndForm();
        });
    }

    async function openScript(script) {
        selectedScript = script;
        nodesTitle.textContent = `Узлы скрипта: ${script.title}`;
        nodesSection.classList.add('visible');
        await reloadNodes();
        await reloadAssignment();
        nodesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function openScriptModal() {
        editingScript = null;
        scriptModalTitle.textContent = 'Новый скрипт';
        scriptFormSubmitBtn.textContent = 'Создать';
        scriptForm.reset();
        renderOfferOptions(null);
        scriptModal.hidden = false;
    }

    function openEditScriptModal(script) {
        editingScript = script;
        scriptModalTitle.textContent = `Редактирование: ${script.title}`;
        scriptFormSubmitBtn.textContent = 'Сохранить';
        scriptFormTitle.value = script.title;
        renderOfferOptions(script.offerId);
        scriptModal.hidden = false;
    }

    function closeScriptModal() {
        scriptModal.hidden = true;
        scriptForm.reset();
        editingScript = null;
    }

    newScriptBtn.addEventListener('click', openScriptModal);
    scriptModalCancelBtn.addEventListener('click', closeScriptModal);
    scriptModalCloseBtn.addEventListener('click', closeScriptModal);
    scriptModal.addEventListener('click', (e) => { if (e.target === scriptModal) closeScriptModal(); });

    scriptFormAddOfferBtn.addEventListener('click', async () => {
        const name = scriptFormNewOfferName.value;
        if (!name || !name.trim()) {
            showToast('Укажите название оффера', 'error');
            return;
        }
        try {
            const offer = await createOffer(name);
            showToast('Оффер добавлен', 'success');
            scriptFormNewOfferName.value = '';
            await reloadOffers(offer.id);
        } catch (e) {
            showToast(e.message, 'error');
        }
    });

    scriptForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = scriptFormTitle.value;
        const offerId = scriptFormOffer.value === '' ? null : Number(scriptFormOffer.value);
        try {
            if (editingScript) {
                await updateScript(editingScript.id, { title, offerId, status: editingScript.status });
                showToast('Скрипт сохранён', 'success');
            } else {
                await createScript({ title, offerId });
                showToast('Скрипт создан', 'success');
            }
            closeScriptModal();
            await reloadScripts();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    (async () => {
        await reloadOffers(null);
        await reloadScripts();
    })();
});
