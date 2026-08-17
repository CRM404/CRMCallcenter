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

import { openModal } from '/ui/modal.js';
import { isAbort } from '/api.js';
import {
    fetchPlatforms, createPlatform, updatePlatform, deletePlatform,
    fetchCpaNetworks, fetchSources, createSource, updateSource, deleteSource
} from './sourcesStorage.js';

const SEARCH_DEBOUNCE_MS = 300;

const STATUSES = ['Активен', 'Неактивен', 'Актуализация', 'Архив'];

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
    const state = {
        container,
        ctx,
        panel: container.closest('.shell-panel'),
        platforms: [],
        cpaNetworks: [],
        sources: [],
        platformId: null,      // null = «Все площадки»
        search: '',
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
    if (!state) return;
    state.destroyed = true;
    clearTimeout(state.searchTimer);
    // Слушатели висят на узлах контейнера — оболочка очищает контейнер сразу
    // после unmount, поэтому снимать их поимённо не нужно. Таймер поиска —
    // нужно: он переживёт удаление узлов и разбудит мёртвый раздел.
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

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function visibleSources(state) {
    if (state.status === 'all') return state.sources;
    return state.sources.filter((s) => s.status === state.status);
}

/** Кросс-площадочный режим: показывается колонка площадки. */
function isCrossPlatform(state) {
    return !!state.search || state.platformId === null;
}

function renderAll(state) {
    renderStats(state);
    renderPlatforms(state);
    renderTabs(state);
    renderChips(state);
    renderRows(state);
    renderSelection(state);
}

function renderStats(state) {
    // Числа считаются по ВСЕМ источникам, а не по текущей выборке: это состав
    // раздела, а не результат фильтра.
    const all = state.allSources || [];
    $(state, 'stat-platforms').textContent = state.platforms.length;
    $(state, 'stat-sources').textContent = all.length;
    $(state, 'stat-active').textContent = all.filter((s) => s.status === 'Активен').length;
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

    list.innerHTML = rows.map((row) => `
        <button type="button" class="src-platform${row.id === state.platformId ? ' src-platform--active' : ''}${row.off ? ' src-platform--off' : ''}"
                data-platform="${row.id === null ? '' : row.id}">
            <span class="src-platform__name">${escapeHtml(row.name)}</span>
            <span class="src-platform__count">${row.count}</span>
        </button>
    `).join('');

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

    const tabs = [['all', 'Все']].concat(STATUSES.map((s) => [s, s]));
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
            <button type="button" class="ui-fchip__remove" data-clear="search" aria-label="Сбросить поиск"><i class="fas fa-xmark" aria-hidden="true"></i></button></span>`);
    }
    if (state.platformId !== null && !state.search) {
        const platform = state.platforms.find((p) => p.id === state.platformId);
        if (platform) {
            chips.push(`<span class="ui-fchip">Площадка: <b>${escapeHtml(platform.name)}</b>
                <button type="button" class="ui-fchip__remove" data-clear="platform" aria-label="Показать все площадки"><i class="fas fa-xmark" aria-hidden="true"></i></button></span>`);
        }
    }
    if (state.status !== 'all') {
        chips.push(`<span class="ui-fchip">Статус: <b>${escapeHtml(state.status)}</b>
            <button type="button" class="ui-fchip__remove" data-clear="status" aria-label="Сбросить фильтр статуса"><i class="fas fa-xmark" aria-hidden="true"></i></button></span>`);
    }

    const box = $(state, 'filter-chips');
    box.hidden = chips.length === 0;
    box.innerHTML = chips.length
        ? chips.join('') + '<button type="button" class="ui-fchips__clear" data-clear="all">Очистить всё</button>'
        : '';
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
                ${cross ? `<td class="ui-table__muted">${escapeHtml(source.platformName)}</td>` : ''}
                <td><span class="ui-table__main">${escapeHtml(source.rootSource)}</span></td>
                <td class="ui-table__muted">${escapeHtml(source.cityRegion)}</td>
                <td><span class="src-nets">${nets}</span></td>
                <td><span class="ui-pill ${pill} ui-pill--dot">${escapeHtml(source.status)}</span></td>
                <td class="ui-table__muted">${escapeHtml(source.leadSource)}</td>
                <td class="ui-table__acts">
                    <span class="src-cell-actions">
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-edit="${source.id}" aria-label="Изменить" title="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-del="${source.id}" aria-label="Удалить" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
                    </span>
                </td>
            </tr>`;
    }).join('');

    $(state, 'foot-shown').textContent = rows.length === state.sources.length
        ? `Показано ${rows.length}`
        : `Показано ${rows.length} из ${state.sources.length}`;
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
    if (state.status !== 'all') {
        title.textContent = 'Нет источников с таким статусом';
        text.textContent = 'У этой площадки пока нет источников, подходящих под фильтр.';
        action.hidden = false;
        action.textContent = 'Показать все статусы';
        action.dataset.act = 'clear-status';
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
    Array.from(state.selected).forEach((id) => {
        if (!visibleIds.includes(id)) state.selected.delete(id);
    });

    const count = state.selected.size;
    $(state, 'mass-bar').hidden = count === 0;
    $(state, 'selected-count').textContent = `Выбрано: ${count}`;
    $(state, 'foot-selected').textContent = count ? `Выделено: ${count}` : '';

    const checkAll = $(state, 'check-all');
    checkAll.checked = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
    checkAll.indeterminate = count > 0 && !checkAll.checked;
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
            else if (act === 'clear-status') await applyClear(state, 'status');
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

    $(state, 'search').addEventListener('input', (event) => {
        const value = event.target.value.trim();
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(async () => {
            if (state.destroyed) return;
            state.search = value;
            state.selected.clear();
            await refresh(state);
        }, SEARCH_DEBOUNCE_MS);
    });
}

async function applyClear(state, what) {
    if (what === 'status') {
        state.status = 'all';
        renderTabs(state);
        renderChips(state);
        renderRows(state);
        renderSelection(state);
        return;
    }
    if (what === 'search' || what === 'all') {
        state.search = '';
        $(state, 'search').value = '';
    }
    if (what === 'platform' || what === 'all') state.platformId = null;
    if (what === 'all') state.status = 'all';
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

function openSourceModal(state, source) {
    const platformId = source ? source.platformId : state.platformId;
    const platform = state.platforms.find((p) => p.id === platformId);

    // Площадка обязательна: без неё источник не создать. Если открыт режим
    // «Все площадки», выбор площадки становится полем формы.
    const needPlatformChoice = !source && platformId === null;

    const body = document.createElement('div');
    body.innerHTML = `
        ${needPlatformChoice ? '' : `<div class="src-context-note">Площадка: <b>${escapeHtml(source ? source.platformName : (platform ? platform.name : '—'))}</b></div>`}
        <div class="ui-form-grid">
            ${needPlatformChoice ? `
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Площадка</label>
                <select class="ui-field__control" data-field="platform">
                    ${state.platforms.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
                </select>
            </div>` : ''}
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">CPA-сети (минимум одна)</label>
                <div class="src-networks" data-field="networks">
                    ${state.cpaNetworks.map((n) => {
                        const checked = source && (source.cpaNetworkIds || []).includes(n.id);
                        return `<label class="src-network${checked ? ' src-network--checked' : ''}">
                            <input type="checkbox" value="${n.id}"${checked ? ' checked' : ''}>${escapeHtml(n.name)}
                        </label>`;
                    }).join('')}
                </div>
                <span class="ui-field__error" data-error="networks">Выберите хотя бы одну CPA-сеть.</span>
            </div>
            <div class="ui-field">
                <label class="ui-field__label ui-field__label--required">Корневой источник</label>
                <input class="ui-field__control" data-field="rootSource" placeholder="Название, телефон или ссылка" value="${escapeHtml(source ? source.rootSource : '')}">
            </div>
            <div class="ui-field">
                <label class="ui-field__label ui-field__label--required">Город/Регион</label>
                <input class="ui-field__control" data-field="cityRegion" placeholder="Например, «Москва»" value="${escapeHtml(source ? source.cityRegion : '')}">
            </div>
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Статус</label>
                <select class="ui-field__control" data-field="status">
                    ${STATUSES.map((s) => `<option value="${s}"${source && source.status === s ? ' selected' : ''}>${s}</option>`).join('')}
                </select>
            </div>
            <div class="ui-field ui-field--wide">
                <label class="ui-field__label ui-field__label--required">Источник лидов</label>
                <input class="ui-field__control" data-field="leadSource" placeholder="Например, «Форма на сайте»" value="${escapeHtml(source ? source.leadSource : '')}">
            </div>
        </div>`;

    body.querySelectorAll('.src-network input').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            checkbox.closest('.src-network').classList.toggle('src-network--checked', checkbox.checked);
        });
    });

    const field = (name) => body.querySelector(`[data-field="${name}"]`);

    openModal({
        title: source ? 'Изменить источник' : 'Новый источник',
        body,
        scope: state.panel,
        size: 'wide',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: false },
            {
                label: 'Сохранить',
                autofocus: true,
                onClick: async () => {
                    const networks = Array.from(body.querySelectorAll('.src-network input:checked')).map((c) => Number(c.value));
                    const netsField = field('networks').closest('.ui-field');
                    netsField.classList.toggle('ui-field--error', networks.length === 0);
                    if (networks.length === 0) return false;

                    const payload = {
                        platformId: needPlatformChoice ? Number(field('platform').value) : platformId,
                        rootSource: field('rootSource').value.trim(),
                        leadSource: field('leadSource').value.trim(),
                        cityRegion: field('cityRegion').value.trim(),
                        status: field('status').value,
                        cpaNetworkIds: networks
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
}

async function removeSource(state, source) {
    const ok = await state.ctx.confirmDanger({
        title: 'Удалить источник?',
        message: `Источник «${source.rootSource}» будет удалён. Это необратимо.`,
        confirmLabel: 'Удалить'
    });
    if (!ok) return;
    try {
        await deleteSource(state.ctx.api, source.id);
        state.ctx.toast('Источник удалён', 'success');
        await reloadAll(state);
    } catch (err) {
        fail(state, err);
    }
}

// ---------------------------------------------------------------- массовые действия

async function applyMassAction(state) {
    const action = $(state, 'mass-action').value;
    if (!action) {
        state.ctx.toast('Выберите действие', 'error');
        return;
    }
    if (state.selected.size === 0) {
        state.ctx.toast('Выберите хотя бы один источник', 'error');
        return;
    }
    const ids = Array.from(state.selected);

    if (action === 'delete') {
        const ok = await state.ctx.confirmDanger({
            title: 'Удалить источники?',
            message: `Будет удалено источников: ${ids.length}. Это необратимо.`,
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
    if (changed > 0) state.ctx.toast(`Статус обновлён для ${changed} источников`, 'success');
    else if (failed === 0) state.ctx.toast('Нет источников для изменения (уже нужный статус)');
    if (failed > 0) state.ctx.toast(`Не удалось обновить ${failed} источников`, 'error');
}

// ---------------------------------------------------------------- площадки

function openPlatformsModal(state) {
    const body = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'src-platforms-list';
    body.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ui-btn ui-btn--ghost ui-btn--sm';
    addBtn.style.marginTop = 'var(--ui-space-4)';
    addBtn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i>Добавить площадку';
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
            <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-act="cancel">Отмена</button>
            <button type="button" class="ui-btn ui-btn--sm" data-act="save">Сохранить</button>
        </div>`;
    body.appendChild(form);

    let editingId = null;

    const renderList = () => {
        list.innerHTML = state.platforms.map((platform) => {
            const blocked = (platform.sourcesCount || 0) > 0;
            const pill = platform.status === 'Активна' ? 'ui-pill--ok' : 'ui-pill--mute';
            return `
                <div class="src-platform-row">
                    <span class="ui-pill ${pill} ui-pill--dot">${escapeHtml(platform.status)}</span>
                    <span class="src-platform-row__name">${escapeHtml(platform.name)}</span>
                    <span class="src-platform-row__meta">Источников: ${platform.sourcesCount || 0}</span>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-pedit="${platform.id}" aria-label="Изменить" title="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-pdel="${platform.id}"${blocked ? ' disabled' : ''} aria-label="Удалить"
                            title="${blocked ? `Нельзя удалить — у площадки есть источники (${platform.sourcesCount})` : 'Удалить'}"><i class="fas fa-trash" aria-hidden="true"></i></button>
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
            state.ctx.toast('Укажите название площадки', 'error');
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

    openModal({
        title: 'Управление площадками',
        body,
        scope: state.panel,
        actions: [{ label: 'Закрыть', variant: 'ghost', value: false }]
    });
}
