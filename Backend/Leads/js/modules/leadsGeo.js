// --- leadsGeo.js: гео-автоподсказки (DaData) для модалки лида —
// упрощённая версия attachGeoAutocomplete из CpaNetworks/js/modules/cpaApp.js
// (report_2026-08-01.md, 13.08.2026): там это повторяемые строки критериев
// оффера (массив, add/remove), здесь — один-единственный адрес лида, без
// repeat-row. Смысловая логика (debounce, сужение по regionFiasId/areaFiasId,
// сброс сужения при ручном вводе) переносится как есть.

import { fetchGeoSuggest } from './leadsStorage.js';
import { showToast } from './leadsToast.js';

const GEO_FIELD_BOUND = { region: 'region', city: 'city', district: 'area', locality: 'settlement' };
const GEO_DEBOUNCE_MS = 300;

let geoSuggestTimer = null;
let geoSuggestRequestId = 0;
let regionFiasId;
let areaFiasId;

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

// Сбрасывает контекст сужения (regionFiasId/areaFiasId) — вызывать при каждом
// открытии модалки лида, иначе поиск для нового/другого лида молча уйдёт в
// контекст региона предыдущего редактируемого лида.
export function resetGeoContext() {
    regionFiasId = undefined;
    areaFiasId = undefined;
    closeGeoSuggest();
}

export function initGeoAutocomplete() {
    document.querySelectorAll('.geo-field input').forEach((input) => {
        const field = Object.keys(GEO_FIELD_BOUND).find((f) => input.classList.contains(`geo-${f}`));
        const bound = GEO_FIELD_BOUND[field];

        input.addEventListener('input', () => {
            const q = input.value.trim();
            const fieldEl = input.closest('.geo-field');

            // Ручной ввод расходится с уже сохранённым fias-id этого уровня —
            // сбрасываем сужение, иначе следующий поиск молча уйдёт в контекст
            // региона/района, которого пользователь уже не видит в поле.
            if (field === 'region') { regionFiasId = undefined; areaFiasId = undefined; }
            if (field === 'district') { areaFiasId = undefined; }

            closeGeoSuggest();
            clearTimeout(geoSuggestTimer);
            if (!q) return;

            const requestId = ++geoSuggestRequestId;
            geoSuggestTimer = setTimeout(async () => {
                let suggestions;
                try {
                    const result = await fetchGeoSuggest(q, { bound, regionFiasId: field !== 'region' ? regionFiasId : undefined });
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
                        input.value = parts[bound];
                        if (field === 'region') { regionFiasId = data.region_fias_id; areaFiasId = undefined; }
                        if (field === 'district') { areaFiasId = data.area_fias_id; }
                        closeGeoSuggest();
                    });
                });
            }, GEO_DEBOUNCE_MS);
        });
        input.addEventListener('blur', () => setTimeout(closeGeoSuggest, 120));
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.geo-field')) closeGeoSuggest(); });
}
