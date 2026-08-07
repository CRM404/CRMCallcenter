// --- cpaApp.js: страница "CPA-сети" — переключатель сетей (компактная модалка
// "Управление сетями") + офферы недвижимости (основной объём страницы).
// Рекламные площадки временно скрыты (report_2026-08-01.md, п.2, 07.08.2026) —
// уезжают на будущую страницу "Маркетинг"; backend/cpaStorage.js не трогаем.
// Композиция/поля/поведение — из живого Artifact дизайн-сессии (см. dialog.md).

import { initHubNav } from './cpaNav.js';
import { showToast } from './cpaToast.js';
import { initConfirmModal, confirmAction } from './cpaConfirm.js';
import {
    fetchCpaNetworks, createCpaNetwork, updateCpaNetwork, deleteCpaNetwork, fetchOrganization,
    fetchRealEstateOffers, createRealEstateOffer, updateRealEstateOffer, deleteRealEstateOffer
} from './cpaStorage.js';

const STATUS_LABEL = { active: 'Активен', paused: 'На паузе', disabled: 'Отключён', draft: 'Черновик' };
const OBJECT_CLASSES = ['Эконом', 'Комфорт', 'Комфорт+', 'Бизнес', 'Премиум'];

const $ = (s) => document.querySelector(s);

let networks = [];
let offers = [];
let organization = null;

let activeNetworkId = null;
let activeStatus = 'all';
let searchQuery = '';

let editingOfferId = null;
let editingNetworkId = null;

let currentSegments = [];
let currentObjGeo = [];
let currentClientGeo = [];

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function formatMoney(n) {
    if (n === null || n === undefined || n === '') return '—';
    return Number(n).toLocaleString('ru-RU');
}

// --- Сети: переключатель-табы + компактная модалка "Управление сетями" ---

function renderTabs() {
    const wrap = $('#networkTabs');
    wrap.innerHTML = networks.map((n) => {
        const count = offers.filter((o) => o.networkId === n.id).length;
        return `<button type="button" class="network-tab ${n.id === activeNetworkId ? 'active' : ''}" data-id="${n.id}">${escapeHtml(n.name)}<span class="count">${count}</span></button>`;
    }).join('');
    wrap.querySelectorAll('.network-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            activeNetworkId = Number(btn.dataset.id);
            renderTabs();
            renderMeta();
            renderOffersTable();
        });
    });
}

function renderMeta() {
    const meta = $('#networkMeta');
    const n = networks.find((x) => x.id === activeNetworkId);
    if (!n) {
        meta.innerHTML = '';
        return;
    }
    meta.innerHTML = `<b>${escapeHtml(n.organizationName || '—')}</b>комиссия ${n.commissionPercent ?? '—'}% · выплата в ${escapeHtml(n.payoutCurrency || '—')}`;
}

function populateOrgSelect() {
    const select = $('#nfOrg');
    select.innerHTML = '';
    if (organization) {
        const opt = document.createElement('option');
        opt.value = organization.id;
        opt.textContent = organization.name;
        select.appendChild(opt);
    }
}

function renderNetList() {
    const hasOrganization = organization !== null;
    $('#networksLockedNote').hidden = hasOrganization;
    $('#addNetworkBtn').style.display = hasOrganization ? '' : 'none';

    $('#netList').innerHTML = networks.map((n) => `
        <div class="net-row">
            <div style="flex:1">
                <div class="n-name">${escapeHtml(n.name)}</div>
                <div class="n-meta">${escapeHtml(n.organizationName || '—')} · комиссия ${n.commissionPercent ?? '—'}% · ${escapeHtml(n.payoutCurrency || '—')}</div>
            </div>
            <button type="button" class="m-icon-btn" data-nedit="${n.id}" title="Изменить"><i class="fas fa-pencil-alt" aria-hidden="true"></i></button>
            <button type="button" class="m-icon-btn danger" data-ndel="${n.id}" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`).join('');

    $('#netList').querySelectorAll('[data-nedit]').forEach((b) => b.addEventListener('click', () => openNetForm(Number(b.dataset.nedit))));
    $('#netList').querySelectorAll('[data-ndel]').forEach((b) => b.addEventListener('click', () => handleDeleteNetwork(Number(b.dataset.ndel))));
}

function openNetForm(id) {
    editingNetworkId = id || null;
    const n = id ? networks.find((x) => x.id === id) : null;
    $('#nfName').value = n?.name || '';
    populateOrgSelect();
    $('#nfOrg').value = organization ? String(organization.id) : '';
    $('#nfStatus').value = n?.status || 'Активна';
    $('#nfDate').value = n?.connectedAt || '';
    $('#nfCurrency').value = n?.payoutCurrency || '';
    $('#nfCommission').value = n?.commissionPercent ?? '';
    $('#netInlineForm').hidden = false;
}

async function saveNetwork() {
    const data = {
        name: $('#nfName').value.trim(),
        organizationId: organization ? organization.id : null,
        status: $('#nfStatus').value,
        connectedAt: $('#nfDate').value,
        payoutCurrency: $('#nfCurrency').value,
        commissionPercent: $('#nfCommission').value
    };
    if (!data.name) {
        showToast('Заполните обязательное поле: Название', 'error');
        return;
    }
    if (!data.organizationId) {
        showToast('Заполните обязательное поле: Юрлицо', 'error');
        return;
    }
    try {
        if (editingNetworkId === null) {
            await createCpaNetwork(data);
            showToast('Сеть добавлена', 'success');
        } else {
            await updateCpaNetwork(editingNetworkId, data);
            showToast('Изменения сохранены', 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    $('#netInlineForm').hidden = true;
    await loadNetworks();
    await loadOffers();
    renderNetList();
    renderTabs();
    renderMeta();
    renderOffersTable();
}

async function handleDeleteNetwork(id) {
    const n = networks.find((x) => x.id === id);
    if (!n) return;
    const offerCount = offers.filter((o) => o.networkId === id).length;
    const message = offerCount > 0
        ? `Сеть «${n.name}» и связанные с ней офферы (${offerCount}) будут удалены без возможности восстановления.`
        : `Удалить сеть «${n.name}»? Действие необратимо.`;
    const ok = await confirmAction(message);
    if (!ok) return;
    try {
        await deleteCpaNetwork(id);
        showToast('Сеть удалена', 'success');
        await loadNetworks();
        await loadOffers();
        renderNetList();
        renderTabs();
        renderMeta();
        renderOffersTable();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// --- Офферы: таблица + модалка настроек ---

function renderOffersTable() {
    $('#addOfferBtn').disabled = activeNetworkId === null;
    if (activeNetworkId === null) {
        $('#offersBody').innerHTML = '';
        $('#emptyState').textContent = 'Сначала добавьте сеть в «Управление сетями».';
        $('#emptyState').hidden = false;
        $('#statTotal').textContent = '0';
        $('#statActive').textContent = '0';
        $('#statDraft').textContent = '0';
        return;
    }
    $('#emptyState').textContent = 'В этой сети пока нет офферов, подходящих под фильтр.';

    let list = offers.filter((o) => o.networkId === activeNetworkId);
    if (activeStatus !== 'all') list = list.filter((o) => o.status === activeStatus);
    if (searchQuery) list = list.filter((o) => o.name.toLowerCase().includes(searchQuery));

    $('#offersBody').innerHTML = list.map((o) => `
        <tr data-id="${o.id}">
            <td><div class="offer-name">${escapeHtml(o.name)}</div><div class="offer-cat">${escapeHtml(o.category || '—')}</div></td>
            <td><span class="action-tag">${escapeHtml(o.actionType || '—')}</span></td>
            <td><span class="rate-value">${formatMoney(o.rate)}</span>${o.rate !== null && o.rate !== undefined ? '<span class="rate-cur">₽</span>' : ''}</td>
            <td><span class="period">${o.dateStart ? formatDate(o.dateStart) + ' – ' + (o.dateEnd ? formatDate(o.dateEnd) : 'бессрочно') : '—'}</span></td>
            <td><span class="status-chip ${o.status}">${STATUS_LABEL[o.status]}</span></td>
            <td>
                <div class="row-actions">
                    <button type="button" class="m-icon-btn" data-edit="${o.id}" title="Настроить"><i class="fas fa-pencil-alt" aria-hidden="true"></i></button>
                    <button type="button" class="m-icon-btn danger" data-del="${o.id}" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </div>
            </td>
        </tr>`).join('');

    $('#emptyState').hidden = list.length > 0;

    $('#offersBody').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openOfferModal(Number(b.dataset.edit))));
    $('#offersBody').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => handleDeleteOffer(Number(b.dataset.del))));

    const networkOffers = offers.filter((o) => o.networkId === activeNetworkId);
    $('#statTotal').textContent = networkOffers.length;
    $('#statActive').textContent = networkOffers.filter((o) => o.status === 'active').length;
    $('#statDraft').textContent = networkOffers.filter((o) => o.status === 'draft').length;
}

function setChips(containerId, values) {
    document.querySelectorAll(`#${containerId} .chip-opt`).forEach((c) => {
        c.classList.toggle('on', values.includes(c.dataset.v));
        c.onclick = () => c.classList.toggle('on');
    });
}

function getChipValues(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} .chip-opt.on`)).map((c) => c.dataset.v);
}

function renderSegments() {
    $('#fSegments').innerHTML = currentSegments.map((s, i) => `
        <div class="repeat-row segment-row" data-i="${i}">
            <select class="seg-class">
                <option value="">Класс объекта</option>
                ${OBJECT_CLASSES.map((v) => `<option value="${v}"${s.objectClass === v ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
            <div class="range-pair"><input type="number" class="seg-price-min" placeholder="цена от" value="${s.priceMin ?? ''}"><span>—</span><input type="number" class="seg-price-max" placeholder="цена до" value="${s.priceMax ?? ''}"></div>
            <div class="range-pair"><input type="number" class="seg-area-min" placeholder="S от" value="${s.areaMin ?? ''}"><span>—</span><input type="number" class="seg-area-max" placeholder="S до" value="${s.areaMax ?? ''}"></div>
            <button type="button" class="m-icon-btn danger rr-remove" data-rm="${i}"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`).join('') || '<div class="empty-state" style="padding:14px">Сегментов пока нет — по умолчанию действует общий фильтр по типу выше.</div>';
    $('#fSegments').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { currentSegments.splice(Number(b.dataset.rm), 1); renderSegments(); }));
}

function gatherSegments() {
    return Array.from(document.querySelectorAll('#fSegments .segment-row')).map((row) => ({
        objectClass: row.querySelector('.seg-class').value,
        priceMin: row.querySelector('.seg-price-min').value,
        priceMax: row.querySelector('.seg-price-max').value,
        areaMin: row.querySelector('.seg-area-min').value,
        areaMax: row.querySelector('.seg-area-max').value
    }));
}

function renderGeoRows(containerId, store) {
    $('#' + containerId).innerHTML = store.map((r, i) => `
        <div class="repeat-row geo-row" data-i="${i}">
            <input class="geo-region" placeholder="Регион" value="${escapeHtml(r.region || '')}">
            <input class="geo-city" placeholder="Город" value="${escapeHtml(r.city || '')}">
            <input class="geo-district" placeholder="Район" value="${escapeHtml(r.district || '')}">
            <input class="geo-locality" placeholder="Нас. пункт" value="${escapeHtml(r.locality || '')}">
            <button type="button" class="m-icon-btn danger rr-remove" data-rm="${i}"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`).join('') || '<div class="empty-state" style="padding:14px">География не задана — оффер считается доступным по всей стране.</div>';
    $('#' + containerId).querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { store.splice(Number(b.dataset.rm), 1); renderGeoRows(containerId, store); }));
}

function gatherGeoRows(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} .geo-row`)).map((row) => ({
        region: row.querySelector('.geo-region').value,
        city: row.querySelector('.geo-city').value,
        district: row.querySelector('.geo-district').value,
        locality: row.querySelector('.geo-locality').value
    }));
}

function toggleMortgageType() {
    const isMortgage = $('#fPaymentMethod').value === 'Ипотека';
    $('#fMortgageTypeGroup').style.display = isMortgage ? '' : 'none';
}

// «Иной заёмщик» показывается только при «Тип клиента» = «Пенсионер» —
// при уходе от этого значения чекбокс явно сбрасывается (не сохраняем
// значение на случай, если тип клиента снова станет «Пенсионер»).
function toggleOtherBorrower() {
    const isRetiree = $('#fClientType').value === 'Пенсионер';
    $('#fOtherBorrowerGroup').style.display = isRetiree ? '' : 'none';
    if (!isRetiree) $('#fOtherBorrower').checked = false;
}

function openOfferModal(id) {
    editingOfferId = id;
    const o = id ? offers.find((x) => x.id === id) : null;
    const net = networks.find((n) => n.id === activeNetworkId);
    $('#offerModalTitle').textContent = o ? 'Настройка оффера' : 'Новый оффер';
    $('#offerModalSub').textContent = net ? net.name : '';

    $('#fName').value = o?.name || '';
    $('#fCategory').value = o?.category || '';
    $('#fStatus').value = o?.status || 'draft';
    $('#fDateStart').value = o?.dateStart || '';
    $('#fDateEnd').value = o?.dateEnd || '';
    $('#fActionType').value = o?.actionType || 'Целевой лид';
    $('#fRate').value = o?.rate ?? '';
    $('#fHold').value = o?.holdDays ?? '';
    $('#fLeadCheck').value = o?.leadCheck || 'Нет';
    $('#fTargetCriteria').value = o?.targetCriteria || '';
    $('#fNonTargetCriteria').value = o?.nonTargetCriteria || '';
    $('#fDeveloper').value = o?.developer || '';
    $('#fDeadline').value = o?.deadline || '';
    $('#fClientType').value = o?.clientType || 'Ипотечный заёмщик';
    $('#fOtherBorrower').checked = !!o?.otherBorrower;
    toggleOtherBorrower();
    $('#fPurchaseTerm').value = o?.purchaseTerm || 'До 1 месяца';
    $('#fDownPayment').value = o?.downPayment ?? '';
    $('#fPriority').value = o?.priority ?? '';
    $('#fTransferTime').value = o?.transferTime || '';
    $('#fLeadLimit').value = o?.leadLimit ?? '';

    setChips('fObjType', o?.objTypes || []);
    setChips('fFinish', o?.finishes || []);
    setChips('fRooms', o?.rooms || []);

    $('#fPaymentMethod').value = o?.paymentMethod || 'Ипотека';
    $('#fMortgageType').value = o?.mortgageType || 'Господдержка';
    toggleMortgageType();

    currentSegments = (o?.segments || []).map((s) => ({ ...s }));
    currentObjGeo = (o?.objGeo || []).map((r) => ({ ...r }));
    currentClientGeo = (o?.clientGeo || []).map((r) => ({ ...r }));
    renderSegments();
    renderGeoRows('fObjGeo', currentObjGeo);
    renderGeoRows('fClientGeo', currentClientGeo);

    $('#offerModal').hidden = false;
}

function gatherOfferData() {
    return {
        networkId: activeNetworkId,
        name: $('#fName').value.trim(),
        category: $('#fCategory').value,
        status: $('#fStatus').value,
        dateStart: $('#fDateStart').value,
        dateEnd: $('#fDateEnd').value,
        actionType: $('#fActionType').value,
        rate: $('#fRate').value,
        holdDays: $('#fHold').value,
        leadCheck: $('#fLeadCheck').value,
        targetCriteria: $('#fTargetCriteria').value,
        nonTargetCriteria: $('#fNonTargetCriteria').value,
        objTypes: getChipValues('fObjType'),
        finishes: getChipValues('fFinish'),
        rooms: getChipValues('fRooms'),
        developer: $('#fDeveloper').value,
        deadline: $('#fDeadline').value,
        clientType: $('#fClientType').value,
        otherBorrower: $('#fOtherBorrower').checked,
        purchaseTerm: $('#fPurchaseTerm').value,
        downPayment: $('#fDownPayment').value,
        paymentMethod: $('#fPaymentMethod').value,
        mortgageType: $('#fPaymentMethod').value === 'Ипотека' ? $('#fMortgageType').value : '',
        priority: $('#fPriority').value,
        transferTime: $('#fTransferTime').value,
        leadLimit: $('#fLeadLimit').value,
        segments: gatherSegments(),
        objGeo: gatherGeoRows('fObjGeo'),
        clientGeo: gatherGeoRows('fClientGeo')
    };
}

async function saveOffer() {
    const data = gatherOfferData();
    if (!data.name) {
        showToast('Заполните обязательное поле: Название', 'error');
        return;
    }
    if (!data.networkId) {
        showToast('Выберите сеть перед добавлением оффера', 'error');
        return;
    }
    try {
        if (editingOfferId === null) {
            await createRealEstateOffer(data);
            showToast('Оффер добавлен', 'success');
        } else {
            await updateRealEstateOffer(editingOfferId, data);
            showToast('Изменения сохранены', 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    $('#offerModal').hidden = true;
    await loadOffers();
    renderTabs();
    renderOffersTable();
}

async function handleDeleteOffer(id) {
    const o = offers.find((x) => x.id === id);
    if (!o) return;
    const ok = await confirmAction(`Удалить оффер «${o.name}»? Действие необратимо.`);
    if (!ok) return;
    try {
        await deleteRealEstateOffer(id);
        showToast('Оффер удалён', 'success');
        await loadOffers();
        renderTabs();
        renderOffersTable();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// --- Загрузка данных ---

async function loadNetworks() {
    try {
        networks = await fetchCpaNetworks();
    } catch (err) {
        showToast(err.message, 'error');
        networks = [];
    }
    if (!networks.find((n) => n.id === activeNetworkId)) {
        activeNetworkId = networks.length > 0 ? networks[0].id : null;
    }
}

async function loadOffers() {
    try {
        offers = await fetchRealEstateOffers();
    } catch (err) {
        showToast(err.message, 'error');
        offers = [];
    }
}

async function init() {
    initHubNav('cpa');
    initConfirmModal();

    $('#manageNetworksBtn').addEventListener('click', () => { renderNetList(); $('#netInlineForm').hidden = true; $('#networksModal').hidden = false; });
    $('#networksModalClose').addEventListener('click', () => { $('#networksModal').hidden = true; });
    $('#addNetworkBtn').addEventListener('click', () => openNetForm(null));
    $('#netFormCancel').addEventListener('click', () => { $('#netInlineForm').hidden = true; });
    $('#netFormSave').addEventListener('click', saveNetwork);

    $('#addOfferBtn').addEventListener('click', () => openOfferModal(null));
    $('#offerModalClose').addEventListener('click', () => { $('#offerModal').hidden = true; });
    $('#offerModalCancel').addEventListener('click', () => { $('#offerModal').hidden = true; });
    $('#offerModalSave').addEventListener('click', saveOffer);
    $('#fPaymentMethod').addEventListener('change', toggleMortgageType);
    $('#fClientType').addEventListener('change', toggleOtherBorrower);
    $('#addSegmentBtn').addEventListener('click', () => { currentSegments.push({ objectClass: '', priceMin: '', priceMax: '', areaMin: '', areaMax: '' }); renderSegments(); });
    $('#addObjGeoBtn').addEventListener('click', () => { currentObjGeo.push({ region: '', city: '', district: '', locality: '' }); renderGeoRows('fObjGeo', currentObjGeo); });
    $('#addClientGeoBtn').addEventListener('click', () => { currentClientGeo.push({ region: '', city: '', district: '', locality: '' }); renderGeoRows('fClientGeo', currentClientGeo); });

    $('#searchInput').addEventListener('input', (e) => { searchQuery = e.target.value.trim().toLowerCase(); renderOffersTable(); });
    $('#statusFilter').addEventListener('click', (e) => {
        const btn = e.target.closest('.status-pill');
        if (!btn) return;
        document.querySelectorAll('.status-pill').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        activeStatus = btn.dataset.status;
        renderOffersTable();
    });

    document.querySelectorAll('.modal-overlay').forEach((ov) => {
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.querySelectorAll('.modal-overlay:not([hidden])').forEach((m) => { m.hidden = true; });
    });

    try {
        organization = await fetchOrganization();
    } catch (err) {
        showToast(err.message, 'error');
    }

    await loadNetworks();
    await loadOffers();

    renderTabs();
    renderMeta();
    renderOffersTable();
}

init();
