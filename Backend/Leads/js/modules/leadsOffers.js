// --- leadsOffers.js: выбор офферов лида (серверный поиск) ---
// Офферов в базе ≈38 000, поэтому полный справочник фронт не грузит НИКОГДА:
// и вкладка «Офферы» в карточке лида, и инлайн-поиск в окне загрузки ходят в
// GET /api/real-estate-offers/search (подстрока + три фильтра + LIMIT + total).
//
// Два разных представления одного и того же выбора — так решила дизайн-сессия
// (report_designer.md): в карточке лида это отдельная вкладка (фильтры, список
// результатов, «Добавить все (N)»), в окне загрузки — компактный инлайн-поиск
// с подсказками, потому что вкладок там нет.

import { searchOffers, searchOfferIds, fetchOfferFilters } from './leadsStorage.js';
import { showToast } from './leadsToast.js';

const SEARCH_DEBOUNCE_MS = 300;
const SUGGEST_LIMIT = 8;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// «площадка · корневой источник · город, регион» — от первого источника сети
// оффера; чего нет, то не показываем (не оставляем висящие разделители).
function offerSubtitle(offer) {
    const parts = [offer.platform, offer.rootSource, offer.cityRegion].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

// ============================================================
// Вкладка «Офферы» в карточке лида
// ============================================================

export function createOfferTabPicker({
    rootSelect, platSelect, geoSelect, searchInput, resetBtn,
    resultsEl, tagsEl, countEl, emptyEl, clearAllBtn, tabCountEl, onChange
}) {
    // id -> name: имя нужно для тегов выбранного, а поиск возвращает только
    // текущую страницу результатов — поэтому выбранное храним со своими именами.
    const selected = new Map();
    let lastResults = [];
    let lastTotal = 0;
    let filtersLoaded = false;

    function currentParams() {
        return {
            search: searchInput.value.trim(),
            rootSource: rootSelect.value,
            platformId: platSelect.value,
            cityRegion: geoSelect.value
        };
    }

    function emitChange() {
        if (onChange) onChange(getValues());
    }

    function renderSelected() {
        countEl.textContent = selected.size;
        if (tabCountEl) tabCountEl.textContent = selected.size;
        tagsEl.innerHTML = Array.from(selected.entries())
            .map(([id, name]) => `<span class="param-tag">${escapeHtml(name)}<button type="button" data-remove="${id}" aria-label="Убрать">×</button></span>`)
            .join('');
        emptyEl.hidden = selected.size > 0;
        clearAllBtn.hidden = selected.size === 0;
    }

    function renderResults() {
        if (lastResults.length === 0 && lastTotal === 0) {
            resultsEl.hidden = false;
            resultsEl.innerHTML = '<div class="offer-results-note">Ничего не найдено по текущему отбору.</div>';
            return;
        }
        const allAdded = lastResults.length > 0 && lastResults.every((o) => selected.has(o.id));
        const addAllLabel = allAdded && lastTotal === lastResults.length
            ? '✓ все добавлены'
            : `Добавить все (${lastTotal})`;

        const rows = lastResults.map((o) => {
            const added = selected.has(o.id);
            const action = added
                ? '<span class="added">✓ добавлен</span>'
                : `<button type="button" class="btn btn-ghost btn-sm" data-add="${o.id}">Добавить</button>`;
            return `<div class="offer-result-row">
                <div><div>${escapeHtml(o.name)}</div><div class="offer-result-sub">${escapeHtml(offerSubtitle(o))}</div></div>
                ${action}
            </div>`;
        }).join('');

        const note = lastTotal > lastResults.length
            ? `<div class="offer-results-note">Показаны первые ${lastResults.length} из ${lastTotal}. Уточните поиск или используйте «Добавить все».</div>`
            : '';

        resultsEl.hidden = false;
        resultsEl.innerHTML = `
            <div class="offer-results-head">
                <span>Найдено: ${lastTotal}</span>
                <button type="button" class="btn btn-ghost btn-sm" id="offerAddAllBtn"${allAdded && lastTotal === lastResults.length ? ' disabled' : ''}>${addAllLabel}</button>
            </div>
            ${rows}
            ${note}`;
    }

    async function runSearch() {
        try {
            const { total, items } = await searchOffers(currentParams());
            lastTotal = total;
            lastResults = items;
            renderResults();
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    const runSearchDebounced = debounce(runSearch, SEARCH_DEBOUNCE_MS);

    async function addAll() {
        try {
            // search-ids по контракту отдаёт только id и сам отбивает отбор
            // шире потолка (1000) внятной ошибкой. Названия для тегов
            // добираем вторым запросом — на весь отбор, а не на видимую
            // страницу: пользователь выбирает ВЕСЬ отбор, а не то, что видит.
            const { ids } = await searchOfferIds(currentParams());
            if (ids.length === 0) {
                showToast('В отборе нет офферов', 'error');
                return;
            }
            const { items } = await searchOffers({ ...currentParams(), limit: ids.length });
            const namesById = new Map(items.map((o) => [o.id, o.name]));
            ids.forEach((id) => selected.set(id, namesById.get(id) || `Оффер #${id}`));
            renderSelected();
            renderResults();
            emitChange();
            showToast(`Добавлено офферов: ${ids.length}`, 'success');
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    resultsEl.addEventListener('click', (e) => {
        const addBtn = e.target.closest('[data-add]');
        if (addBtn) {
            const id = Number(addBtn.dataset.add);
            const offer = lastResults.find((o) => o.id === id);
            if (offer) {
                selected.set(id, offer.name);
                renderSelected();
                renderResults();
                emitChange();
            }
            return;
        }
        if (e.target.closest('#offerAddAllBtn')) addAll();
    });

    tagsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (!btn) return;
        selected.delete(Number(btn.dataset.remove));
        renderSelected();
        renderResults();
        emitChange();
    });

    clearAllBtn.addEventListener('click', () => {
        selected.clear();
        renderSelected();
        renderResults();
        emitChange();
    });

    searchInput.addEventListener('input', runSearchDebounced);
    [rootSelect, platSelect, geoSelect].forEach((el) => el.addEventListener('change', runSearch));
    resetBtn.addEventListener('click', () => {
        rootSelect.value = '';
        platSelect.value = '';
        geoSelect.value = '';
        searchInput.value = '';
        runSearch();
    });

    async function loadFilters() {
        if (filtersLoaded) return;
        try {
            const { rootSources, platforms, cityRegions } = await fetchOfferFilters();
            rootSelect.innerHTML = '<option value="">Все</option>'
                + rootSources.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
            platSelect.innerHTML = '<option value="">Все</option>'
                + platforms.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
            geoSelect.innerHTML = '<option value="">Все</option>'
                + cityRegions.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
            filtersLoaded = true;
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    function getValues() {
        return Array.from(selected.keys());
    }

    return {
        async open(offers) {
            selected.clear();
            (offers || []).forEach((o) => selected.set(o.id, o.name));
            renderSelected();
            rootSelect.value = '';
            platSelect.value = '';
            geoSelect.value = '';
            searchInput.value = '';
            resultsEl.hidden = true;
            lastResults = [];
            lastTotal = 0;
            await loadFilters();
            await runSearch();
        },
        getValues
    };
}

// ============================================================
// Инлайн-поиск офферов в окне загрузки базы
// ============================================================

export function createOfferInlinePicker(container, { onChange = null } = {}) {
    container.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Начните вводить название оффера…';
    input.autocomplete = 'off';
    const suggest = document.createElement('div');
    suggest.className = 'pick-suggest';
    suggest.hidden = true;
    const tagsEl = document.createElement('div');
    tagsEl.className = 'param-tags';
    container.append(input, suggest, tagsEl);

    const selected = new Map();
    let lastItems = [];

    function renderTags() {
        tagsEl.innerHTML = Array.from(selected.entries())
            .map(([id, name]) => `<span class="param-tag">${escapeHtml(name)}<button type="button" data-remove="${id}" aria-label="Убрать">×</button></span>`)
            .join('');
        if (onChange) onChange(Array.from(selected.keys()));
    }

    async function runSearch() {
        const query = input.value.trim();
        if (!query) {
            suggest.hidden = true;
            return;
        }
        try {
            const { total, items } = await searchOffers({ search: query, limit: SUGGEST_LIMIT });
            lastItems = items;
            if (items.length === 0) {
                suggest.innerHTML = '<div class="pick-suggest-empty">Ничего не найдено</div>';
            } else {
                const note = total > items.length
                    ? `<div class="pick-suggest-note">Показаны первые ${items.length} из ${total} — уточните запрос.</div>`
                    : '';
                suggest.innerHTML = items.map((o) => `
                    <div class="pick-suggest-item" data-pick="${o.id}">
                        ${escapeHtml(o.name)}<div class="offer-result-sub">${escapeHtml(offerSubtitle(o))}</div>
                    </div>`).join('') + note;
            }
            suggest.hidden = false;
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    input.addEventListener('input', debounce(runSearch, SEARCH_DEBOUNCE_MS));
    input.addEventListener('blur', () => { setTimeout(() => { suggest.hidden = true; }, 150); });

    suggest.addEventListener('mousedown', (e) => {
        const item = e.target.closest('[data-pick]');
        if (!item) return;
        e.preventDefault();
        const id = Number(item.dataset.pick);
        const offer = lastItems.find((o) => o.id === id);
        if (offer) selected.set(id, offer.name);
        input.value = '';
        suggest.hidden = true;
        renderTags();
    });

    tagsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (!btn) return;
        selected.delete(Number(btn.dataset.remove));
        renderTags();
    });

    return {
        getValues() {
            return Array.from(selected.keys());
        },
        clear() {
            selected.clear();
            input.value = '';
            suggest.hidden = true;
            renderTags();
        }
    };
}
