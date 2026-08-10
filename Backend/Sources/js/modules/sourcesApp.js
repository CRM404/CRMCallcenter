// --- sourcesApp.js: страница «Источники» — площадки (табы-переключатель) +
// вложенные источники (report_2026-08-01.md, 11.08.2026). Композиция и
// поведение — 1:1 с утверждённым макетом дизайн-сессии
// (https://claude.ai/code/artifact/d21a11b5-eaeb-4c10-aaee-b5a2577fcf07),
// переписаны на реальные API-вызовы вместо демо-данных макета.

import {
    fetchPlatforms, createPlatform, updatePlatform, deletePlatform,
    fetchCpaNetworks,
    fetchSources, createSource, updateSource, deleteSource
} from './sourcesStorage.js';
import { showToast } from './sourcesToast.js';
import { initConfirmModal, confirmAction } from './sourcesConfirm.js';
import { initHubNav } from './sourcesNav.js';

const $ = (sel) => document.querySelector(sel);

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

const STATUS_BADGE_CLASS = {
    'Активен': 'active',
    'Неактивен': 'inactive',
    'Актуализация': 'review',
    'Архив': 'archive'
};

const SEARCH_DEBOUNCE_MS = 300;

let platforms = [];
let cpaNetworks = [];
let sources = []; // текущий загруженный список (по активной площадке ИЛИ по поиску)
let activePlatformId = null;
let searchQuery = '';
let statusFilter = 'all';
let selectedIds = new Set();
let searchTimer = null;

let editingPlatformId = null; // редактируемая площадка в инлайн-форме (null = форма создания)
let editingSourceId = null;   // редактируемый источник в модалке (null = создание)
let sourceModalPlatformId = null; // площадка-контекст открытой модалки источника

// ================= Загрузка данных =================

async function loadPlatforms() {
    platforms = await fetchPlatforms();
    if (activePlatformId === null || !platforms.some((p) => p.id === activePlatformId)) {
        activePlatformId = platforms.length ? platforms[0].id : null;
    }
}

async function loadSources() {
    if (searchQuery) {
        sources = await fetchSources({ search: searchQuery });
        return;
    }
    if (activePlatformId === null) {
        sources = [];
        return;
    }
    sources = await fetchSources({ platformId: activePlatformId });
}

// Статистика в шапке — по ВСЕМ источникам (не только текущей вкладке/поиску),
// отдельный агрегирующий эндпоинт бриф не предусматривает — площадок по
// природе немного (report_2026-08-01.md), параллельный запрос по каждой
// площадке дешевле, чем заводить новый эндпоинт ради 3 чисел.
async function loadStats() {
    if (!platforms.length) return { totalSources: 0, activeSources: 0 };
    const perPlatform = await Promise.all(platforms.map((p) => fetchSources({ platformId: p.id })));
    const all = perPlatform.flat();
    return {
        totalSources: all.length,
        activeSources: all.filter((s) => s.status === 'Активен').length
    };
}

async function reloadAll() {
    await loadPlatforms();
    await loadSources();
    renderAll();
    const stats = await loadStats();
    $('#statPlatforms').textContent = platforms.length;
    $('#statSources').textContent = stats.totalSources;
    $('#statActive').textContent = stats.activeSources;
}

// ================= Рендер: площадки/табы =================

function renderPlatformTabs() {
    $('#platformTabs').innerHTML = platforms.map((p) => `
        <button type="button" class="platform-tab ${p.id === activePlatformId ? 'active' : ''} ${p.status === 'Неактивна' ? 'off-status' : ''}" data-id="${p.id}">
            ${escapeHtml(p.name)}<span class="count">${p.sourcesCount ?? 0}</span>
        </button>
    `).join('');
    $('#platformTabs').querySelectorAll('.platform-tab').forEach((btn) => {
        btn.addEventListener('click', async () => {
            activePlatformId = Number(btn.dataset.id);
            searchQuery = '';
            $('#searchInput').value = '';
            clearSelection();
            await loadSources();
            renderAll();
        });
    });
    const active = platforms.find((p) => p.id === activePlatformId);
    $('#platformMeta').innerHTML = active ? `Статус площадки: <b>${escapeHtml(active.status)}</b>` : '';
    $('#addSourceBtn').disabled = activePlatformId === null;
}

// ================= Рендер: таблица источников =================

function visibleSources() {
    if (statusFilter === 'all') return sources;
    return sources.filter((s) => s.status === statusFilter);
}

function renderSourcesTable() {
    const crossPlatform = !!searchQuery;
    $('#thPlatform').hidden = !crossPlatform;
    const rows = visibleSources();

    if (!platforms.length) {
        $('#sourcesBody').innerHTML = '';
        $('#emptyState').hidden = false;
        $('#emptyState').textContent = 'Сначала добавьте площадку в «Управление площадками».';
        return;
    }
    if (!rows.length) {
        $('#sourcesBody').innerHTML = '';
        $('#emptyState').hidden = false;
        $('#emptyState').textContent = crossPlatform ? 'Ничего не найдено по запросу.' : 'У этой площадки пока нет источников, подходящих под фильтр.';
        return;
    }
    $('#emptyState').hidden = true;

    $('#sourcesBody').innerHTML = rows.map((s) => {
        const nets = (s.cpaNetworkNames || []).map((n) => `<span class="net-chip">${escapeHtml(n)}</span>`).join('');
        const badgeClass = STATUS_BADGE_CLASS[s.status] || 'inactive';
        const checked = selectedIds.has(s.id) ? 'checked' : '';
        return `
            <tr class="${selectedIds.has(s.id) ? 'row-selected' : ''}" data-row-id="${s.id}">
                <td class="col-check"><input type="checkbox" class="row-checkbox" data-check-id="${s.id}" ${checked}></td>
                ${crossPlatform ? `<td class="col-platform">${escapeHtml(s.platformName)}</td>` : ''}
                <td class="src-name">${escapeHtml(s.name)}</td>
                <td class="src-geo">${escapeHtml(s.cityRegion)}</td>
                <td><div class="chip-row">${nets}</div></td>
                <td><span class="src-badge ${badgeClass}">${escapeHtml(s.status)}</span></td>
                <td>
                    <div class="row-actions">
                        <button type="button" class="m-icon-btn" data-edit="${s.id}" data-tooltip="Изменить" aria-label="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                        <button type="button" class="m-icon-btn danger" data-del="${s.id}" data-tooltip="Удалить" aria-label="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    $('#sourcesBody').querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const s = sources.find((x) => x.id === Number(btn.dataset.edit));
            openSourceModal(s);
        });
    });
    $('#sourcesBody').querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const s = sources.find((x) => x.id === Number(btn.dataset.del));
            const ok = await confirmAction(`Удалить источник «${s.name}»? Это необратимо.`);
            if (!ok) return;
            try {
                await deleteSource(s.id);
                showToast('Источник удалён', 'success');
                await reloadAll();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });
    $('#sourcesBody').querySelectorAll('[data-check-id]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const id = Number(cb.dataset.checkId);
            if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
            updateMassActionsUI();
            renderSourcesTable();
        });
    });
}

function renderAll() {
    renderPlatformTabs();
    renderSourcesTable();
}

// ================= Массовые действия (только у Источников) =================

function updateMassActionsUI() {
    $('#selectedCount').textContent = `Выбрано: ${selectedIds.size}`;
    const hasSelection = selectedIds.size > 0;
    $('#massActions').classList.toggle('visible', hasSelection);
    $('#sourcesTableCard').classList.toggle('reserve-mass-actions-space', hasSelection);
    const visibleIds = visibleSources().map((s) => s.id);
    $('#headCheckbox').checked = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
}

function clearSelection() {
    selectedIds.clear();
    updateMassActionsUI();
}

$('#headCheckbox').addEventListener('change', (e) => {
    visibleSources().forEach((s) => {
        if (e.target.checked) selectedIds.add(s.id); else selectedIds.delete(s.id);
    });
    updateMassActionsUI();
    renderSourcesTable();
});

$('#massClearBtn').addEventListener('click', () => {
    clearSelection();
    renderSourcesTable();
});

$('#massApplyBtn').addEventListener('click', async () => {
    const action = $('#massActionSelect').value;
    if (!action) {
        showToast('Выберите действие', 'error');
        return;
    }
    if (selectedIds.size === 0) {
        showToast('Выберите хотя бы один источник', 'error');
        return;
    }
    const ids = Array.from(selectedIds);

    if (action === 'delete') {
        const ok = await confirmAction(`Удалить источников: ${ids.length}? Это необратимо.`);
        if (!ok) return;
        let deleted = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                await deleteSource(id);
                deleted++;
            } catch (e) {
                failed++;
            }
        }
        clearSelection();
        await reloadAll();
        if (deleted > 0) showToast(`Удалено источников: ${deleted}`, 'success');
        if (failed > 0) showToast(`Не удалось удалить: ${failed}`, 'error');
        return;
    }

    // Смена статуса — по одному PUT на источник, тело берём из уже
    // загруженного списка (тот же паттерн, что massActions.js «Сотрудники»).
    let changed = 0;
    let failed = 0;
    for (const id of ids) {
        const s = sources.find((x) => x.id === id);
        if (!s) { failed++; continue; }
        if (s.status === action) continue; // уже нужный статус — не трогаем
        try {
            await updateSource(id, {
                platformId: s.platformId,
                name: s.name,
                cityRegion: s.cityRegion,
                status: action,
                cpaNetworkIds: s.cpaNetworkIds
            });
            changed++;
        } catch (e) {
            failed++;
        }
    }
    clearSelection();
    await reloadAll();
    if (changed > 0) showToast(`Статус обновлён для ${changed} источников`, 'success');
    else if (failed === 0) showToast('Нет источников для изменения (уже нужный статус)', 'info');
    if (failed > 0) showToast(`Не удалось обновить ${failed} источников`, 'error');
});

// ================= Модалка источника =================

function renderNetworksGrid(selectedNetworkIds) {
    const selected = new Set(selectedNetworkIds || []);
    $('#sourceNetworksGrid').innerHTML = cpaNetworks.map((n) => `
        <label class="checkbox-pill ${selected.has(n.id) ? 'checked' : ''}">
            <input type="checkbox" value="${n.id}" ${selected.has(n.id) ? 'checked' : ''}>
            ${escapeHtml(n.name)}
        </label>
    `).join('');
    $('#sourceNetworksGrid').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
            cb.closest('.checkbox-pill').classList.toggle('checked', cb.checked);
        });
    });
}

function openSourceModal(source) {
    editingSourceId = source ? source.id : null;
    sourceModalPlatformId = source ? source.platformId : activePlatformId;
    const platform = platforms.find((p) => p.id === sourceModalPlatformId);
    $('#sourceModalTitle').textContent = source ? 'Изменить источник' : 'Новый источник';
    $('#sourceModalPlatformName').textContent = source ? source.platformName : (platform ? platform.name : '—');
    $('#srcName').value = source ? source.name : '';
    $('#srcGeo').value = source ? source.cityRegion : '';
    $('#srcStatus').value = source ? source.status : 'Активен';
    renderNetworksGrid(source ? source.cpaNetworkIds : []);
    $('#sourceModal').hidden = false;
}

function closeSourceModal() {
    $('#sourceModal').hidden = true;
    editingSourceId = null;
    sourceModalPlatformId = null;
}

$('#addSourceBtn').addEventListener('click', () => openSourceModal(null));
$('#sourceModalClose').addEventListener('click', closeSourceModal);
$('#sourceModalCancel').addEventListener('click', closeSourceModal);
$('#sourceModal').addEventListener('click', (e) => { if (e.target.id === 'sourceModal') closeSourceModal(); });

$('#sourceModalSave').addEventListener('click', async () => {
    const cpaNetworkIds = Array.from($('#sourceNetworksGrid').querySelectorAll('input:checked')).map((cb) => Number(cb.value));
    const payload = {
        platformId: sourceModalPlatformId,
        name: $('#srcName').value.trim(),
        cityRegion: $('#srcGeo').value.trim(),
        status: $('#srcStatus').value,
        cpaNetworkIds
    };
    try {
        if (editingSourceId) {
            await updateSource(editingSourceId, payload);
            showToast('Источник сохранён', 'success');
        } else {
            await createSource(payload);
            showToast('Источник добавлен', 'success');
        }
        closeSourceModal();
        await reloadAll();
    } catch (e) {
        showToast(e.message, 'error');
    }
});

// ================= Модалка «Управление площадками» =================

function renderPlatformsList() {
    $('#platformsList').innerHTML = platforms.map((p) => {
        const badgeClass = p.status === 'Активна' ? 'on' : 'off';
        const blocked = p.sourcesCount > 0;
        const deleteBtn = blocked
            ? `<button type="button" class="m-icon-btn danger" disabled data-tooltip="Нельзя удалить — у площадки есть источники (${p.sourcesCount})" aria-label="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>`
            : `<button type="button" class="m-icon-btn danger" data-pdel="${p.id}" data-tooltip="Удалить" aria-label="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>`;
        return `
            <div class="mgmt-row">
                <span class="pf-badge ${badgeClass}">${escapeHtml(p.status)}</span>
                <span class="n-name">${escapeHtml(p.name)}</span>
                <span class="n-meta">Источников: ${p.sourcesCount ?? 0}</span>
                <button type="button" class="m-icon-btn" data-pedit="${p.id}" data-tooltip="Изменить" aria-label="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                ${deleteBtn}
            </div>
        `;
    }).join('');

    $('#platformsList').querySelectorAll('[data-pedit]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const p = platforms.find((x) => x.id === Number(btn.dataset.pedit));
            openPlatformInlineForm(p);
        });
    });
    $('#platformsList').querySelectorAll('[data-pdel]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const p = platforms.find((x) => x.id === Number(btn.dataset.pdel));
            const ok = await confirmAction(`Удалить площадку «${p.name}»? Это необратимо.`);
            if (!ok) return;
            try {
                await deletePlatform(p.id);
                showToast('Площадка удалена', 'success');
                await reloadAll();
                renderPlatformsList();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });
}

function openPlatformInlineForm(platform) {
    editingPlatformId = platform ? platform.id : null;
    $('#pfName').value = platform ? platform.name : '';
    $('#pfStatus').value = platform ? platform.status : 'Активна';
    $('#platformInlineForm').hidden = false;
}

function closePlatformInlineForm() {
    $('#platformInlineForm').hidden = true;
    editingPlatformId = null;
}

$('#managePlatformsBtn').addEventListener('click', () => {
    renderPlatformsList();
    closePlatformInlineForm();
    $('#platformsModal').hidden = false;
});
$('#platformsModalClose').addEventListener('click', () => { $('#platformsModal').hidden = true; });
$('#platformsModal').addEventListener('click', (e) => { if (e.target.id === 'platformsModal') $('#platformsModal').hidden = true; });
$('#addPlatformBtn').addEventListener('click', () => openPlatformInlineForm(null));
$('#platformFormCancel').addEventListener('click', closePlatformInlineForm);

$('#platformFormSave').addEventListener('click', async () => {
    const name = $('#pfName').value.trim();
    if (!name) {
        showToast('Укажите название площадки', 'error');
        return;
    }
    const payload = { name, status: $('#pfStatus').value };
    try {
        if (editingPlatformId) {
            await updatePlatform(editingPlatformId, payload);
            showToast('Площадка сохранена', 'success');
        } else {
            await createPlatform(payload);
            showToast('Площадка добавлена', 'success');
        }
        closePlatformInlineForm();
        await reloadAll();
        renderPlatformsList();
    } catch (e) {
        showToast(e.message, 'error');
    }
});

// ================= Поиск и фильтр статуса =================

$('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value.trim();
    searchTimer = setTimeout(async () => {
        searchQuery = value;
        clearSelection();
        await loadSources();
        renderAll();
    }, SEARCH_DEBOUNCE_MS);
});

$('#statusFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('.status-pill');
    if (!btn) return;
    statusFilter = btn.dataset.status;
    $('#statusFilter').querySelectorAll('.status-pill').forEach((p) => p.classList.toggle('active', p === btn));
    renderSourcesTable();
    updateMassActionsUI();
});

// ================= Инициализация =================

(async () => {
    initHubNav('sources');
    initConfirmModal();
    try {
        cpaNetworks = await fetchCpaNetworks();
        await reloadAll();
    } catch (e) {
        showToast(e.message, 'error');
    }
})();
