// --- leadsOffers.js: выбор офферов лида (серверный поиск) ---
// Офферов в базе ≈38 000, поэтому полный справочник фронт не грузит НИКОГДА:
// и вкладка «Офферы» в карточке лида, и инлайн-поиск в окне загрузки ходят в
// GET /api/real-estate-offers/search (подстрока + три фильтра + LIMIT + total).
//
// Два разных представления одного и того же выбора — так решила дизайн-сессия
// (report_designer.md): в карточке лида это отдельная вкладка (фильтры, список
// результатов, «Добавить все (N)»), в окне загрузки — компактный инлайн-поиск
// с подсказками, потому что вкладок там нет.
//
// ПЕРЕНОС В ОБОЛОЧКУ: модуль больше не импортирует ни storage, ни showToast —
// получает их зависимостями. Причина не в чистоте: storage теперь свой у
// каждой панели, а импорт был бы общим на всё приложение.

const SEARCH_DEBOUNCE_MS = 300;
const SUGGEST_LIMIT = 8;

// Формулировка та же, что отдаёт сервер при превышении потолка — здесь она
// показывается ДО запроса, вместо кнопки. Само число берётся с сервера
// (maxPerLead в ответе поиска), во фронте не хардкодится.
const TOO_MANY_OFFERS_HINT = 'Сузьте отбор фильтрами или поиском';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const GEO_LEVELS = ['region', 'city', 'district', 'locality'];

// Гео-часть подстроки: самый детальный заполненный уровень + регион. Соседний
// повтор схлопывается — иначе у оффера, где заполнен только регион, выйдет
// «Московская обл., Московская обл.», а у Москвы/СПб (город = регион) —
// «Москва, Москва». Тот же приём, что в подсказках адреса CPA-сетей
// (cpaApp.js, geoSuggestionLabel): убрать соседние дубли перед склейкой.
function offerGeoLabel(offer) {
    const filled = GEO_LEVELS.map((level) => offer[level]).filter(Boolean);
    if (filled.length === 0) return '';
    const mostDetailed = filled[filled.length - 1];
    const pieces = [mostDetailed, offer.region].filter(Boolean);
    return pieces.filter((p, i) => p !== pieces[i - 1]).join(', ');
}

// «площадка · корневой источник · <география объекта>». Площадка и корневой
// источник по-прежнему от первого источника сети оффера, а гео — собственная
// география оффера (та самая строка, по которой он и нашёлся, если фильтр
// задан). Чего нет, то не показываем — висящих разделителей не остаётся.
function offerSubtitle(offer) {
    const parts = [offer.platform, offer.rootSource, offerGeoLabel(offer)].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
}

// Отложенный вызов с явной отменой: таймер обязан сниматься при закрытии
// панели, иначе поиск уйдёт в уже обнулённый storage.
function createDebounced(fn, ms) {
    let timer = null;
    const call = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    call.cancel = () => clearTimeout(timer);
    return call;
}

// ============================================================
// Вкладка «Офферы» в карточке лида
// ============================================================

export function createOfferTabPicker({
    platSelect, geoSelects, searchInput, resetBtn,
    resultsEl, tagsEl, countEl, emptyEl, clearAllBtn, tabCountEl, onChange,
    storage, toast, isAlive, isAbort
}) {
    // id -> name: имя нужно для тегов выбранного, а поиск возвращает только
    // текущую страницу результатов — поэтому выбранное храним со своими именами.
    const selected = new Map();
    let lastResults = [];
    let lastTotal = 0;
    let filtersLoaded = false;
    // Потолок офферов на лида приходит с сервера вместе с выдачей — во фронте
    // его не хардкодим, иначе через полгода лимит поменяют на сервере, а
    // кнопка «Добавить все» продолжит предлагать заведомо отбиваемое действие.
    let maxPerLead = null;

    function currentParams() {
        // `rootSource` СЮДА БОЛЬШЕ НЕ КЛАДЁТСЯ (К273). Серверный параметр
        // остался рабочим, но слать пустую строку значило бы утверждать, что
        // отбор по корневому источнику ещё жив.
        const params = {
            search: searchInput.value.trim(),
            platformId: platSelect.value
        };
        GEO_LEVELS.forEach((level) => { params[level] = geoSelects[level].value; });
        return params;
    }

    function emitChange() {
        if (onChange) onChange(getValues());
    }

    function renderSelected() {
        countEl.textContent = selected.size;
        if (tabCountEl) tabCountEl.textContent = selected.size;
        tagsEl.innerHTML = Array.from(selected.entries())
            .map(([id, name]) => `<span class="ui-fchip">${escapeHtml(name)}<button type="button" class="ui-fchip__remove" data-remove="${id}" aria-label="Убрать"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`)
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
        // Отбор шире потолка — кнопку не рисуем вовсе: сервер такой набор всё
        // равно отобьёт, а предлагать заведомо невыполнимое действие нечестно
        // (при 38 000 офферов это первое, что видит пользователь).
        const overLimit = maxPerLead !== null && lastTotal > maxPerLead;
        const addAllControl = overLimit
            ? `<span>${escapeHtml(TOO_MANY_OFFERS_HINT)}</span>`
            : `<button type="button" class="ui-btn ui-btn--ghost" data-role="offer-add-all"${allAdded && lastTotal === lastResults.length ? ' disabled' : ''}>${addAllLabel}</button>`;

        const rows = lastResults.map((o) => {
            const added = selected.has(o.id);
            const action = added
                ? '<span class="added">✓ добавлен</span>'
                : `<button type="button" class="ui-btn ui-btn--ghost" data-add="${o.id}">Добавить</button>`;
            return `<div class="offer-result-row">
                <div><div>${escapeHtml(o.name)}</div><div class="offer-result-sub">${escapeHtml(offerSubtitle(o))}</div></div>
                ${action}
            </div>`;
        }).join('');

        const note = lastTotal > lastResults.length
            ? `<div class="offer-results-note">Показаны первые ${lastResults.length} из ${lastTotal}. ${overLimit ? 'Уточните поиск или сузьте отбор фильтрами.' : 'Уточните поиск или используйте «Добавить все».'}</div>`
            : '';

        resultsEl.hidden = false;
        resultsEl.innerHTML = `
            <div class="offer-results-head">
                <span>Найдено: ${lastTotal}</span>
                ${addAllControl}
            </div>
            ${rows}
            ${note}`;
    }

    async function runSearch() {
        try {
            const { total, items, maxPerLead: limit } = await storage.searchOffers(currentParams());
            if (!isAlive()) return;
            lastTotal = total;
            lastResults = items;
            if (typeof limit === 'number') maxPerLead = limit;
            renderResults();
        } catch (e) {
            if (!isAlive() || isAbort(e)) return;
            toast(e.message, 'error');
        }
    }

    const runSearchDebounced = createDebounced(runSearch, SEARCH_DEBOUNCE_MS);

    async function addAll() {
        try {
            // search-ids по контракту отдаёт только id и сам отбивает отбор
            // шире потолка внятной ошибкой. Названия для тегов
            // добираем вторым запросом — на весь отбор, а не на видимую
            // страницу: пользователь выбирает ВЕСЬ отбор, а не то, что видит.
            const { ids } = await storage.searchOfferIds(currentParams());
            if (!isAlive()) return;
            if (ids.length === 0) {
                toast('В отборе нет офферов', 'error');
                return;
            }
            const { items } = await storage.searchOffers({ ...currentParams(), limit: ids.length });
            if (!isAlive()) return;
            const namesById = new Map(items.map((o) => [o.id, o.name]));
            ids.forEach((id) => selected.set(id, namesById.get(id) || `Оффер #${id}`));
            renderSelected();
            renderResults();
            emitChange();
            toast(`Добавлено офферов: ${ids.length}`, 'success');
        } catch (e) {
            if (!isAlive() || isAbort(e)) return;
            toast(e.message, 'error');
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
        if (e.target.closest('[data-role="offer-add-all"]')) addAll();
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
    platSelect.addEventListener('change', runSearch);

    // Смена гео-уровня сбрасывает все НИЖНИЕ и перезагружает их списки:
    // прежний город почти наверняка не принадлежит новому региону, и оставлять
    // его — значит показывать пустую выдачу вместо понятного результата.
    GEO_LEVELS.forEach((level, index) => {
        geoSelects[level].addEventListener('change', async () => {
            GEO_LEVELS.slice(index + 1).forEach((lower) => { geoSelects[lower].value = ''; });
            await loadFilters({ force: true });
            if (!isAlive()) return;
            await runSearch();
        });
    });

    resetBtn.addEventListener('click', async () => {
        platSelect.value = '';
        GEO_LEVELS.forEach((level) => { geoSelects[level].value = ''; });
        searchInput.value = '';
        await loadFilters({ force: true });
        if (!isAlive()) return;
        await runSearch();
    });

    function fillSelect(select, values) {
        // Значение сохраняем: списки верхних уровней при каскаде не меняются,
        // и терять уже выбранное при перезагрузке нельзя.
        const previous = select.value;
        select.innerHTML = '<option value="">Все</option>'
            + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
        select.value = values.includes(previous) ? previous : '';
    }

    async function loadFilters({ force = false } = {}) {
        if (filtersLoaded && !force) return;
        try {
            // ⚠ `rootSources` сервер ПО-ПРЕЖНЕМУ ОТДАЁТ, и это решение куратора
            // (ответы 23 и 26): справочник не мешает и пригодится, когда
            // корневых источников станет больше одного. Здесь поле ответа
            // просто не читается — узла, который им заполнялся, больше нет.
            const { platforms, regions, cities, districts, localities } = await storage.fetchOfferFilters({
                region: geoSelects.region.value,
                city: geoSelects.city.value,
                district: geoSelects.district.value
            });
            if (!isAlive()) return;
            const previousPlat = platSelect.value;
            platSelect.innerHTML = '<option value="">Все</option>'
                + platforms.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
            platSelect.value = platforms.some((p) => String(p.id) === previousPlat) ? previousPlat : '';

            fillSelect(geoSelects.region, regions);
            fillSelect(geoSelects.city, cities);
            fillSelect(geoSelects.district, districts);
            fillSelect(geoSelects.locality, localities);
            filtersLoaded = true;
        } catch (e) {
            if (!isAlive() || isAbort(e)) return;
            toast(e.message, 'error');
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
            platSelect.value = '';
            GEO_LEVELS.forEach((level) => { geoSelects[level].value = ''; });
            searchInput.value = '';
            resultsEl.hidden = true;
            lastResults = [];
            lastTotal = 0;
            // force: списки гео-уровней могли остаться суженными каскадом от
            // прошлого открытия, а значения мы только что сбросили.
            await loadFilters({ force: true });
            if (!isAlive()) return;
            await runSearch();
        },
        getValues,
        destroy() {
            runSearchDebounced.cancel();
        }
    };
}

// ============================================================
// Инлайн-поиск офферов в окне загрузки базы
// ============================================================

export function createOfferInlinePicker(container, { onChange = null, storage, toast, isAlive, isAbort } = {}) {
    container.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ui-field__control';
    input.placeholder = 'Начните вводить название оффера…';
    input.autocomplete = 'off';
    const suggest = document.createElement('div');
    suggest.className = 'pick-suggest';
    suggest.hidden = true;
    const tagsEl = document.createElement('div');
    tagsEl.className = 'ui-fchips';
    container.append(input, suggest, tagsEl);

    const selected = new Map();
    let lastItems = [];
    let blurTimer = null;

    function renderTags() {
        tagsEl.innerHTML = Array.from(selected.entries())
            .map(([id, name]) => `<span class="ui-fchip">${escapeHtml(name)}<button type="button" class="ui-fchip__remove" data-remove="${id}" aria-label="Убрать"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`)
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
            const { total, items } = await storage.searchOffers({ search: query, limit: SUGGEST_LIMIT });
            if (!isAlive()) return;
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
            if (!isAlive() || isAbort(e)) return;
            toast(e.message, 'error');
        }
    }

    const runSearchDebounced = createDebounced(runSearch, SEARCH_DEBOUNCE_MS);
    input.addEventListener('input', runSearchDebounced);
    input.addEventListener('blur', () => {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(() => { suggest.hidden = true; }, 150);
    });

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
        },
        destroy() {
            runSearchDebounced.cancel();
            clearTimeout(blurTimer);
        }
    };
}
