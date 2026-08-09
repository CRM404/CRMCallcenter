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
    fetchRealEstateOffers, createRealEstateOffer, updateRealEstateOffer, deleteRealEstateOffer,
    fetchParamLists, addParamValue, deleteParamValue, fetchGeoSuggest
} from './cpaStorage.js';

const STATUS_LABEL = { active: 'Активен', paused: 'На паузе', disabled: 'Отключён', draft: 'Черновик' };

// «Настройка списков» (report_2026-08-01.md, Фаза 2) — 11 управляемых
// справочников формы оффера, значения приходят с бэкенда (paramLists),
// PARAM_META описывает только КАК их применить к полю формы. «Статус»
// сюда намеренно не входит — от него зависит цвет бейджа/логика фильтра.
const PARAM_META = [
    { key: 'category', label: 'Категория', target: 'fCategory', type: 'select' },
    { key: 'actionType', label: 'Тип действия', target: 'fActionType', type: 'select' },
    { key: 'leadCheck', label: 'Наличие проверки лидов', target: 'fLeadCheck', type: 'select' },
    { key: 'objType', label: 'Тип объекта', target: 'fObjType', type: 'chips' },
    { key: 'objClass', label: 'Класс объекта', target: 'fSegments', type: 'segments' },
    { key: 'finish', label: 'Отделка', target: 'fFinish', type: 'chips' },
    { key: 'rooms', label: 'Комнатность', target: 'fSegments', type: 'segments' },
    { key: 'clientType', label: 'Тип клиента', target: 'fClientType', type: 'chips' },
    { key: 'purchaseTerm', label: 'Срок покупки', target: 'fPurchaseTerm', type: 'select' },
    { key: 'paymentMethod', label: 'Способ покупки', target: 'fPaymentMethod', type: 'chips' },
    { key: 'mortgageType', label: 'Виды ипотеки', target: 'fMortgageType', type: 'chips' }
];

const $ = (s) => document.querySelector(s);

let networks = [];
let offers = [];
let organization = null;
let paramLists = {};

let activeNetworkId = null;
let activeStatus = 'all';
let searchQuery = '';

let editingOfferId = null;
let editingNetworkId = null;
let savingAsCopy = false;

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
                    <button type="button" class="m-icon-btn" data-copy="${o.id}" title="Скопировать"><i class="fas fa-copy" aria-hidden="true"></i></button>
                    <button type="button" class="m-icon-btn danger" data-del="${o.id}" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                </div>
            </td>
        </tr>`).join('');

    $('#emptyState').hidden = list.length > 0;

    $('#offersBody').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openOfferModal(Number(b.dataset.edit))));
    $('#offersBody').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => openOfferModal(Number(b.dataset.copy), { asCopy: true })));
    $('#offersBody').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => handleDeleteOffer(Number(b.dataset.del))));

    const networkOffers = offers.filter((o) => o.networkId === activeNetworkId);
    $('#statTotal').textContent = networkOffers.length;
    $('#statActive').textContent = networkOffers.filter((o) => o.status === 'active').length;
    $('#statDraft').textContent = networkOffers.filter((o) => o.status === 'draft').length;
}

function renderSelectOptions(id, list, value) {
    const el = document.getElementById(id);
    el.innerHTML = (list || []).map((v) => `<option>${escapeHtml(v)}</option>`).join('');
    el.value = value && (list || []).includes(value) ? value : ((list || [])[0] || '');
}

function renderChipOptions(id, list, selected, onToggle) {
    const el = document.getElementById(id);
    el.innerHTML = (list || []).map((v) => `<button type="button" class="chip-opt${(selected || []).includes(v) ? ' on' : ''}" data-v="${escapeHtml(v)}">${escapeHtml(v)}</button>`).join('');
    el.querySelectorAll('.chip-opt').forEach((c) => {
        c.onclick = () => { c.classList.toggle('on'); if (onToggle) onToggle(); };
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
                ${(paramLists.objClass || []).map((v) => `<option value="${escapeHtml(v)}"${s.objectClass === v ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}
            </select>
            <select class="seg-rooms">
                <option value="">Комнатность</option>
                ${(paramLists.rooms || []).map((v) => `<option value="${escapeHtml(v)}"${s.roomCount === v ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}
            </select>
            <div class="range-pair"><input type="number" class="seg-price-min" placeholder="цена от" value="${s.priceMin ?? ''}"><span>—</span><input type="number" class="seg-price-max" placeholder="цена до" value="${s.priceMax ?? ''}"></div>
            <div class="range-pair"><input type="number" class="seg-area-min" placeholder="S от" value="${s.areaMin ?? ''}"><span>—</span><input type="number" class="seg-area-max" placeholder="S до" value="${s.areaMax ?? ''}"></div>
            <button type="button" class="m-icon-btn danger rr-remove" data-rm="${i}"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`).join('') || '<div class="empty-state" style="padding:14px">Сегментов пока нет — по умолчанию действует общий фильтр по типу выше.</div>';
    $('#fSegments').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { syncSegmentsFromDom(); currentSegments.splice(Number(b.dataset.rm), 1); renderSegments(); }));
}

function gatherSegments() {
    return Array.from(document.querySelectorAll('#fSegments .segment-row')).map((row) => ({
        objectClass: row.querySelector('.seg-class').value,
        roomCount: row.querySelector('.seg-rooms').value,
        priceMin: row.querySelector('.seg-price-min').value,
        priceMax: row.querySelector('.seg-price-max').value,
        areaMin: row.querySelector('.seg-area-min').value,
        areaMax: row.querySelector('.seg-area-max').value
    }));
}

// Поля строк сегмента не пишут значения в currentSegments по мере ввода (только
// при сохранении оффера через gatherSegments) — без этой подстраховки перед
// каждым push/splice+renderSegments() уже введённые, но не сохранённые значения
// в других строках стирались бы новым рендером из устаревшего currentSegments.
function syncSegmentsFromDom() {
    gatherSegments().forEach((vals, i) => { if (currentSegments[i]) Object.assign(currentSegments[i], vals); });
}

function renderGeoRows(containerId, store) {
    $('#' + containerId).innerHTML = store.map((r, i) => `
        <div class="repeat-row geo-row" data-i="${i}">
            <div class="geo-field"><input class="geo-region" placeholder="Регион" value="${escapeHtml(r.region || '')}"></div>
            <div class="geo-field"><input class="geo-city" placeholder="Город" value="${escapeHtml(r.city || '')}"></div>
            <div class="geo-field"><input class="geo-district" placeholder="Район" value="${escapeHtml(r.district || '')}"></div>
            <div class="geo-field"><input class="geo-locality" placeholder="Нас. пункт" value="${escapeHtml(r.locality || '')}"></div>
            <button type="button" class="m-icon-btn danger rr-remove" data-rm="${i}"><i class="fas fa-trash" aria-hidden="true"></i></button>
        </div>`).join('') || '<div class="empty-state" style="padding:14px">География не задана — оффер считается доступным по всей стране.</div>';
    $('#' + containerId).querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { syncGeoRowsFromDom(containerId, store); store.splice(Number(b.dataset.rm), 1); renderGeoRows(containerId, store); }));
    attachGeoAutocomplete(containerId, store);
}

// --- Подсказки адреса (DaData), report_2026-08-01.md, 09.08.2026 ---

const GEO_SUGGEST_DEBOUNCE_MS = 300;
let geoSuggestTimer = null;
let geoSuggestRequestId = 0;

// Имя поля в store/CSS-классе (.geo-<field>) → уровень адреса DaData
// (from_bound/to_bound). "district" — это "район" в интерфейсе, но у DaData
// такой уровень называется "area".
const GEO_FIELD_BOUND = { region: 'region', city: 'city', district: 'area', locality: 'settlement' };

function closeGeoSuggest() {
    document.querySelectorAll('.geo-suggest').forEach((el) => el.remove());
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// DaData отдаёт "<имя> <тип-аббревиатура>" или "<тип-аббревиатура> <имя>" в
// зависимости от уровня (порядок слов у "область"/"край" и "район"/"посёлок"
// разный, а у "республика" вообще наоборот — "респ Татарстан") — вместо того
// чтобы угадывать порядок, берём уже готовый _with_type и точечно заменяем
// аббревиатуру на полное слово, сохраняя позицию (без сокращений — dialog.md).
function fullTypeText(withType, typeAbbr, typeFull) {
    if (!withType) return '';
    if (!typeAbbr || !typeFull || typeAbbr === typeFull) return withType;
    return withType.replace(new RegExp(`(^|\\s)${escapeRegExp(typeAbbr)}(?=\\s|$)`), (m, p1) => `${p1}${typeFull}`);
}

// «Город» — только имя без типа (поле и так подписано «Город», «город Химки»
// было бы избыточно); регион/район/нас. пункт — с полным словом типа, там тип
// несёт смысл (область vs край, район vs городской округ, посёлок vs деревня).
function geoSuggestionParts(data) {
    return {
        region: fullTypeText(data.region_with_type, data.region_type, data.region_type_full),
        city: data.city || '',
        area: fullTypeText(data.area_with_type, data.area_type, data.area_type_full),
        settlement: fullTypeText(data.settlement_with_type, data.settlement_type, data.settlement_type_full)
    };
}

// Текст подсказки в дропдауне — значение ровно того уровня, который ищем
// (с полным словом типа через fullTypeText), а не склеенный адрес целиком:
// каждое поле подсказывает само за себя (report_2026-08-01.md, 09.08.2026).
function geoSuggestionDisplay(bound, data) {
    return fullTypeText(data[`${bound}_with_type`], data[`${bound}_type`], data[`${bound}_type_full`]);
}

function highlightMatch(text, q) {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx)) + '<b>' + escapeHtml(text.slice(idx, idx + q.length)) + '</b>' + escapeHtml(text.slice(idx + q.length));
}

function attachGeoAutocomplete(containerId, store) {
    $('#' + containerId).querySelectorAll('.geo-field input').forEach((input) => {
        const field = Object.keys(GEO_FIELD_BOUND).find((f) => input.classList.contains(`geo-${f}`));
        const bound = GEO_FIELD_BOUND[field];

        input.addEventListener('input', () => {
            const q = input.value.trim();
            const fieldEl = input.closest('.geo-field');
            const row = input.closest('.geo-row');
            const i = Number(row.dataset.i);

            // Ручной ввод расходится с уже сохранённым fias-id этого уровня —
            // сбрасываем сужение, иначе следующий поиск в этой строке молча
            // уйдёт в контекст региона/района, которого пользователь уже не
            // видит в поле (dialog.md, 09.08.2026).
            if (field === 'region') { store[i].regionFiasId = undefined; store[i].areaFiasId = undefined; }
            if (field === 'district') { store[i].areaFiasId = undefined; }

            closeGeoSuggest();
            clearTimeout(geoSuggestTimer);
            if (!q) return;

            const requestId = ++geoSuggestRequestId;
            geoSuggestTimer = setTimeout(async () => {
                let suggestions;
                try {
                    const regionFiasId = field !== 'region' ? store[i].regionFiasId : undefined;
                    const result = await fetchGeoSuggest(q, { bound, regionFiasId });
                    suggestions = result?.suggestions || [];
                } catch (err) {
                    showToast('Подсказки адреса недоступны — сервис не отвечает. Введите вручную.', 'error');
                    return;
                }
                if (requestId !== geoSuggestRequestId) return;
                if (input.value.trim() !== q) return;

                const items = suggestions.slice(0, 5).map((s) => s.data);
                const box = document.createElement('div');
                box.className = 'geo-suggest';
                box.innerHTML = items.length
                    ? items.map((data, idx) => `<div class="geo-suggest-item" data-i="${idx}"><i class="fas fa-location-dot" aria-hidden="true"></i><span>${highlightMatch(geoSuggestionDisplay(bound, data), q)}</span></div>`).join('')
                    : '<div class="geo-suggest-empty">Ничего не найдено</div>';
                fieldEl.appendChild(box);

                box.querySelectorAll('.geo-suggest-item').forEach((item) => {
                    item.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        const data = items[Number(item.dataset.i)];
                        if (!data) return;
                        const parts = geoSuggestionParts(data);
                        store[i][field] = parts[bound];
                        if (field === 'region') { store[i].regionFiasId = data.region_fias_id; store[i].areaFiasId = undefined; }
                        if (field === 'district') { store[i].areaFiasId = data.area_fias_id; }
                        renderGeoRows(containerId, store);
                    });
                });
            }, GEO_SUGGEST_DEBOUNCE_MS);
        });
        input.addEventListener('blur', () => setTimeout(closeGeoSuggest, 120));
    });
}

document.addEventListener('click', (e) => { if (!e.target.closest('.geo-field')) closeGeoSuggest(); });

function gatherGeoRows(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} .geo-row`)).map((row) => ({
        region: row.querySelector('.geo-region').value,
        city: row.querySelector('.geo-city').value,
        district: row.querySelector('.geo-district').value,
        locality: row.querySelector('.geo-locality').value
    }));
}

// Тот же приём, что и syncSegmentsFromDom — вручную набранный (не выбранный из
// подсказки) текст адреса нигде не пишется в store до сохранения оффера, иначе
// его стирало бы при push/splice+renderGeoRows(). Merge, а не замена store[i],
// т.к. gatherGeoRows не возвращает regionFiasId/areaFiasId — их бы иначе потеряли.
function syncGeoRowsFromDom(containerId, store) {
    gatherGeoRows(containerId).forEach((vals, i) => { if (store[i]) Object.assign(store[i], vals); });
}

// «Способ покупки» — множественный выбор; «Вид ипотеки» показываем, если
// среди выбранных есть хоть один вариант со словом «ипотек» — нестрогое
// совпадение на случай, если значение переименовано через «Настройку списков».
function toggleMortgageType() {
    const isMortgage = getChipValues('fPaymentMethod').some((v) => v.toLowerCase().includes('ипотек'));
    $('#fMortgageTypeGroup').style.display = isMortgage ? '' : 'none';
}

function refreshParamField(key) {
    const meta = PARAM_META.find((m) => m.key === key);
    if (!meta) return;
    if (meta.type === 'select') {
        renderSelectOptions(meta.target, paramLists[key], document.getElementById(meta.target).value);
    } else if (meta.type === 'segments') {
        syncSegmentsFromDom();
        renderSegments();
    } else {
        const onToggle = key === 'paymentMethod' ? toggleMortgageType : key === 'clientType' ? toggleOtherBorrower : null;
        renderChipOptions(meta.target, paramLists[key], getChipValues(meta.target), onToggle);
    }
}

async function handleAddParamValue(key) {
    const input = document.getElementById('padd-' + key);
    const value = input.value.trim();
    if (!value) return;
    if (paramLists[key].some((v) => v.toLowerCase() === value.toLowerCase())) {
        showToast('Такое значение уже есть в списке', 'error');
        return;
    }
    try {
        await addParamValue(key, value);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    paramLists[key].push(value);
    input.value = '';
    renderParamTags(key);
    refreshParamField(key);
    $(`.param-card[data-key="${key}"] .count`).textContent = paramLists[key].length;
}

async function handleRemoveParamValue(key, index) {
    const value = paramLists[key][index];
    try {
        await deleteParamValue(key, value);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    paramLists[key].splice(index, 1);
    renderParamTags(key);
    refreshParamField(key);
    $(`.param-card[data-key="${key}"] .count`).textContent = paramLists[key].length;
}

function renderParamTags(key) {
    $('#ptags-' + key).innerHTML = paramLists[key].map((v, i) =>
        `<span class="param-tag">${escapeHtml(v)}<button type="button" data-rm="${i}">&times;</button></span>`
    ).join('') || '<span style="font-size:12.5px;color:var(--ink-faint)">Список пуст</span>';
    $('#ptags-' + key).querySelectorAll('[data-rm]').forEach((b) => {
        b.addEventListener('click', () => handleRemoveParamValue(key, Number(b.dataset.rm)));
    });
}

function renderParamsPanel() {
    $('#paramsList').innerHTML = PARAM_META.map((m) => `
        <div class="param-card" data-key="${m.key}">
            <button type="button" class="param-card-head" data-toggle="${m.key}">
                <span>${m.label}</span><span class="count">${paramLists[m.key].length}</span>
                <i class="fas fa-chevron-down chevron" aria-hidden="true"></i>
            </button>
            <div class="param-card-body" id="pcb-${m.key}" hidden>
                <div class="param-tags" id="ptags-${m.key}"></div>
                <div class="param-add-row">
                    <input type="text" id="padd-${m.key}" placeholder="Новое значение…">
                    <button type="button" class="btn btn-secondary btn-sm" data-add="${m.key}">Добавить</button>
                </div>
            </div>
        </div>`).join('');

    PARAM_META.forEach((m) => renderParamTags(m.key));

    $('#paramsList').querySelectorAll('[data-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const body = document.getElementById('pcb-' + btn.dataset.toggle);
            body.hidden = !body.hidden;
            btn.classList.toggle('open', !body.hidden);
        });
    });
    $('#paramsList').querySelectorAll('[data-add]').forEach((btn) => {
        const key = btn.dataset.add;
        const submit = () => handleAddParamValue(key);
        btn.addEventListener('click', submit);
        document.getElementById('padd-' + key).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
    });
}

// «Тип клиента» — множественный выбор; «Иной заёмщик» показываем, если
// «Пенсионер» есть среди выбранных значений (точное вхождение — в отличие
// от каскада «вид ипотеки», у «Пенсионер» нет вариантов написания). При
// отсутствии «Пенсионер» среди выбранных — поле скрываем и явно сбрасываем
// чекбокс (не сохраняем значение на случай возврата).
function toggleOtherBorrower() {
    const isRetiree = getChipValues('fClientType').includes('Пенсионер');
    $('#fOtherBorrowerGroup').style.display = isRetiree ? '' : 'none';
    if (!isRetiree) $('#fOtherBorrower').checked = false;
}

async function openOfferModal(id, opts = {}) {
    const asCopy = !!opts.asCopy;
    savingAsCopy = asCopy;
    editingOfferId = asCopy ? null : id; // копия всегда уходит через create, не update — иначе перезапишет оригинал

    // paramLists грузятся один раз при заходе на страницу (init) и живут в памяти
    // вкладки — если другой пользователь тем временем изменил справочники через
    // "Настройку списков", старая вкладка их не увидит без ручного F5. Перечитываем
    // при каждом открытии модалки, чтобы форма/панель всегда показывали то, что
    // реально лежит в БД сейчас, а не снимок на момент загрузки страницы.
    try {
        paramLists = await fetchParamLists();
    } catch (err) {
        showToast(err.message, 'error');
    }

    const o = id ? offers.find((x) => x.id === id) : null;
    const net = networks.find((n) => n.id === activeNetworkId);
    $('#offerModalTitle').textContent = asCopy ? 'Копия оффера' : (o ? 'Настройка оффера' : 'Новый оффер');

    // Модалка всегда открывается в режиме формы, не в режиме "Настройка списков".
    $('#paramsModeToggle').checked = false;
    $('#offerForm').hidden = false;
    $('#paramsPanel').hidden = true;
    $('#offerModalSub').textContent = net ? net.name : '';
    $('#offerModalSave').hidden = false;
    $('#offerModalCancel').textContent = 'Отмена';

    $('#fName').value = o?.name ? (asCopy ? o.name + ' (копия)' : o.name) : '';
    renderSelectOptions('fCategory', paramLists.category, o?.category);
    $('#fStatus').value = asCopy ? 'draft' : (o?.status || 'draft');
    $('#fDateStart').value = o?.dateStart || '';
    $('#fDateEnd').value = o?.dateEnd || '';
    renderSelectOptions('fActionType', paramLists.actionType, o?.actionType);
    $('#fRate').value = o?.rate ?? '';
    $('#fHold').value = o?.holdDays ?? '';
    renderSelectOptions('fLeadCheck', paramLists.leadCheck, o?.leadCheck);
    $('#fTargetCriteria').value = o?.targetCriteria || '';
    $('#fNonTargetCriteria').value = o?.nonTargetCriteria || '';
    $('#fDeveloper').value = o?.developer || '';
    $('#fDeadline').value = o?.deadline || '';
    renderChipOptions('fClientType', paramLists.clientType, o?.clientTypes || [], toggleOtherBorrower);
    $('#fOtherBorrower').checked = !!o?.otherBorrower;
    toggleOtherBorrower();
    renderSelectOptions('fPurchaseTerm', paramLists.purchaseTerm, o?.purchaseTerm);
    $('#fDownPayment').value = o?.downPaymentPercent ?? '';
    $('#fPriority').value = o?.priority ?? '';
    $('#fTransferTime').value = o?.transferTime || '';
    $('#fLeadLimit').value = o?.leadLimit ?? '';

    renderChipOptions('fObjType', paramLists.objType, o?.objTypes || []);
    renderChipOptions('fFinish', paramLists.finish, o?.finishes || []);

    renderChipOptions('fPaymentMethod', paramLists.paymentMethod, o?.paymentMethods || [], toggleMortgageType);
    renderChipOptions('fMortgageType', paramLists.mortgageType, o?.mortgageTypes || []);
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
        developer: $('#fDeveloper').value,
        deadline: $('#fDeadline').value,
        clientTypes: getChipValues('fClientType'),
        otherBorrower: getChipValues('fClientType').includes('Пенсионер') ? $('#fOtherBorrower').checked : null,
        purchaseTerm: $('#fPurchaseTerm').value,
        downPaymentPercent: $('#fDownPayment').value,
        paymentMethods: getChipValues('fPaymentMethod'),
        mortgageTypes: getChipValues('fMortgageType'),
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
            showToast(savingAsCopy ? 'Копия оффера создана' : 'Оффер добавлен', 'success');
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
    $('#paramsModeToggle').addEventListener('change', async (e) => {
        const on = e.target.checked;
        $('#offerForm').hidden = on;
        $('#paramsPanel').hidden = !on;
        const net = networks.find((n) => n.id === activeNetworkId);
        $('#offerModalSub').textContent = on ? 'Настройка списков значений' : (net ? net.name : '');
        $('#offerModalSave').hidden = on;
        $('#offerModalCancel').textContent = on ? 'Готово' : 'Отмена';
        if (on) {
            // Модалка могла провисеть открытой какое-то время до переключения сюда —
            // перечитываем справочники, чтобы не показать устаревший снимок (см. openOfferModal).
            try {
                paramLists = await fetchParamLists();
            } catch (err) {
                showToast(err.message, 'error');
            }
            renderParamsPanel();
        }
    });
    $('#addSegmentBtn').addEventListener('click', () => { syncSegmentsFromDom(); currentSegments.push({ objectClass: '', roomCount: '', priceMin: '', priceMax: '', areaMin: '', areaMax: '' }); renderSegments(); });
    $('#addObjGeoBtn').addEventListener('click', () => { syncGeoRowsFromDom('fObjGeo', currentObjGeo); currentObjGeo.push({ region: '', city: '', district: '', locality: '' }); renderGeoRows('fObjGeo', currentObjGeo); });
    $('#addClientGeoBtn').addEventListener('click', () => { syncGeoRowsFromDom('fClientGeo', currentClientGeo); currentClientGeo.push({ region: '', city: '', district: '', locality: '' }); renderGeoRows('fClientGeo', currentClientGeo); });

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
    try {
        paramLists = await fetchParamLists();
    } catch (err) {
        showToast(err.message, 'error');
        paramLists = {};
    }

    await loadNetworks();
    await loadOffers();

    renderTabs();
    renderMeta();
    renderOffersTable();
}

init();
