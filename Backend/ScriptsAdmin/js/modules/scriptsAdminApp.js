// --- scriptsAdminApp.js: инициализация страницы управления скриптом ---

import {
    fetchScripts, createScript,
    fetchScriptNodes, createScriptNode, updateScriptNode
} from './scriptsAdminStorage.js';
import { renderScriptList } from './scriptsAdminScriptList.js';
import { renderNodeTree } from './scriptsAdminNodeTree.js';
import { renderNodeForm } from './scriptsAdminNodeForm.js';
import { initConfirmModal } from './scriptsAdminConfirm.js';
import { showToast } from './scriptsAdminToast.js';

document.addEventListener('DOMContentLoaded', function() {
    initConfirmModal();

    const scriptListEl = document.getElementById('saScriptList');
    const nodesSection = document.getElementById('saNodesSection');
    const nodesTitle = document.getElementById('saNodesTitle');
    const treeEl = document.getElementById('saNodeTree');
    const formEl = document.getElementById('saNodeFormContainer');

    const newScriptBtn = document.getElementById('saNewScriptBtn');
    const newScriptModal = document.getElementById('newScriptModal');
    const newScriptForm = document.getElementById('newScriptForm');
    const newScriptCancelBtn = document.getElementById('newScriptCancelBtn');
    const newScriptCloseBtn = document.getElementById('newScriptCloseBtn');

    let selectedScript = null;
    let currentNodes = [];
    let editingNode = null;

    async function reloadScripts() {
        try {
            const scripts = await fetchScripts();
            renderScriptList(scriptListEl, scripts, selectedScript ? selectedScript.id : null, openScript, async () => {
                await reloadScripts();
                if (selectedScript) {
                    const stillExists = scripts.find((s) => s.id === selectedScript.id);
                    if (!stillExists) {
                        selectedScript = null;
                        nodesSection.classList.remove('visible');
                    } else {
                        selectedScript = stillExists;
                    }
                }
            });
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
        await reloadScripts();
        nodesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    newScriptBtn.addEventListener('click', () => { newScriptModal.hidden = false; });
    newScriptCancelBtn.addEventListener('click', () => { newScriptModal.hidden = true; });
    newScriptCloseBtn.addEventListener('click', () => { newScriptModal.hidden = true; });
    newScriptModal.addEventListener('click', (e) => { if (e.target === newScriptModal) newScriptModal.hidden = true; });

    newScriptForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('newScriptTitle').value;
        try {
            await createScript(title);
            showToast('Скрипт создан', 'success');
            newScriptModal.hidden = true;
            newScriptForm.reset();
            await reloadScripts();
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    reloadScripts();
});
