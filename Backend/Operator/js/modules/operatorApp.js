// --- operatorApp.js: инициализация страницы оператора (operator.html) ---

import { requireOperatorIdentity } from './operatorIdentity.js';
import { initOperatorNav } from './operatorNav.js';
import { showToast } from './operatorToast.js';
import { fetchOwnLeads, fetchLead, saveLead, fetchFunnelStatuses, fetchScript, fetchEmployee, setOnLine } from './operatorStorage.js';
import { renderLeadList } from './operatorLeadList.js';
import { createScriptView } from './operatorScript.js';
import { renderLeadForm } from './operatorLeadForm.js';

// "На линии" (report_2026-08-01.md, 13.08.2026) — карточка-переключатель
// над списком лидов. Сам эндпоинт при onLine=true уже разбирает очередь
// зависших лидов на бэке (services/leadDistribution) — здесь только UI.
async function initOnlineToggle(employeeId) {
    const card = document.getElementById('onlineCard');
    const toggle = document.getElementById('onlineToggle');
    const label = document.getElementById('onlineLabel');
    const caption = document.getElementById('onlineCaption');

    function render(onLine) {
        card.classList.toggle('is-online', onLine);
        toggle.checked = onLine;
        label.textContent = onLine ? 'На линии' : 'Не на линии';
        caption.textContent = onLine
            ? 'Готовы принимать новых лидов — попадёте в автораспределение'
            : 'Новые лиды при автораспределении вам не попадут';
    }

    try {
        const employee = await fetchEmployee(employeeId);
        render(!!employee.onLine);
    } catch (e) {
        showToast(e.message, 'error');
    }

    toggle.addEventListener('change', async () => {
        const onLine = toggle.checked;
        toggle.disabled = true;
        try {
            await setOnLine(employeeId, onLine);
            render(onLine);
        } catch (e) {
            showToast(e.message, 'error');
            toggle.checked = !onLine; // откатываем визуально, запрос не прошёл
        } finally {
            toggle.disabled = false;
        }
    });
}

document.addEventListener('DOMContentLoaded', async function() {
    const identity = requireOperatorIdentity();
    if (!identity) return; // уже редиректнуло на operator-login.html

    initOperatorNav();
    initOnlineToggle(identity.id);

    const listView = document.getElementById('opListView');
    const detailView = document.getElementById('opDetailView');
    const backBtn = document.getElementById('opBackToListBtn');
    const scriptPanel = document.getElementById('opScriptPanel');
    const cardPanel = document.getElementById('opCardPanel');

    let statuses = [];
    let statusesById = new Map();

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

    async function openLead(leadId) {
        try {
            const lead = await fetchLead(leadId, identity.id);
            listView.style.display = 'none';
            detailView.style.display = 'block';

            // Скрипт зависит от пары (оффер, статус) КОНКРЕТНОГО лида — запрашивается
            // заново при каждом открытии карточки, без кэша на весь сеанс страницы
            // (кэш по employeeId был корректен, пока скрипт был один на оператора;
            // с подбором по лиду его пришлось убрать — иначе после лида A показывался
            // бы его скрипт и для лида B с другой парой оффер+статус).
            try {
                const currentScript = await fetchScript(identity.id, leadId);
                scriptPanel.innerHTML = '';
                if (currentScript) {
                    createScriptView(scriptPanel, currentScript);
                } else {
                    scriptPanel.innerHTML = '<p class="op-script-end">Для этого статуса скрипт не назначен</p>';
                }
            } catch (e) {
                showToast(e.message, 'error');
                scriptPanel.innerHTML = '';
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
