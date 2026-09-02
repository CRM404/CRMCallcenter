// --- sourcesSection.js: раздел «Источники» в оболочке ---
//
// Контракт раздела (бриф, 3.2):
//     export async function mount(container, ctx)
//     export function unmount()
//
// ЧТО ИЗМЕНИЛОСЬ ПРОТИВ СТРАНИЦЫ sources.html
//
// 1. Состояние живёт В ЭКЗЕМПЛЯРЕ, а не в модуле. ES-модуль — синглтон: при
//    двух открытых панелях модульные переменные были бы общими, и разделы
//    начали бы перетирать друг другу выбранную площадку и выделение. Это та
//    же ловушка, что и глобальные id, только не видимая глазом.
// 2. Никаких document.querySelector — только container.querySelector по
//    data-role. Глобальных id в разделе не осталось.
// 3. Свои тост, модалка подтверждения и навигация удалены: они пришли из
//    слоя элементов и оболочки (ctx.toast, ctx.confirm, openModal).
// 4. Площадки — мастер-деталь слева, а не вкладки сверху (бриф, п.6).
//    Добавился режим «Все площадки»: GET /api/sources без параметров и так
//    отдаёт все, отдельного запроса на площадку для этого не нужно.
// 5. Счётчики шапки считаются из одного ответа вместо N параллельных запросов
//    по числу площадок — те же числа, но один запрос вместо шести.
//
// Тексты — из кода страницы как есть (правило брифа: источник истины по
// текстам — код, а не макет).

import { plural } from '/plural.js';
import { openModal } from '/ui/modal.js';
import { isAbort } from '/api.js';
import { openDeleteBlocked, isDeleteBlocked } from '/deleteBlocked.js';
import {
    fetchPlatforms, createPlatform, updatePlatform, deletePlatform,
    fetchCpaNetworks, fetchSources, createSource, updateSource, deleteSource
} from './sourcesStorage.js';

const SEARCH_DEBOUNCE_MS = 300;

const STATUSES = ['Активен', 'Неактивен', 'Актуализация', 'Архив'];

// Подписи вкладок отбора — во множественном числе и в порядке макета:
// «Активные», «Актуализация», «Неактивные», «Архив» (М15). Значения статуса
// при этом остаются как в базе — вкладка подписана иначе, чем хранится, и
// путать одно с другим нельзя: по значению идёт отбор, подпись только читается.
const STATUS_TABS = [
    ['Активен', 'Активные'],
    ['Актуализация', 'Актуализация'],
    ['Неактивен', 'Неактивные'],
    ['Архив', 'Архив']
];

const STATUS_PILL = {
    'Активен': 'ui-pill--ok',
    'Неактивен': 'ui-pill--bad',
    'Актуализация': 'ui-pill--warn',
    'Архив': 'ui-pill--mute'
};

// Открытые экземпляры раздела. Оболочка зовёт unmount() без аргументов, а
// панелей с одним и тем же разделом больше одной быть не может (panels.js
// переводит фокус на существующую), но список честнее одиночной переменной:
// он не соврёт, если правило когда-нибудь изменится.
const instances = [];

export async function mount(container, ctx) {
    // Панель могли закрыть, пока прошлый экземпляр грузил данные: оболочка в
    // этом случае не успевает получить ссылку на unmount и не зовёт его,
    // экземпляр остаётся в списке с живым таймером поиска. Подчищаем таких по
    // признаку «контейнер уже вырезан из документа».
    purgeDetached();

    const state = {
        container,
        ctx,
        panel: container.closest('.shell-panel'),
        platforms: [],
        cpaNetworks: [],
        sources: [],
        platformId: null,      // null = «Все площадки»
        search: '',
        region: '',            // '' = «Все регионы»
        networkId: '',         // '' = «Все CPA-сети»
        status: 'all',
        selected: new Set(),
        searchTimer: null,
        destroyed: false
    };
    instances.push(state);

    bindEvents(state);
    await reloadAll(state);
}

export function unmount() {
    const state = instances.pop();
    if (state) destroyInstance(state);
    purgeDetached();
}

/**
 * Слушатели висят на узлах контейнера — оболочка очищает контейнер сразу
 * после unmount, поэтому снимать их поимённо не нужно. Таймер поиска — нужно:
 * он переживёт удаление узлов и разбудит мёртвый раздел.
 */
function destroyInstance(state) {
    state.destroyed = true;
    clearTimeout(state.searchTimer);
}

function purgeDetached() {
    for (let i = instances.length - 1; i >= 0; i--) {
        if (!document.contains(instances[i].container)) {
            destroyInstance(instances[i]);
            instances.splice(i, 1);
        }
    }
}

// ---------------------------------------------------------------- данные

async function reloadAll(state) {
    try {
        // Полный список нужен в любом случае — из него считаются счётчики
        // раздела. Прежняя страница ради тех же трёх чисел делала по запросу
        // на каждую площадку: GET /api/sources без параметров и так отдаёт всё.
        const [platforms, networks, all] = await Promise.all([
            fetchPlatforms(state.ctx.api),
            state.cpaNetworks.length ? Promise.resolve(state.cpaNetworks) : fetchCpaNetworks(state.ctx.api),
            fetchSources(state.ctx.api)
        ]);
        if (state.destroyed) return;
        state.platforms = platforms;
        state.cpaNetworks = networks;
        state.allSources = all;

        if (state.platformId !== null && !platforms.some((p) => p.id === state.platformId)) {
            state.platformId = null;
        }

        await loadSources(state);
        if (state.destroyed) return;
        renderAll(state);
    } catch (err) {
        fail(state, err);
    }
}

async function loadSources(state) {
    if (state.search) {
        state.sources = await fetchSources(state.ctx.api, { search: state.search });
        return;
    }
    if (state.platformId === null) {
        // Уже загружено вместе со счётчиками — второй раз не спрашиваем.
        state.sources = state.allSources || await fetchSources(state.ctx.api);
        return;
    }
    state.sources = await fetchSources(state.ctx.api, { platformId: state.platformId });
}

/** Ошибка запроса. Отмена — не ошибка: раздел уже закрыт, говорить некому. */
function fail(state, err) {
    if (isAbort(err) || state.destroyed) return;
    state.ctx.toast(err.message, 'error');
}

// ---------------------------------------------------------------- разметка

const $ = (state, role) => state.container.querySelector(`[data-role="${role}"]`);

/**
 * Экранирование для вставки в разметку. Кавычки экранируются ОБЯЗАТЕЛЬНО:
 * значения подставляются не только в текст, но и в атрибуты (value="…",
 * title="…"). Прежняя версия, унаследованная от страницы, кавычки не трогала,
 * и источник с именем «БАГ "кавычка" источник» обрывал атрибут — в форме
 * правки оставалось «БАГ », а следом за кавычкой в разметку попадало то, что
 * человек написал в названии. Найдено собственной проверкой на живых данных.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function visibleSources(state) {
    // Фильтры тулбара считаются на клиенте: список источников площадки грузится
    // целиком, второй запрос ради двух списков ничего не ускорит и добавил бы
    // второй набор правил отбора на тот же экран.
    return state.sources.filter((s) => {
        if (state.status !== 'all' && s.status !== state.status) return false;
        if (state.region && s.cityRegion !== state.region) return false;
        if (state.networkId
            && !(s.cpaNetworkIds || []).some((id) => String(id) === String(state.networkId))) return false;
        return true;
    });
}

/** Составы списков тулбара — из самих данных, а не «на всякий случай». */
function fillToolbarSelects(state) {
    const regionSelect = $(state, 'filter-region');
    const networkSelect = $(state, 'filter-network');
    if (!regionSelect || !networkSelect) return;

    const regions = [...new Set(state.sources.map((s) => s.cityRegion).filter(Boolean))].sort();
    regionSelect.innerHTML = '<option value="">Все регионы</option>'
        + regions.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
    // Выбранный регион мог исчезнуть вместе со сменой площадки — тогда фильтр
    // снимается, иначе список молча остаётся пустым без видимой причины.
    regionSelect.value = regions.includes(state.region) ? state.region : '';
    state.region = regionSelect.value;

    // Сети — ИЗ ПОКАЗАННОГО, а не из справочника (К137). Вариант, которого нет
    // ни у одной видимой строки, — заведомо пустой результат: он обещает отбор
    // и приводит в пустое состояние. У площадки на две сети из двадцати в
    // списке должно быть две. Соседний «Регион» так и устроен, и два соседних
    // поля не должны вести себя по-разному.
    const usedIds = new Set();
    state.sources.forEach((s) => (s.cpaNetworkIds || []).forEach((id) => usedIds.add(String(id))));
    const networks = state.cpaNetworks
        .filter((n) => usedIds.has(String(n.id)))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    networkSelect.innerHTML = '<option value="">Все CPA-сети</option>'
        + networks.map((n) => `<option value="${n.id}">${escapeHtml(n.name)}</option>`).join('');
    // Выбранная сеть могла исчезнуть вместе со сменой площадки — снимается
    // сама, ровно как регион.
    networkSelect.value = networks.some((n) => String(n.id) === String(state.networkId))
        ? state.networkId : '';
    state.networkId = networkSelect.value;
}

/** Кросс-площадочный режим: показывается колонка площадки. */
function isCrossPlatform(state) {
    return !!state.search || state.platformId === null;
}

function renderAll(state) {
    renderPlatforms(state);
    renderTabs(state);
    fillToolbarSelects(state);
    renderChips(state);
    renderRows(state);
    renderSelection(state);
}

function renderPlatforms(state) {
    const list = $(state, 'platform-list');
    const total = state.platforms.reduce((sum, p) => sum + (p.sourcesCount || 0), 0);

    const rows = [{ id: null, name: 'Все площадки', count: total, off: false }].concat(
        state.platforms.map((p) => ({
            id: p.id,
            name: p.name,
            count: p.sourcesCount || 0,
            off: p.status === 'Неактивна'
        }))
    );

    // aria-current и title — не украшение (К141). Список площадок это ОТБОР:
    // без aria-current программе чтения с экрана он виден тремя одинаковыми
    // кнопками, потому что состояние несут только цвет и вес. А имя площадки
    // обрезается многоточием (overflow: hidden + text-overflow), и без title
    // длинное имя прочесть нечем вовсе — ни глазами, ни программой.
    list.innerHTML = rows.map((row) => {
        const active = row.id === state.platformId;
        return `
        <button type="button" class="src-platform${active ? ' src-platform--active' : ''}${row.off ? ' src-platform--off' : ''}"
                data-platform="${row.id === null ? '' : row.id}"${active ? ' aria-current="true"' : ''}>
            <span class="src-platform__name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
            <span class="src-platform__count">${row.count}</span>
        </button>`;
    }).join('');

    const active = state.platforms.find((p) => p.id === state.platformId);
    $(state, 'platform-note').textContent = state.platforms.length
        ? (active ? `Статус площадки: ${active.status}` : `Площадок: ${state.platforms.length}. Источник создаётся внутри площадки.`)
        : 'Пока нет ни одной площадки.';

    // Без площадки источник не создать — кнопка неактивна и объясняет почему.
    const addBtn = $(state, 'add-source');
    addBtn.disabled = state.platforms.length === 0;
    addBtn.title = state.platforms.length === 0 ? 'Сначала добавьте площадку в «Управление площадками»' : '';
}

function renderTabs(state) {
    const counts = { all: state.sources.length };
    STATUSES.forEach((status) => {
        counts[status] = state.sources.filter((s) => s.status === status).length;
    });

    const tabs = [['all', 'Все']].concat(STATUS_TABS);
    $(state, 'status-tabs').innerHTML = tabs.map(([key, label]) => `
        <button type="button" class="ui-tabs__tab${key === state.status ? ' ui-tabs__tab--active' : ''}${counts[key] === 0 && key !== 'all' ? ' ui-tabs__tab--quiet' : ''}"
                data-status="${escapeHtml(key)}">
            ${escapeHtml(label)} <span class="ui-tabs__count">${counts[key]}</span>
        </button>
    `).join('');
}

/** Активные фильтры чипами: видно, почему список короткий. */
function renderChips(state) {
    const chips = [];
    if (state.search) {
        chips.push(`<span class="ui-fchip">Поиск: <b>${escapeHtml(state.search)}</b>
            <button type="button" class="ui-fchip__remove" data-clear="search" aria-label="Сбросить поиск"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`);
    }
    if (state.platformId !== null && !state.search) {
        const platform = state.platforms.find((p) => p.id === state.platformId);
        if (platform) {
            chips.push(`<span class="ui-fchip">Площадка: <b>${escapeHtml(platform.name)}</b>
                <button type="button" class="ui-fchip__remove" data-clear="platform" aria-label="Показать все площадки"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`);
        }
    }
    if (state.region) {
        chips.push(`<span class="ui-fchip">Регион: <b>${escapeHtml(state.region)}</b>
            <button type="button" class="ui-fchip__remove" data-clear="region" aria-label="Сбросить фильтр региона"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`);
    }
    if (state.networkId) {
        const network = state.cpaNetworks.find((n) => String(n.id) === String(state.networkId));
        if (network) {
            chips.push(`<span class="ui-fchip">CPA-сеть: <b>${escapeHtml(network.name)}</b>
                <button type="button" class="ui-fchip__remove" data-clear="network" aria-label="Сбросить фильтр сети"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`);
        }
    }
    if (state.status !== 'all') {
        chips.push(`<span class="ui-fchip">Статус: <b>${escapeHtml(state.status)}</b>
            <button type="button" class="ui-fchip__remove" data-clear="status" aria-label="Сбросить фильтр статуса"><svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg></button></span>`);
    }

    const box = $(state, 'filter-chips');
    box.hidden = chips.length === 0;
    box.innerHTML = chips.length
        ? chips.join('') + '<button type="button" class="ui-fchips__clear" data-clear="all">Очистить всё</button>'
        : '';
}

/**
 * Пустое значение — прочерком, а не пустым местом (К143). Пустой оказывается
 * одна колонка: lead_source заведена 11.08.2026 без NOT NULL, и у записей,
 * созданных раньше, она пуста. Пустая ячейка неотличима от ошибки отрисовки.
 *
 * Приглушение стоит на СОДЕРЖИМОМ ячейки, а не на самом <td>: `.ui-table td`
 * объявляет цвет и по специфичности (0,1,1 против 0,1,0) отменяет
 * `.ui-table__muted` молча. До правки три колонки несли этот класс на <td> и
 * выглядели правильно случайно — первая же правка table.css перекрасила бы их
 * в серый. Приглушение в проекте — признак ОТСУТСТВУЮЩЕГО значения, а не
 * колонки.
 */
function dashIfEmpty(value) {
    const text = value === null || value === undefined ? '' : String(value).trim();
    return text ? escapeHtml(text) : '<span class="ui-table__muted">—</span>';
}

function renderRows(state) {
    const rows = visibleSources(state);
    const cross = isCrossPlatform(state);
    $(state, 'col-platform').hidden = !cross;

    const body = $(state, 'rows');
    const wrap = $(state, 'table-wrap');
    const empty = $(state, 'empty');
    const foot = $(state, 'foot');

    if (!rows.length) {
        body.innerHTML = '';
        wrap.hidden = true;
        foot.hidden = true;
        showEmpty(state);
        return;
    }

    empty.hidden = true;
    wrap.hidden = false;
    foot.hidden = false;

    body.innerHTML = rows.map((source) => {
        const nets = (source.cpaNetworkNames || [])
            .map((name) => `<span class="ui-tag">${escapeHtml(name)}</span>`).join('');
        const pill = STATUS_PILL[source.status] || 'ui-pill--mute';
        const selected = state.selected.has(source.id);
        return `
            <tr data-id="${source.id}"${selected ? ' class="ui-table__row--selected"' : ''}>
                <td class="ui-table__sel"><input type="checkbox" data-check="${source.id}"${selected ? ' checked' : ''} aria-label="Выделить источник"></td>
                ${cross ? `<td>${escapeHtml(source.platformName)}</td>` : ''}
                <td><span class="ui-table__main">${escapeHtml(source.rootSource)}</span></td>
                <td>${escapeHtml(source.cityRegion)}</td>
                <td><span class="src-nets">${nets}</span></td>
                <td><span class="ui-pill ${pill}">${escapeHtml(source.status)}</span></td>
                <td>${dashIfEmpty(source.leadSource)}</td>
                <td class="ui-table__acts">
                    <span class="src-cell-actions">
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-edit="${source.id}" aria-label="Изменить" title="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-del="${source.id}" aria-label="Удалить" title="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                    </span>
                </td>
            </tr>`;
    }).join('');

    // M — сколько строк ПОДХОДИТ ПОД ТЕКУЩИЙ ОТБОР, а не сколько их в разделе
    // (решение дизайн-сессии по К-Ф2). Раньше вторым числом стояла длина всего
    // списка площадки, и одна и та же фраза значила в трёх разделах три разных
    // вещи: «есть ещё, жми догрузку» в «Лидах» и «остальные скрыты фильтром»
    // здесь.
    //
    // Раздел показывает все подошедшие строки сразу, поэтому числа равны — и
    // это нормально: подвал отвечает на вопрос «всё ли я вижу из того, что
    // подошло». На вопрос «сколько скрыто фильтром» отвечает строка чипов: она
    // перечисляет активные фильтры поимённо и даёт «Сбросить все».
    const matched = rows.length;
    $(state, 'foot-shown').textContent = `Показано ${rows.length} из ${matched}`;
}

/**
 * Есть ли хоть один активный отбор поверх площадки и поиска.
 *
 * Признаком должно быть именно ЭТО, а не перечисление отборов поимённо (К134):
 * перечисление ломается на первом же добавленном фильтре — раздел под ним
 * скажет, что записей нет вовсе, и позовёт завести то, что уже заведено. Для
 * справочника это самая дорогая ошибка: дубль записи.
 */
function hasActiveFilter(state) {
    return state.status !== 'all' || !!state.region || !!state.networkId;
}

/** Пустое состояние: причина и следующий шаг, а не просто «ничего нет». */
function showEmpty(state) {
    const empty = $(state, 'empty');
    const title = $(state, 'empty-title');
    const text = $(state, 'empty-text');
    const action = $(state, 'empty-action');
    empty.hidden = false;
    action.hidden = true;
    action.dataset.act = '';

    // Порядок проверки: нет площадок → идёт поиск → активен отбор → пусто
    // по-настоящему. Поиск проверяется раньше прочих отборов, потому что он
    // кросс-площадочный и объясняет пустоту иначе, чем они.
    if (!state.platforms.length) {
        title.textContent = 'Пока нет ни одной площадки';
        text.textContent = 'Сначала добавьте площадку в «Управление площадками».';
        action.hidden = false;
        action.textContent = 'Управление площадками';
        action.dataset.act = 'platforms';
        return;
    }
    if (state.search) {
        title.textContent = 'Ничего не найдено по запросу';
        text.textContent = 'Проверьте написание или сбросьте поиск — источники есть, просто не по этому запросу.';
        action.hidden = false;
        action.textContent = 'Сбросить поиск';
        action.dataset.act = 'clear-search';
        return;
    }
    // `state.sources.length` в условии не лишний: у площадки без единого
    // источника отбор по статусу формально активен, но винить его нельзя —
    // отбирать не из чего, и правдивый ответ ниже, «Источников пока нет».
    if (hasActiveFilter(state) && state.sources.length > 0) {
        // Один текст на три отбора — статус, регион и сеть. Прежний говорил
        // только про статус, а кнопка снимала только его: чипы «Площадка» и
        // «Регион» оставались на месте, и нажатие не возвращало ни строки.
        title.textContent = 'Ничего не найдено по текущим фильтрам';
        text.textContent = 'Источники есть, просто не подходят под отбор. Активные фильтры перечислены строкой выше.';
        action.hidden = false;
        action.textContent = 'Сбросить фильтры';
        action.dataset.act = 'clear-filters';
        return;
    }
    // Пятый случай (К135): в режиме «Все площадки» выбранной площадки нет, и
    // обещание «он появится в списке этой площадки» — неправда.
    if (state.platformId === null) {
        title.textContent = 'Источников пока нет ни на одной площадке';
        text.textContent = 'Добавьте первый — площадку выберете в окне.';
        action.hidden = false;
        action.textContent = 'Добавить источник';
        action.dataset.act = 'add';
        return;
    }
    title.textContent = 'Источников пока нет';
    text.textContent = 'Добавьте первый источник — он появится в списке этой площадки.';
    action.hidden = false;
    action.textContent = 'Добавить источник';
    action.dataset.act = 'add';
}

// ---------------------------------------------------------------- выделение

function renderSelection(state) {
    const visibleIds = visibleSources(state).map((s) => s.id);
    // Выделение живёт только среди видимых строк: строка ушла из выборки —
    // ушла и из выделения, иначе «Применить» тронет невидимое.
    //
    // И об этом говорим: человек выделил две строки, переключил вкладку
    // статуса, вернулся — а выделения нет. Молча пропавшее выделение читается
    // как сбой интерфейса.
    let dropped = 0;
    Array.from(state.selected).forEach((id) => {
        if (!visibleIds.includes(id)) { state.selected.delete(id); dropped++; }
    });
    if (dropped > 0) {
        state.ctx.toast(`Выделение снято с ${dropped} ${pluralRows(dropped)}: они ушли из текущей выборки`);
    }

    const count = state.selected.size;
    $(state, 'mass-bar').hidden = count === 0;
    // Выделение изменилось — прежняя причина могла перестать быть правдой.
    hideMassWarn(state);
    $(state, 'selected-count').textContent = `Выбрано: ${count}`;
    $(state, 'foot-selected').textContent = count ? `Выделено: ${count}` : '';

    const checkAll = $(state, 'check-all');
    checkAll.checked = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
    checkAll.indeterminate = count > 0 && !checkAll.checked;
}

/**
 * Общий разборщик окончаний (К145). Был частным случаем для строк — стал
 * общим: числительные обязаны быть согласованы во ВСЕХ текстах, где есть
 * число. «Статус обновлён для 1 источников» выдаёт, что текст собран
 * склейкой, и подрывает доверие к самому числу.
 */

// «снято с 1 строки / с 2 строк / с 5 строк» — родительный после предлога «с»,
// поэтому 2–4 берут ту же форму, что и 5+.
function pluralRows(n) {
    return plural(n, 'строки', 'строк', 'строк');
}

// ---------------------------------------------------------------- события

function bindEvents(state) {
    const { container } = state;

    container.addEventListener('click', async (event) => {
        const target = event.target;

        const platformBtn = target.closest('[data-platform]');
        if (platformBtn && container.contains(platformBtn)) {
            const raw = platformBtn.dataset.platform;
            state.platformId = raw === '' ? null : Number(raw);
            // Отложенный поиск обязан быть снят вместе с полем: набрать текст
            // и, не дожидаясь задержки, выбрать площадку — обычное движение.
            // Без этого таймер срабатывал уже ПОСЛЕ смены площадки, возвращал
            // результаты поиска и перебивал выбор: в списке площадок горела
            // одна, а в таблице лежала другая. Найдено собственной проверкой.
            clearTimeout(state.searchTimer);
            state.search = '';
            $(state, 'search').value = '';
            state.selected.clear();
            await refresh(state);
            return;
        }

        const tab = target.closest('[data-status]');
        if (tab) {
            state.status = tab.dataset.status;
            renderTabs(state);
            renderChips(state);
            renderRows(state);
            renderSelection(state);
            return;
        }

        const clear = target.closest('[data-clear]');
        if (clear) {
            await applyClear(state, clear.dataset.clear);
            return;
        }

        const edit = target.closest('[data-edit]');
        if (edit) {
            const source = state.sources.find((s) => s.id === Number(edit.dataset.edit));
            if (source) openSourceModal(state, source);
            return;
        }

        const del = target.closest('[data-del]');
        if (del) {
            const source = state.sources.find((s) => s.id === Number(del.dataset.del));
            if (source) await removeSource(state, source);
            return;
        }

        if (target.closest('[data-role="add-source"]')) {
            openSourceModal(state, null);
            return;
        }
        if (target.closest('[data-role="manage-platforms"]')) {
            openPlatformsModal(state);
            return;
        }
        // Кнопка «Площадка» под списком (К142): то же окно, но сразу с
        // развёрнутой формой — она заводит площадку, а не управляет списком.
        if (target.closest('[data-role="add-platform"]')) {
            openPlatformsModal(state, { openForm: true });
            return;
        }
        if (target.closest('[data-role="mass-apply"]')) {
            await applyMassAction(state);
            return;
        }
        if (target.closest('[data-role="mass-clear"]')) {
            state.selected.clear();
            renderRows(state);
            renderSelection(state);
            return;
        }

        const emptyAction = target.closest('[data-role="empty-action"]');
        if (emptyAction) {
            const act = emptyAction.dataset.act;
            if (act === 'platforms') openPlatformsModal(state);
            else if (act === 'add') openSourceModal(state, null);
            else if (act === 'clear-search') await applyClear(state, 'search');
            else if (act === 'clear-filters') await applyClear(state, 'filters');
        }
    });

    container.addEventListener('change', (event) => {
        const check = event.target.closest('[data-check]');
        if (check) {
            const id = Number(check.dataset.check);
            if (check.checked) state.selected.add(id); else state.selected.delete(id);
            const row = check.closest('tr');
            if (row) row.classList.toggle('ui-table__row--selected', check.checked);
            renderSelection(state);
            return;
        }
        if (event.target.closest('[data-role="check-all"]')) {
            const checked = event.target.checked;
            visibleSources(state).forEach((s) => {
                if (checked) state.selected.add(s.id); else state.selected.delete(s.id);
            });
            renderRows(state);
            renderSelection(state);
        }
    });

    const searchField = $(state, 'search');
    const scheduleSearch = (value) => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(async () => {
            if (state.destroyed) return;
            state.search = value;
            // Поиск КРОСС-ПЛОЩАДОЧНЫЙ: он игнорирует выбранную площадку и
            // отдаёт строки всех сразу. Значит и выбор в боку обязан быть
            // снят (К138) — иначе в списке площадок горит одна, а в таблице
            // лежат девять строк двух площадок, и счётчик рядом с подсвеченной
            // строкой говорит «5». Обратное направление (выбор площадки
            // снимает поиск) работало и раньше; правило одно на оба.
            if (value) state.platformId = null;
            state.selected.clear();
            await refresh(state);
        }, SEARCH_DEBOUNCE_MS);
    };
    searchField.addEventListener('input', (event) => scheduleSearch(event.target.value.trim()));
    // У type="search" есть свой крестик и Esc: браузер чистит поле, а события
    // input при этом может и не быть. Без этого поле пустое, а список остаётся
    // отфильтрованным — и непонятно почему.
    searchField.addEventListener('search', (event) => scheduleSearch(event.target.value.trim()));

    // Регион и сеть считаются на клиенте: запроса нет, перерисовки достаточно.
    // Выделение при этом сбрасывается — строки, которых больше не видно, не
    // должны остаться выбранными и уехать в массовое действие.
    $(state, 'filter-region').addEventListener('change', (event) => {
        state.region = event.target.value;
        state.selected.clear();
        renderAll(state);
    });
    $(state, 'filter-network').addEventListener('change', (event) => {
        state.networkId = event.target.value;
        state.selected.clear();
        renderAll(state);
    });
}

async function applyClear(state, what) {
    // Тот же случай, что и при выборе площадки: снятый фильтр не должен
    // вернуться из отложенного таймера через треть секунды.
    clearTimeout(state.searchTimer);
    // Регион, сеть и статус считаются на клиенте — перерисовываем без запроса.
    // 'filters' — все три разом, кнопка пустого состояния «Сбросить фильтры»
    // (К134): снимать один статус и оставлять чипы региона и сети значило бы
    // нажать кнопку и не получить ни строки.
    if (what === 'status' || what === 'region' || what === 'network' || what === 'filters') {
        if (what === 'status' || what === 'filters') state.status = 'all';
        if (what === 'region' || what === 'filters') state.region = '';
        if (what === 'network' || what === 'filters') state.networkId = '';
        renderAll(state);
        return;
    }
    if (what === 'search' || what === 'all') {
        state.search = '';
        $(state, 'search').value = '';
    }
    if (what === 'platform' || what === 'all') state.platformId = null;
    if (what === 'all') {
        state.status = 'all';
        state.region = '';
        state.networkId = '';
    }
    state.selected.clear();
    await refresh(state);
}

async function refresh(state) {
    try {
        await loadSources(state);
        if (state.destroyed) return;
        renderAll(state);
    } catch (err) {
        fail(state, err);
    }
}

// ---------------------------------------------------------------- источник

// Обязательные текстовые поля окна — в порядке формы. Отсюда берутся и
// подписи для тоста, и порядок, в котором ищется первое незаполненное.
const REQUIRED_SOURCE_FIELDS = [
    ['platform', 'Площадка'],
    ['rootSource', 'Корневой источник'],
    ['cityRegion', 'Город/Регион'],
    ['leadSource', 'Источник лидов']
];

function openSourceModal(state, source) {
    // Площадка — ПОЛЕ, а не заметка о контексте (К130). До правки поле
    // появлялось только при создании из режима «Все площадки», а при правке на
    // его месте стояла заметка `.src-context-note` — и источник, заведённый не
    // на ту площадку, переносился только удалением и перезаводом. Удаление
    // отвязывает от источника лидов безвозвратно, то есть цена опечатки была
    // «откуда эти лиды пришли, узнать больше нельзя».
    const platformId = source ? source.platformId : state.platformId;

    const body = document.createElement('div');
    // ПОРЯДОК ПОЛЕЙ — от опознания к связям (К129): где размещаемся → как
    // называется → где работает → как приходит → в каком состоянии → кому
    // отдаём. Множественный выбор сетей стоит ПОСЛЕДНИМ намеренно: он самый
    // высокий (каждая лишняя строка чипов добавляет окну 41 px) и самый
    // необязательный к перечитыванию. Вторым он разрывал форму пополам.
    body.innerHTML = `
        <div class="ui-form-grid">
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Площадка</label>
                <select class="ui-field__control" data-field="platform">
                    ${state.platforms.map((p) => `<option value="${p.id}"${String(p.id) === String(platformId) ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
                </select>
                <span class="ui-field__error"></span>
            </div>
            <div class="ui-field">
                <label class="ui-field__label ui-field__label--required">Корневой источник</label>
                <input class="ui-field__control" data-field="rootSource" placeholder="Название, телефон или ссылка" value="${escapeHtml(source ? source.rootSource : '')}">
                <span class="ui-field__error"></span>
            </div>
            <div class="ui-field">
                <label class="ui-field__label ui-field__label--required">Город/Регион</label>
                <input class="ui-field__control" data-field="cityRegion" placeholder="Например, «Москва»" value="${escapeHtml(source ? source.cityRegion : '')}">
                <span class="ui-field__error"></span>
            </div>
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Источник лидов</label>
                <input class="ui-field__control" data-field="leadSource" placeholder="Например, «Форма на сайте»" value="${escapeHtml(source ? source.leadSource : '')}">
                <span class="ui-field__error"></span>
            </div>
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Статус</label>
                <select class="ui-field__control" data-field="status">
                    ${STATUSES.map((s) => `<option value="${s}"${source && source.status === s ? ' selected' : ''}>${s}</option>`).join('')}
                </select>
            </div>
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">CPA-сети (минимум одна)</label>
                <div class="ui-choices" data-field="networks">
                    ${state.cpaNetworks.map((n) => {
                        const checked = source && (source.cpaNetworkIds || []).includes(n.id);
                        return `<label class="ui-choice${checked ? ' ui-choice--on' : ''}">
                            <input type="checkbox" value="${n.id}"${checked ? ' checked' : ''}>${escapeHtml(n.name)}
                        </label>`;
                    }).join('')}
                </div>
                <span class="ui-field__error" data-error="networks">Выберите хотя бы одну CPA-сеть.</span>
            </div>
        </div>`;

    const field = (name) => body.querySelector(`[data-field="${name}"]`);
    const fieldBox = (name) => field(name).closest('.ui-field');

    body.querySelectorAll('.ui-choice input').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            checkbox.closest('.ui-choice').classList.toggle('ui-choice--on', checkbox.checked);
            // Исправленное поле не должно оставаться красным до следующего
            // нажатия «Сохранить».
            if (body.querySelector('.ui-choice input:checked')) {
                fieldBox('networks').classList.remove('ui-field--error');
            }
        });
    });
    REQUIRED_SOURCE_FIELDS.forEach(([name]) => {
        field(name).addEventListener('input', () => {
            if (field(name).value.trim()) fieldBox(name).classList.remove('ui-field--error');
        });
    });

    function markError(name, message) {
        const box = fieldBox(name);
        box.classList.add('ui-field--error');
        const note = box.querySelector('.ui-field__error');
        if (note && message) note.textContent = message;
    }

    /**
     * Проверка ДО отправки, и незаполненные называются ВСЕ СРАЗУ (К131).
     * Раньше клиент смотрел только на сети, а остальные четыре обязательных
     * поля отдавал серверу — тот возвращает ПЕРВУЮ ошибку и останавливается,
     * и чтобы узнать про три пустых поля, приходилось трижды сходить на сервер.
     * Ни одно поле при этом не краснело и фокус оставался в BODY.
     */
    function validate() {
        body.querySelectorAll('.ui-field--error').forEach((box) => box.classList.remove('ui-field--error'));

        const empty = REQUIRED_SOURCE_FIELDS.filter(([name]) => !field(name).value.trim());
        const noNetworks = body.querySelectorAll('.ui-choice input:checked').length === 0;
        if (!empty.length && !noNetworks) return true;

        empty.forEach(([name]) => markError(name, 'Поле обязательно'));
        // У сетей свой текст: «поле обязательно» не объясняет, чего именно не
        // хватает при двадцати доступных чипах.
        if (noNetworks) markError('networks');

        if (empty.length) {
            const labels = empty.map(([, label]) => label).join(', ');
            state.ctx.toast(empty.length === 1
                ? `Заполните обязательное поле: ${labels}`
                : `Заполните обязательные поля: ${labels}`, 'error');
            field(empty[0][0]).focus();
        } else {
            // Только сети: тоста нет и не было — поле краснеет прямо под
            // курсором, и второе объяснение тут лишнее.
            field('networks').querySelector('input').focus();
        }
        return false;
    }

    const modal = openModal({
        title: source ? 'Изменить источник' : 'Новый источник',
        body,
        scope: state.panel,
        size: 'wide',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: false },
            {
                label: 'Сохранить',
                onClick: async () => {
                    if (!validate()) return false;

                    const payload = {
                        platformId: Number(field('platform').value),
                        rootSource: field('rootSource').value.trim(),
                        leadSource: field('leadSource').value.trim(),
                        cityRegion: field('cityRegion').value.trim(),
                        status: field('status').value,
                        cpaNetworkIds: Array.from(body.querySelectorAll('.ui-choice input:checked')).map((c) => Number(c.value))
                    };

                    try {
                        if (source) {
                            await updateSource(state.ctx.api, source.id, payload);
                            state.ctx.toast('Источник сохранён', 'success');
                        } else {
                            await createSource(state.ctx.api, payload);
                            state.ctx.toast('Источник добавлен', 'success');
                        }
                    } catch (err) {
                        // Ошибка сервера оставляет окно открытым: закрыть его —
                        // значит потерять введённое.
                        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
                        return false;
                    }
                    await reloadAll(state);
                    return true;
                }
            }
        ]
    });

    // Фокус — в ПЕРВОЕ ПОЛЕ, а не на «Сохранить» (К128). Прежний autofocus на
    // подтверждающей кнопке превращал Enter в случайную отправку формы, которую
    // ещё не заполнили. Слой сам по себе ставит фокус на крестик закрытия — он
    // выше по разметке, — поэтому поле назначается здесь, руками.
    field('platform').focus();
    return modal;
}

/**
 * Последствие удаления источника — лиды, которые останутся без него (К132).
 * `leads.source_id` объявлен ON DELETE SET NULL: лид никуда не денется, но
 * узнать, откуда он пришёл, будет уже нечем.
 *
 * При НУЛЕ лидов фраза не показывается: «На нём 0 лидов» — шум, а не
 * предупреждение.
 */
async function removeSource(state, source) {
    const count = source.leadsCount || 0;
    const tail = count
        ? ` На нём ${count} ${plural(count, 'лид', 'лида', 'лидов')} — они останутся в системе, но без источника: откуда они пришли, восстановить будет нельзя.`
        : ' Это необратимо.';
    const ok = await state.ctx.confirmDanger({
        title: 'Удалить источник?',
        message: `Источник «${source.rootSource}» будет удалён.${tail}`,
        confirmLabel: 'Удалить'
    });
    if (!ok) return;
    try {
        await deleteSource(state.ctx.api, source.id);
        state.ctx.toast(count
            ? `Источник удалён, ${count} ${plural(count, 'лид', 'лида', 'лидов')} ${plural(count, 'остался', 'остались', 'остались')} без источника`
            : 'Источник удалён', 'success');
        await reloadAll(state);
    } catch (err) {
        // До части 5 источник удалялся всегда, а у лидов молча обнулялось,
        // откуда они пришли. Теперь это запрет — и он обязан объясниться.
        if (isDeleteBlocked(err)) {
            openDeleteBlocked({
                scope: state.panel,
                sub: `Источник «${source.rootSource}»`,
                lead: 'К источнику привязано то, что удалением потерялось бы навсегда:',
                tail: 'Отвяжите или удалите это по отдельности — тогда источник удалится.',
                blockers: err.blockers
            });
            return;
        }
        fail(state, err);
    }
}

// ---------------------------------------------------------------- массовые действия

/**
 * Причина отказа — строкой в полосе, а не тостом (К95): полоса одна на три
 * раздела, и объясняться она обязана одинаково. Тост уходит через несколько
 * секунд, а выделение и полоса остаются без единого слова.
 */
function showMassWarn(state, text) {
    const node = $(state, 'mass-warn');
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
}

function hideMassWarn(state) {
    const node = $(state, 'mass-warn');
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
}

async function applyMassAction(state) {
    const action = $(state, 'mass-action').value;
    if (!action) {
        showMassWarn(state, 'Выберите действие');
        return;
    }
    if (state.selected.size === 0) {
        showMassWarn(state, 'Выберите хотя бы один источник');
        return;
    }
    hideMassWarn(state);
    const ids = Array.from(state.selected);

    if (action === 'delete') {
        // Последствие называется и здесь (К132): на двенадцати выделенных
        // источниках лидов может оказаться больше, чем на любом одном, и
        // молчать о них тем более нельзя.
        const leadsTotal = ids.reduce((sum, id) => {
            const found = state.sources.find((s) => s.id === id);
            return sum + (found ? (found.leadsCount || 0) : 0);
        }, 0);
        const tail = leadsTotal
            ? ` На них ${leadsTotal} ${plural(leadsTotal, 'лид', 'лида', 'лидов')} — они останутся в системе, но без источника.`
            : ' Это необратимо.';
        const ok = await state.ctx.confirmDanger({
            title: 'Удалить источники?',
            message: `Будет удалено источников: ${ids.length}.${tail}`,
            confirmLabel: 'Удалить'
        });
        if (!ok) return;
        let deleted = 0;
        let failed = 0;
        for (const id of ids) {
            try {
                await deleteSource(state.ctx.api, id);
                deleted++;
            } catch (err) {
                if (isAbort(err)) return;
                failed++;
            }
        }
        state.selected.clear();
        await reloadAll(state);
        if (deleted > 0) state.ctx.toast(`Удалено источников: ${deleted}`, 'success');
        if (failed > 0) state.ctx.toast(`Не удалось удалить: ${failed}`, 'error');
        return;
    }

    // Смена статуса — по одному PUT на источник, тело берём из уже
    // загруженного списка (тот же приём, что в массовых действиях
    // «Сотрудников»: сервер ждёт полный объект).
    let changed = 0;
    let failed = 0;
    for (const id of ids) {
        const source = state.sources.find((s) => s.id === id);
        if (!source) { failed++; continue; }
        if (source.status === action) continue;
        try {
            await updateSource(state.ctx.api, id, {
                platformId: source.platformId,
                rootSource: source.rootSource,
                leadSource: source.leadSource,
                cityRegion: source.cityRegion,
                status: action,
                cpaNetworkIds: source.cpaNetworkIds
            });
            changed++;
        } catch (err) {
            if (isAbort(err)) return;
            failed++;
        }
    }
    state.selected.clear();
    await reloadAll(state);
    // Числительные согласованы, и предлог — «у», как в паспорте (К145):
    // «Статус обновлён у 1 источника», «у 3 источников». После «у» идёт
    // родительный, поэтому 2–4 берут ту же форму, что и 5+.
    if (changed > 0) {
        state.ctx.toast(`Статус обновлён у ${changed} ${plural(changed, 'источника', 'источников', 'источников')}`, 'success');
    } else if (failed === 0) {
        state.ctx.toast('Нет источников для изменения (уже нужный статус)');
    }
    if (failed > 0) {
        state.ctx.toast(`Не удалось обновить ${failed} ${plural(failed, 'источник', 'источника', 'источников')}`, 'error');
    }
}

// ---------------------------------------------------------------- площадки

function openPlatformsModal(state, { openForm: startWithForm = false } = {}) {
    const body = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'src-platforms-list';
    body.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ui-btn ui-btn--ghost';
    addBtn.style.marginTop = 'var(--ui-space-4)';
    addBtn.innerHTML = '<svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg>Добавить площадку';
    body.appendChild(addBtn);

    const form = document.createElement('div');
    form.className = 'src-inline-form';
    form.hidden = true;
    form.innerHTML = `
        <div class="ui-form-grid">
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Название</label>
                <input class="ui-field__control" data-field="name" placeholder="Например, «Авито»">
                <span class="ui-field__error">Укажите название площадки.</span>
            </div>
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label">Статус</label>
                <select class="ui-field__control" data-field="status">
                    <option value="Активна">Активна</option>
                    <option value="Неактивна">Неактивна</option>
                </select>
            </div>
        </div>
        <div class="src-inline-form__actions">
            <button type="button" class="ui-btn ui-btn--ghost" data-act="cancel">Отмена</button>
            <button type="button" class="ui-btn" data-act="save">Сохранить</button>
        </div>`;
    body.appendChild(form);

    let editingId = null;

    const renderList = () => {
        list.innerHTML = state.platforms.map((platform) => {
            const blocked = (platform.sourcesCount || 0) > 0;
            const pill = platform.status === 'Активна' ? 'ui-pill--ok' : 'ui-pill--mute';
            return `
                <div class="src-platform-row">
                    <span class="ui-pill ${pill}">${escapeHtml(platform.status)}</span>
                    <span class="src-platform-row__name">${escapeHtml(platform.name)}</span>
                    <span class="src-platform-row__meta">Источников: ${platform.sourcesCount || 0}</span>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-pedit="${platform.id}" aria-label="Изменить" title="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-pdel="${platform.id}"${blocked ? ' disabled' : ''} aria-label="Удалить"
                            title="${blocked ? `Нельзя удалить — у площадки есть источники (${platform.sourcesCount})` : 'Удалить'}"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                </div>`;
        }).join('') || '<p class="src-side__note">Площадок пока нет — добавьте первую.</p>';
    };
    renderList();

    const openForm = (platform) => {
        editingId = platform ? platform.id : null;
        form.querySelector('[data-field="name"]').value = platform ? platform.name : '';
        form.querySelector('[data-field="status"]').value = platform ? platform.status : 'Активна';
        form.querySelector('.ui-field').classList.remove('ui-field--error');
        form.hidden = false;
        form.querySelector('[data-field="name"]').focus();
    };

    addBtn.addEventListener('click', () => openForm(null));

    list.addEventListener('click', async (event) => {
        const edit = event.target.closest('[data-pedit]');
        if (edit) {
            openForm(state.platforms.find((p) => p.id === Number(edit.dataset.pedit)));
            return;
        }
        const del = event.target.closest('[data-pdel]');
        if (!del || del.disabled) return;
        const platform = state.platforms.find((p) => p.id === Number(del.dataset.pdel));
        const ok = await state.ctx.confirmDanger({
            title: 'Удалить площадку?',
            message: `Площадка «${platform.name}» будет удалена. Это необратимо.`,
            confirmLabel: 'Удалить'
        });
        if (!ok) return;
        try {
            await deletePlatform(state.ctx.api, platform.id);
            state.ctx.toast('Площадка удалена', 'success');
            await reloadAll(state);
            renderList();
        } catch (err) {
            fail(state, err);
        }
    });

    form.addEventListener('click', async (event) => {
        if (event.target.closest('[data-act="cancel"]')) {
            form.hidden = true;
            editingId = null;
            return;
        }
        if (!event.target.closest('[data-act="save"]')) return;

        const nameField = form.querySelector('[data-field="name"]');
        const name = nameField.value.trim();
        nameField.closest('.ui-field').classList.toggle('ui-field--error', !name);
        if (!name) {
            // Дословно то же, что под полем и на сервере, вместе с точкой (К145).
            state.ctx.toast('Укажите название площадки.', 'error');
            nameField.focus();
            return;
        }
        const payload = { name, status: form.querySelector('[data-field="status"]').value };
        try {
            if (editingId) {
                await updatePlatform(state.ctx.api, editingId, payload);
                state.ctx.toast('Площадка сохранена', 'success');
            } else {
                await createPlatform(state.ctx.api, payload);
                state.ctx.toast('Площадка добавлена', 'success');
            }
            form.hidden = true;
            editingId = null;
            await reloadAll(state);
            renderList();
        } catch (err) {
            fail(state, err);
        }
    });

    // «Готово» основной, а не тихая «Закрыть» (К133). Это третье окно
    // управления справочником в проекте: «Управление отделами» и «Управление
    // сетями» прощаются именно так. Три одинаковых окна не должны прощаться
    // тремя разными словами.
    openModal({
        title: 'Управление площадками',
        body,
        scope: state.panel,
        actions: [{ label: 'Готово', value: false }]
    });

    // Открытие по кнопке «Площадка» из бока (К142): форма развёрнута сразу, и
    // фокус — в «Название». Открытие по «Управление площадками» из шапки
    // оставляет фокус так, как его ставит слой: формы в этот момент ещё нет.
    if (startWithForm) openForm(null);
}
