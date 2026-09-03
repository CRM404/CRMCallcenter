// ⚠ Значок из набора слоя, а не из Font Awesome (задача 44).
import { icon } from '/ui/icons.js';

// --- operatorGeo.js: гео-автоподсказки (DaData) для карточки клиента ---
// Перенос приёма из Leads/js/modules/leadsGeo.js (страницы проекта не делят
// код: каждая лежит своей статической папкой, общего модуля нет). Отличие
// принципиальное и ради него написан отдельный модуль: в карточке оператора
// ДВА независимых адреса — объекта и клиента, — поэтому контекст сужения
// (regionFiasId/areaFiasId) хранится НЕ в переменных модуля, как там, а свой
// на каждый адресный блок (dialog.md E1). С общим контекстом выбор региона у
// объекта молча сужал бы поиск города у клиента, и требование «подсказки не
// путают адреса» было бы невыполнимо.

import { fetchGeoSuggest } from './operatorStorage.js';
import { showToast } from './operatorToast.js';

const GEO_FIELD_BOUND = { region: 'region', city: 'city', district: 'area', locality: 'settlement' };
const GEO_DEBOUNCE_MS = 300;

let geoSuggestTimer = null;
let geoSuggestRequestId = 0;
let outsideClickBound = false;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function closeGeoSuggest() {
    document.querySelectorAll('.geo-suggest').forEach((el) => el.remove());
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// DaData отдаёт сокращённый тип («обл.», «р-н») отдельным полем — разворачиваем
// его в полный, иначе подсказка читается хуже, чем строка поиска.
function fullTypeText(withType, typeAbbr, typeFull) {
    if (!withType) return '';
    if (!typeAbbr || !typeFull || typeAbbr === typeFull) return withType;
    return withType.replace(new RegExp(`(^|\\s)${escapeRegExp(typeAbbr)}(?=\\s|$)`), (m, p1) => `${p1}${typeFull}`);
}

function geoSuggestionDisplay(bound, data) {
    return fullTypeText(data[`${bound}_with_type`], data[`${bound}_type`], data[`${bound}_type_full`]);
}

function geoSuggestionParts(data) {
    return {
        region: fullTypeText(data.region_with_type, data.region_type, data.region_type_full),
        city: data.city || '',
        area: fullTypeText(data.area_with_type, data.area_type, data.area_type_full),
        settlement: fullTypeText(data.settlement_with_type, data.settlement_type, data.settlement_type_full)
    };
}

function highlightMatch(text, q) {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx)) + '<b>' + escapeHtml(text.slice(idx, idx + q.length)) + '</b>' + escapeHtml(text.slice(idx + q.length));
}

function attachField(input, context) {
    const field = input.dataset.geoLevel;
    const bound = GEO_FIELD_BOUND[field];
    if (!bound) return;

    input.addEventListener('input', () => {
        const q = input.value.trim();
        const fieldEl = input.closest('.geo-field');

        // Ручной ввод расходится с уже сохранённым fias-id этого уровня —
        // сбрасываем сужение, иначе следующий поиск молча уйдёт в контекст
        // региона/района, которого пользователь уже не видит в поле.
        if (field === 'region') { context.regionFiasId = undefined; context.areaFiasId = undefined; }
        if (field === 'district') { context.areaFiasId = undefined; }

        closeGeoSuggest();
        clearTimeout(geoSuggestTimer);
        if (!q) return;

        const requestId = ++geoSuggestRequestId;
        geoSuggestTimer = setTimeout(async () => {
            let suggestions;
            try {
                const result = await fetchGeoSuggest(q, { bound, regionFiasId: field !== 'region' ? context.regionFiasId : undefined });
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
                ? items.map((data, idx) => `<div class="geo-suggest-item" data-i="${idx}">${icon('pin', 'sm')}<span>${highlightMatch(geoSuggestionDisplay(bound, data), q)}</span></div>`).join('')
                : '<div class="geo-suggest-empty">Ничего не найдено</div>';
            fieldEl.appendChild(box);

            box.querySelectorAll('.geo-suggest-item').forEach((item) => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    const data = items[Number(item.dataset.i)];
                    if (!data) return;
                    const parts = geoSuggestionParts(data);
                    input.value = parts[bound];
                    if (field === 'region') { context.regionFiasId = data.region_fias_id; context.areaFiasId = undefined; }
                    if (field === 'district') { context.areaFiasId = data.area_fias_id; }
                    closeGeoSuggest();
                });
            });
        }, GEO_DEBOUNCE_MS);
    });
    input.addEventListener('blur', () => setTimeout(closeGeoSuggest, 120));
}

// Вызывается после КАЖДОЙ отрисовки карточки: форма собирается заново под
// каждого лида, старые обработчики уходят вместе с разметкой. Контекст сужения
// при этом начинается с нуля — это и есть «сброс при открытии другого лида».
export function initGeoBlocks(container) {
    container.querySelectorAll('.geo-block').forEach((block) => {
        const context = { regionFiasId: undefined, areaFiasId: undefined };
        block.querySelectorAll('.geo-field input').forEach((input) => attachField(input, context));
    });

    if (!outsideClickBound) {
        document.addEventListener('click', (e) => { if (!e.target.closest('.geo-field')) closeGeoSuggest(); });
        outsideClickBound = true;
    }
}
