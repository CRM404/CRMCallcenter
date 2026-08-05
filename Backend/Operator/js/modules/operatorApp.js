// --- operatorApp.js: инициализация страницы оператора (operator.html) ---

import { requireOperatorIdentity } from './operatorIdentity.js';
import { initOperatorNav } from './operatorNav.js';
import { showToast } from './operatorToast.js';
import { fetchOwnLeads, fetchLead, saveLead, fetchFunnelStatuses, fetchScript } from './operatorStorage.js';
import { renderLeadList } from './operatorLeadList.js';
import { createScriptView } from './operatorScript.js';
import { renderLeadForm } from './operatorLeadForm.js';

document.addEventListener('DOMContentLoaded', async function() {
    const identity = requireOperatorIdentity();
    if (!identity) return; // уже редиректнуло на operator-login.html

    initOperatorNav();

    const listView = document.getElementById('opListView');
    const detailView = document.getElementById('opDetailView');
    const backBtn = document.getElementById('opBackToListBtn');
    const scriptPanel = document.getElementById('opScriptPanel');
    const cardPanel = document.getElementById('opCardPanel');

    let statuses = [];
    let statusesById = new Map();
    let script = null;

    try {
        statuses = await fetchFunnelStatuses();
        statusesById = new Map(statuses.map((s) => [s.id, s]));
    } catch (e) {
        showToast(e.message, 'error');
    }

    async function showListView() {
        detailView.style.display = 'none';
        listView.style.display = 'block';
        try {
            const leads = await fetchOwnLeads(identity.id);
            renderLeadList(listView, leads, statusesById, openLead);
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    async function ensureScriptLoaded() {
        if (script) return script;
        try {
            script = await fetchScript();
        } catch (e) {
            if (e.status === 404) {
                scriptPanel.innerHTML = '<p class="op-script-end">Скрипт не найден</p>';
            } else {
                showToast(e.message, 'error');
            }
        }
        return script;
    }

    async function openLead(leadId) {
        try {
            const lead = await fetchLead(leadId, identity.id);
            listView.style.display = 'none';
            detailView.style.display = 'block';

            const currentScript = await ensureScriptLoaded();
            if (currentScript) {
                scriptPanel.innerHTML = '';
                createScriptView(scriptPanel, currentScript);
            }

            renderLeadForm(cardPanel, lead, statuses, async (data) => {
                try {
                    await saveLead(leadId, identity.id, data);
                    showToast('Сохранено', 'success');
                } catch (e) {
                    showToast(e.message, 'error');
                }
            });
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    backBtn.addEventListener('click', showListView);

    await showListView();
});
