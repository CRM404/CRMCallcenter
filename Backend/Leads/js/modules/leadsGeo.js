// --- leadsGeo.js: гео-автоподсказки (DaData) для окна лида ---
// Упрощённая версия attachGeoAutocomplete из CpaNetworks/js/modules/cpaApp.js:
// там это повторяемые строки критериев оффера (массив, add/remove), здесь —
// адреса лида, без repeat-row. Смысловая логика (debounce, сужение по
// regionFiasId/areaFiasId, сброс сужения при ручном вводе) та же.
//
// Адресов ДВА — объекта и клиента. Контекст сужения свой у каждого блока
// .geo-block: без этого выбор региона в гео объекта молча сузил бы поиск
// города в гео клиента.
//
// ПЕРЕНОС В ОБОЛОЧКУ. Модуль был набором функций уровня файла с состоянием в
// переменных модуля и поиском через document — то есть одним на всё
// приложение. Теперь это фабрика на монтирование: свой root, свой таймер,
// свой слушатель документа, и всё это снимается в destroy().
//
// Отдельно про таймер: ровно на нём в «CPA-сетях» раздел падал уже после
// закрытия панели — отложенный запрос переживал unmount и обращался к
// обнулённому storage. Здесь он снимается явно.

const GEO_FIELD_BOUND = { region: 'region', city: 'city', district: 'area', locality: 'settlement' };
const GEO_DEBOUNCE_MS = 300;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/**
 * @param {HTMLElement} root      контейнер панели — дальше него не ищем
 * @param {Object}      deps      { storage, toast, isAlive, isAbort }
 *        isAlive() — жива ли панель; вызывается после каждого await
 */
export function createGeoAutocomplete(root, { storage, toast, isAlive, isAbort }) {
    let suggestTimer = null;
    let requestId = 0;
    // Контексты сужения по блокам: WeakMap, потому что блоки живут ровно
    // столько, сколько живёт разметка окна.
    const blockContexts = new WeakMap();

    function closeSuggest() {
        root.querySelectorAll('.geo-suggest').forEach((el) => el.remove());
    }

    function contextOf(input) {
        // Поле вне адресного блока (в разметке такого нет, но модуль не должен
        // падать на этом) получает собственный одноразовый контекст.
        const block = input.closest('.geo-block');
        if (!block) return { regionFiasId: undefined, areaFiasId: undefined };
        if (!blockContexts.has(block)) blockContexts.set(block, { regionFiasId: undefined, areaFiasId: undefined });
        return blockContexts.get(block);
    }

    function handleInput(input, field, bound) {
        const q = input.value.trim();
        const fieldEl = input.closest('.geo-field');
        const context = contextOf(input);

        // Ручной ввод расходится с уже сохранённым fias-id этого уровня —
        // сбрасываем сужение, иначе следующий поиск молча уйдёт в контекст
        // региона/района, которого пользователь уже не видит в поле.
        if (field === 'region') { context.regionFiasId = undefined; context.areaFiasId = undefined; }
        if (field === 'district') { context.areaFiasId = undefined; }

        closeSuggest();
        clearTimeout(suggestTimer);
        if (!q) return;

        const my = ++requestId;
        suggestTimer = setTimeout(async () => {
            let suggestions;
            try {
                const result = await storage.fetchGeoSuggest(q, {
                    bound,
                    regionFiasId: field !== 'region' ? context.regionFiasId : undefined
                });
                // Панель закрыли, пока шёл запрос: рисовать подсказки некуда, а
                // storage уже обнулён.
                if (!isAlive()) return;
                suggestions = (result && result.suggestions) || [];
            } catch (err) {
                if (!isAlive() || isAbort(err)) return;
                toast('Подсказки адреса недоступны — сервис не отвечает. Введите вручную.', 'error');
                return;
            }
            if (my !== requestId) return;
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
                    if (field === 'region') { context.regionFiasId = data.region_fias_id; context.areaFiasId = undefined; }
                    if (field === 'district') { context.areaFiasId = data.area_fias_id; }
                    closeSuggest();
                });
            });
        }, GEO_DEBOUNCE_MS);
    }

    root.querySelectorAll('.geo-field input').forEach((input) => {
        const field = input.dataset.geoLevel;
        const bound = GEO_FIELD_BOUND[field];
        if (!bound) return;
        input.addEventListener('input', () => handleInput(input, field, bound));
        input.addEventListener('blur', () => setTimeout(closeSuggest, 120));
    });

    // Клик мимо поля закрывает подсказки. Слушатель на документе, а не на
    // панели: клик может прийтись на соседнюю панель или на стол.
    const onDocClick = (e) => { if (!e.target.closest('.geo-field')) closeSuggest(); };
    document.addEventListener('click', onDocClick);

    return {
        /**
         * Сбрасывает контекст сужения у ВСЕХ адресных блоков — вызывать при
         * каждом открытии окна лида, иначе поиск для нового лида уйдёт в
         * контекст региона предыдущего редактируемого.
         */
        reset() {
            root.querySelectorAll('.geo-block').forEach((block) => {
                blockContexts.set(block, { regionFiasId: undefined, areaFiasId: undefined });
            });
            closeSuggest();
        },
        destroy() {
            clearTimeout(suggestTimer);
            document.removeEventListener('click', onDocClick);
            closeSuggest();
        }
    };
}
