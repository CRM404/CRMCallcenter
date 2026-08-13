// --- leadsApp.js: страница «Лиды» — список, фильтры, настройка колонок,
// массовые действия, статистика (report_2026-08-01.md, 13.08.2026).
// Композиция и поведение — 1:1 с утверждённым макетом дизайн-сессии
// (https://claude.ai/code/artifact/430feb4c-c115-424e-9f29-2d995e110a7a),
// переписаны на реальные API-вызовы вместо демо-данных макета.

import {
    fetchLeads, fetchLeadStats, deleteLead, updateLead,
    fetchAllSources, fetchAllEmployees, fetchAllOffers, fetchFunnelStatuses, fetchParamLists
} from './leadsStorage.js';
import { showToast } from './leadsToast.js';
import { initConfirmModal, confirmAction } from './leadsConfirm.js';
import { initHubNav } from './leadsNav.js';
import { initLeadModal, openLeadModal, fillFunnelStatusSelect } from './leadsModal.js';
import { initUpload } from './leadsUpload.js';

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 30;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(value) {
    if (!value) return '';
    // ISO-таймстамп ('2026-08-13T10:22:00.000Z') или обычная дата — берём
    // только дату, время в этом списке не нужно.
    const datePart = String(value).slice(0, 10);
    const parts = datePart.split('-');
    if (parts.length !== 3) return datePart;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function fullName(lead) {
    return [lead.lastName, lead.firstName, lead.middleName].filter(Boolean).join(' ');
}

// Группировка настройки колонок — 1:1 с макетом (5 групп).
const COLUMN_GROUPS = [
    { label: 'Основное (видно по умолчанию)', columns: [
        { key: 'source', label: 'Источник' },
        { key: 'employee', label: 'Сотрудник' },
        { key: 'funnelStatus', label: 'Статус' },
        { key: 'offer', label: 'Оффер' }
    ] },
    { label: 'Что ищет', columns: [
        { key: 'propertyType', label: 'Тип объекта' },
        { key: 'propertyClass', label: 'Класс объекта' },
        { key: 'roomCount', label: 'Комнатность' },
        { key: 'priceFrom', label: 'Цена от' },
        { key: 'priceTo', label: 'Цена до' },
        { key: 'areaFrom', label: 'Площадь от' },
        { key: 'areaTo', label: 'Площадь до' },
        { key: 'deliveryDeadline', label: 'Срок сдачи' }
    ] },
    { label: 'География', columns: [
        { key: 'region', label: 'Область' },
        { key: 'city', label: 'Город' },
        { key: 'district', label: 'Район' },
        { key: 'locality', label: 'Нас. пункт' }
    ] },
    { label: 'Покупка', columns: [
        { key: 'purchaseMethod', label: 'Способ покупки' },
        { key: 'mortgageType', label: 'Вид ипотеки' },
        { key: 'downPaymentPercent', label: 'ПВ %' },
        { key: 'purchaseTimeframe', label: 'Срок покупки' }
    ] },
    { label: 'Прочее', columns: [
        { key: 'notes', label: 'Комментарии' },
        { key: 'createdAt', label: 'Создан' },
        { key: 'updatedAt', label: 'Обновлён' }
    ] }
];
const COLUMN_ORDER = COLUMN_GROUPS.flatMap((g) => g.columns.map((c) => c.key));
const COLUMN_DEFAULT = COLUMN_ORDER.reduce((acc, key) => {
    acc[key] = key === 'source' || key === 'employee' || key === 'funnelStatus';
    return acc;
}, {});

// Ключ колонки -> lead[field], либо кастомный рендер ячейки.
const COLUMN_CELL = {
    source: (l) => l.sourceName,
    employee: (l) => l.employeeName,
    funnelStatus: (l) => (l.funnelStatusId ? `<span class="stage-badge ${l.stageNumber === 0 ? 'stage-0' : ''}"><span class="stage-num">${l.stageNumber}</span>${escapeHtml(l.statusName)}</span>` : null),
    offer: (l) => l.offerName,
    priceFrom: (l) => l.priceFrom, priceTo: (l) => l.priceTo,
    areaFrom: (l) => l.areaFrom, areaTo: (l) => l.areaTo,
    downPaymentPercent: (l) => l.downPaymentPercent,
    createdAt: (l) => formatDate(l.createdAt), updatedAt: (l) => formatDate(l.updatedAt)
};
function cellHtml(key, lead) {
    if (key === 'funnelStatus') return COLUMN_CELL.funnelStatus(lead) || '—';
    const getValue = COLUMN_CELL[key] || ((l) => l[key]);
    const value = getValue(lead);
    return value !== null && value !== undefined && value !== '' ? escapeHtml(value) : '<span class="muted">—</span>';
}

let sources = [];
let employees = [];
let offers = [];
let statuses = [];
let paramLists = {};

let leads = [];
let filters = { fio: '', phone: '', sourceId: '', employeeId: '', funnelStatusId: '' };
let visibleColumns = { ...COLUMN_DEFAULT };
let selectedIds = new Set();
let offset = 0;
let hasMore = true;

// ================= Загрузка данных =================

async function loadReferenceData() {
    [sources, employees, offers, statuses, paramLists] = await Promise.all([
        fetchAllSources(), fetchAllEmployees(), fetchAllOffers(), fetchFunnelStatuses(), fetchParamLists()
    ]);
}

async function loadStats() {
    try {
        const stats = await fetchLeadStats();
        $('#statTotal').textContent = stats.total;
        $('#statQueue').textContent = stats.queue;
        $('#statToday').textContent = stats.today;
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loadLeads({ reset }) {
    if (reset) offset = 0;
    const batch = await fetchLeads({ ...filters, limit: PAGE_SIZE, offset });
    leads = reset ? batch : leads.concat(batch);
    hasMore = batch.length === PAGE_SIZE;
    offset += batch.length;
}

async function reloadAll() {
    await loadLeads({ reset: true });
    renderAll();
    await loadStats();
}

// ================= Рендер: таблица =================

function applyColumnVisibility() {
    COLUMN_ORDER.forEach((key) => {
        const th = document.getElementById('th-' + key);
        if (th) th.classList.toggle('col-hidden', !visibleColumns[key]);
    });
}

function renderTable() {
    applyColumnVisibility();

    $('#loadMoreRow').hidden = !hasMore;

    if (!leads.length) {
        $('#leadsBody').innerHTML = '';
        $('#emptyState').hidden = false;
        return;
    }
    $('#emptyState').hidden = true;

    $('#leadsBody').innerHTML = leads.map((l) => {
        const name = fullName(l) ? `<span class="lead-name">${escapeHtml(fullName(l))}</span>` : '<span class="muted">— без ФИО —</span>';
        const employeeCell = l.employeeId
            ? escapeHtml(l.employeeName)
            : `<span class="muted">не назначен</span><span class="queue-tag">в очереди</span>`;
        const extraCells = COLUMN_ORDER.map((key) => {
            if (key === 'employee') return `<td class="${visibleColumns[key] ? '' : 'col-hidden'}">${employeeCell}</td>`;
            return `<td class="${visibleColumns[key] ? '' : 'col-hidden'}">${cellHtml(key, l)}</td>`;
        }).join('');
        const checked = selectedIds.has(l.id) ? 'checked' : '';
        return `
            <tr class="${selectedIds.has(l.id) ? 'row-selected' : ''}" data-row-id="${l.id}">
                <td class="col-check"><input type="checkbox" class="row-checkbox" data-check-id="${l.id}" ${checked}></td>
                <td>${l.id}</td>
                <td>${name}</td>
                <td class="lead-phone">${escapeHtml(l.phone)}</td>
                ${extraCells}
                <td class="col-actions">
                    <div class="row-actions">
                        <button type="button" class="m-icon-btn" data-edit="${l.id}" data-tooltip="Изменить" aria-label="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                        <button type="button" class="m-icon-btn danger" data-del="${l.id}" data-tooltip="Удалить" aria-label="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                    </div>
                </td>
            </tr>`;
    }).join('');

    $('#leadsBody').querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const lead = leads.find((x) => x.id === Number(btn.dataset.edit));
            openLeadModal(lead);
        });
    });
    $('#leadsBody').querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const lead = leads.find((x) => x.id === Number(btn.dataset.del));
            const ok = await confirmAction(`Лид #${lead.id}${fullName(lead) ? ' («' + fullName(lead) + '»)' : ''} будет удалён без возможности восстановления.`);
            if (!ok) return;
            try {
                await deleteLead(lead.id);
                showToast('Лид удалён', 'success');
                selectedIds.delete(lead.id);
                await reloadAll();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });
    $('#leadsBody').querySelectorAll('[data-check-id]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const id = Number(cb.dataset.checkId);
            if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
            updateMassActionsUI();
            renderTable();
        });
    });
}

function renderAll() {
    renderTable();
    updateMassActionsUI();
}

$('#loadMoreBtn').addEventListener('click', async () => {
    try {
        await loadLeads({ reset: false });
        renderTable();
    } catch (e) {
        showToast(e.message, 'error');
    }
});

$('#headCheckbox').addEventListener('change', (e) => {
    leads.forEach((l) => { if (e.target.checked) selectedIds.add(l.id); else selectedIds.delete(l.id); });
    updateMassActionsUI();
    renderTable();
});

// ================= Массовые действия =================
// Двухшаговый выбор (действие -> контекстный select), не один <select> с
// захардкоженными парами "действие+значение" — вариантов слишком много
// (~59 статусов, N сотрудников), report_designer.md, п.5.

function updateMassActionsUI() {
    $('#selectedCount').textContent = `Выбрано: ${selectedIds.size}`;
    const hasSelection = selectedIds.size > 0;
    $('#massActions').classList.toggle('visible', hasSelection);
    $('#leadsTableCard')?.classList.toggle('reserve-mass-actions-space', hasSelection);
    $('#headCheckbox').checked = leads.length > 0 && leads.every((l) => selectedIds.has(l.id));
}

function clearSelection() {
    selectedIds.clear();
    updateMassActionsUI();
}

$('#massClearBtn').addEventListener('click', () => { clearSelection(); renderTable(); });

$('#massActionSelect').addEventListener('change', () => {
    const action = $('#massActionSelect').value;
    $('#massEmployeeSelect').hidden = action !== 'employee';
    $('#massStatusSelect').hidden = action !== 'status';
});

$('#massApplyBtn').addEventListener('click', async () => {
    const action = $('#massActionSelect').value;
    if (!action) { showToast('Выберите действие', 'error'); return; }
    if (selectedIds.size === 0) { showToast('Выберите хотя бы одного лида', 'error'); return; }
    const ids = Array.from(selectedIds);

    if (action === 'delete') {
        const ok = await confirmAction(`Будет удалено: ${ids.length}. Действие необратимо.`);
        if (!ok) return;
        let deleted = 0, failed = 0;
        for (const id of ids) {
            try { await deleteLead(id); deleted++; } catch (e) { failed++; }
        }
        clearSelection();
        await reloadAll();
        if (deleted > 0) showToast(`Удалено лидов: ${deleted}`, 'success');
        if (failed > 0) showToast(`Не удалось удалить: ${failed}`, 'error');
        return;
    }

    if (action === 'employee' || action === 'status') {
        const overrideKey = action === 'employee' ? 'employeeId' : 'funnelStatusId';
        const select = action === 'employee' ? $('#massEmployeeSelect') : $('#massStatusSelect');
        if (action === 'status' && !select.value) { showToast('Выберите статус', 'error'); return; }
        const overrideValue = select.value || null;
        let changed = 0, failed = 0;
        for (const id of ids) {
            const lead = leads.find((x) => x.id === id);
            if (!lead) { failed++; continue; }
            try {
                await updateLead(id, { ...lead, [overrideKey]: overrideValue });
                changed++;
            } catch (e) {
                failed++;
            }
        }
        clearSelection();
        await reloadAll();
        if (changed > 0) showToast(action === 'employee' ? `Оператор изменён у ${changed} лид(ов)` : `Статус изменён у ${changed} лид(ов)`, 'success');
        if (failed > 0) showToast(`Не удалось обновить ${failed} лид(ов)`, 'error');
    }
});

// ================= Фильтры =================

function fillFilterSelects() {
    $('#fltSource').innerHTML = '<option value="">Все источники</option>'
        + sources.map((s) => `<option value="${s.id}">${escapeHtml(s.rootSource)}</option>`).join('');
    $('#fltEmployee').innerHTML = '<option value="">Все сотрудники</option><option value="none">— без оператора —</option>'
        + employees.map((e) => `<option value="${e.id}">${escapeHtml(e.lastName + ' ' + e.firstName)}</option>`).join('');
    fillFunnelStatusSelect($('#fltStatus'), statuses, false);
    $('#fltStatus').insertAdjacentHTML('afterbegin', '<option value="">Все статусы</option>');
    // insertAdjacentHTML не переизбирает select — без явного сброса он бы
    // остался на первом реальном статусе, выбранном браузером автоматически
    // ДО вставки плейсхолдера.
    $('#fltStatus').value = '';
}

$('#filterToggleBtn').addEventListener('click', () => { $('#filterModal').hidden = false; });
$('#filterModalClose').addEventListener('click', () => { $('#filterModal').hidden = true; });
$('#filterModal').addEventListener('click', (e) => { if (e.target.id === 'filterModal') $('#filterModal').hidden = true; });
$('#filterClearBtn').addEventListener('click', () => {
    $('#fltFio').value = ''; $('#fltPhone').value = ''; $('#fltSource').value = ''; $('#fltEmployee').value = ''; $('#fltStatus').value = '';
});
$('#filterApplyBtn').addEventListener('click', async () => {
    filters = {
        fio: $('#fltFio').value.trim(),
        phone: $('#fltPhone').value.trim(),
        sourceId: $('#fltSource').value,
        employeeId: $('#fltEmployee').value,
        funnelStatusId: $('#fltStatus').value
    };
    const activeCount = Object.values(filters).filter(Boolean).length;
    $('#filterBadge').hidden = activeCount === 0;
    $('#filterBadge').textContent = activeCount;
    $('#filterModal').hidden = true;
    clearSelection();
    try {
        await loadLeads({ reset: true });
        renderTable();
    } catch (e) {
        showToast(e.message, 'error');
    }
});

// ================= Настройка колонок =================

function renderColumnsModalBody() {
    $('#columnsModalBody').innerHTML = COLUMN_GROUPS.map((group) => `
        <div class="col-group">
            <div class="col-group-label">${escapeHtml(group.label)}</div>
            <div class="column-checkbox-list">
                ${group.columns.map((c) => `<label class="column-checkbox-item"><input type="checkbox" data-col="${c.key}">${escapeHtml(c.label)}</label>`).join('')}
            </div>
        </div>
    `).join('');
}

$('#columnSettingsBtn').addEventListener('click', () => {
    document.querySelectorAll('#columnsModalBody input[data-col]').forEach((cb) => { cb.checked = visibleColumns[cb.dataset.col]; });
    $('#columnsModal').hidden = false;
});
$('#columnsModalClose').addEventListener('click', () => { $('#columnsModal').hidden = true; });
$('#columnsModal').addEventListener('click', (e) => { if (e.target.id === 'columnsModal') $('#columnsModal').hidden = true; });
$('#columnsResetBtn').addEventListener('click', () => {
    document.querySelectorAll('#columnsModalBody input[data-col]').forEach((cb) => { cb.checked = COLUMN_DEFAULT[cb.dataset.col]; });
});
$('#columnsApplyBtn').addEventListener('click', () => {
    document.querySelectorAll('#columnsModalBody input[data-col]').forEach((cb) => { visibleColumns[cb.dataset.col] = cb.checked; });
    $('#columnsModal').hidden = true;
    renderTable();
    showToast('Настройки колонок сохранены', 'success');
});

// ================= Инициализация =================

(async () => {
    initHubNav('leads');
    initConfirmModal();
    try {
        await loadReferenceData();
        fillFilterSelects();
        renderColumnsModalBody();
        initLeadModal({ sources, employees, offers, statuses, paramLists }, reloadAll);
        initUpload({ sources }, reloadAll);
        fillFunnelStatusSelect($('#massStatusSelect'), statuses, false);
        $('#massEmployeeSelect').innerHTML = '<option value="">— не назначен —</option>'
            + employees.map((e) => `<option value="${e.id}">${escapeHtml(e.lastName + ' ' + e.firstName)}</option>`).join('');
        await reloadAll();
    } catch (e) {
        showToast(e.message, 'error');
    }
})();
