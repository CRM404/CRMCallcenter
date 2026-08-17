// --- shell/app.js: точка входа приложения ---
//
// Собирает оболочку воедино: реестр разделов, маршрут, панели, монтирование
// разделов и состояние стола.
//
// НАПРАВЛЕНИЕ ЗАВИСИМОСТЕЙ. Этот модуль не знает про стол, полосу свёрнутых
// и их разметку — они импортируют `shell` отсюда и подписываются. Так стол и
// полоса могут писаться параллельно с ядром и меняться, не трогая его.
//
//     import { shell } from './app.js';
//     shell.on('change', () => { ... перерисовать полосу свёрнутых ... });
//     shell.openSection('leads');

import { createApiScope } from '../api.js';
import { showToast } from '../ui/toast.js';
import { confirm, confirmDanger } from '../ui/modal.js';
import { startRouter, setRoute } from './router.js';
import {
    initPanels, openSection as openPanelFor, closePanel, minimizePanel,
    restorePanel, minimizeAll, setActive, canSplit,
    getState as getPanelsState, getVisibleKeys, getMinimized, setShare
} from './panels.js';

// ---------------------------------------------------------------- реестр
//
// Добавить раздел = одна строка здесь плюс модуль. Поля:
//   key        — ключ в адресе: /#/leads
//   title      — название в шапке панели и на плитке
//   icon       — класс иконки Font Awesome
//   module     — путь к модулю раздела; пока раздел не перенесён — null
//   template   — путь к фрагменту разметки; грузится при первом монтировании
//   legacyUrl  — старый адрес: пока раздел не перенесён, открывается там,
//                в новой вкладке, и плитка это честно показывает

export const registry = [
    { key: 'requisites', title: 'Реквизиты',  icon: 'fas fa-building',       module: null, template: null, legacyUrl: '/main.html' },
    { key: 'employees',  title: 'Сотрудники', icon: 'fas fa-users',          module: null, template: null, legacyUrl: '/emploees.html' },
    { key: 'leads',      title: 'Лиды',       icon: 'fas fa-address-book',   module: null, template: null, legacyUrl: '/leads.html' },
    { key: 'sources',    title: 'Источники',  icon: 'fas fa-diagram-project',module: null, template: null, legacyUrl: '/sources.html' },
    { key: 'cpa',        title: 'CPA-сети',   icon: 'fas fa-handshake',      module: null, template: null, legacyUrl: '/cpa-networks.html' },
    { key: 'scripts',    title: 'Скрипты',    icon: 'fas fa-file-lines',     module: null, template: null, legacyUrl: '/scripts-admin.html' }
];

// ВРЕМЕННО НА ЭТАП 1. Пока не перенесён ни один раздел, открывать нечего, и
// оболочку не на чем проверить. Флаг заставляет панель показывать заглушку
// вместо перехода по старому адресу.
//
// СНИМАЕТСЯ НА ЭТАПЕ 2, вместе с переносом «Реквизитов». Если он дожил до
// этапа 3 — это дефект: половина разделов будет показывать пустышку вместо
// работающей страницы.
const STAGE_1_STUBS = true;

const STORAGE_KEY = 'shellDesktopState';

const listeners = new Map();
const mounted = new Map();      // panelId → { key, api, unmount, container }
const templates = new Map();    // путь фрагмента → текст разметки

let started = false;

export const shell = {
    registry,
    start,
    openSection,
    closeSection: closePanel,
    minimizeSection: minimizePanel,
    restoreSection: restorePanel,
    minimizeAll,
    setActive,
    canSplit,
    getMinimized,
    isMigrated,
    toast: showToast,
    on, off
};

// ---------------------------------------------------------------- запуск

function start(roots = {}) {
    if (started) return shell;
    started = true;

    const workspaceRoot = roots.workspace
        || document.querySelector('[data-role="workspace-root"]')
        || document.body;

    initPanels(workspaceRoot, { onEvent: handlePanelEvent });
    restoreState();

    startRouter({
        known: registry.map((s) => s.key),
        onRoute: handleRoute
    });

    return shell;
}

// ---------------------------------------------------------------- разделы

function isMigrated(key) {
    const section = find(key);
    return !!section && (STAGE_1_STUBS || !!section.module);
}

/**
 * Открыть раздел. Неперенесённый уходит в новую вкладку по старому адресу —
 * это осознанное поведение на время миграции, и плитка предупреждает о нём
 * заранее, чтобы человек не счёл переход поломкой.
 */
function openSection(key) {
    const section = find(key);
    if (!section) return;

    if (!isMigrated(key)) {
        showToast(`«${section.title}» ещё не перенесён — откроется по старому адресу в новой вкладке`);
        window.open(section.legacyUrl, '_blank', 'noopener');
        return;
    }

    openPanelFor(key, { title: section.title, icon: section.icon });
}

// ---------------------------------------------------------------- события панелей

function handlePanelEvent(event) {
    if (event.type === 'mount') {
        mountSection(event.panelId, event.key, event.container);
        return;
    }
    if (event.type === 'unmount') {
        unmountSection(event.panelId);
        return;
    }
    if (event.type === 'notice') {
        showToast(event.message);
        return;
    }
    if (event.type === 'split-request') {
        emit('split-request', event);
        return;
    }
    if (event.type === 'change') {
        setRoute(getVisibleKeys());
        saveState();
        emit('change', event);
        return;
    }
    if (event.type === 'activate') {
        emit('activate', event);
    }
}

async function mountSection(panelId, key, container) {
    const section = find(key);
    if (!section) return;

    const api = createApiScope();
    const ctx = {
        panelId,
        api,
        toast: showToast,
        confirm: (opts) => confirm({ ...opts, scope: container.closest('.shell-panel') }),
        confirmDanger,
        // Раздел не обращается к document глобально — только к своему
        // контейнеру. Хелпер даёт это явно, чтобы соблазна было меньше.
        find: (selector) => container.querySelector(selector),
        findAll: (selector) => Array.from(container.querySelectorAll(selector))
    };

    mounted.set(panelId, { key, api, unmount: null, container });

    // Заглушка этапа 1: панели проверяются до того, как появится первый
    // перенесённый раздел.
    if (!section.module) {
        renderStub(container, section);
        return;
    }

    try {
        if (section.template) {
            container.innerHTML = '';
            container.appendChild(await loadTemplate(section.template));
        }
        const module = await import(section.module);
        // Панель могли закрыть, пока грузился модуль.
        if (!mounted.has(panelId)) return;
        await module.mount(container, ctx);
        const record = mounted.get(panelId);
        if (record) record.unmount = module.unmount;
    } catch (err) {
        renderFailure(container, section, err);
    }
}

function unmountSection(panelId) {
    const record = mounted.get(panelId);
    if (!record) return;
    mounted.delete(panelId);

    // Сначала обрываем запросы, потом снимаем слушатели: иначе ответ успеет
    // прийти в уже разобранный раздел.
    record.api.abort();
    try {
        if (typeof record.unmount === 'function') record.unmount();
    } catch (err) {
        console.error(`Раздел «${record.key}» упал при размонтировании:`, err);
    }
    record.container.innerHTML = '';
}

/**
 * Фрагмент разметки раздела. Единственное разрешённое место, где оболочка
 * ходит в сеть мимо storage-модулей, — так записано в брифе. Загруженный
 * фрагмент кэшируется: второе открытие того же раздела запроса не делает.
 */
async function loadTemplate(path) {
    if (!templates.has(path)) {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`Не удалось загрузить разметку раздела (${response.status})`);
        templates.set(path, await response.text());
    }
    const holder = document.createElement('div');
    holder.innerHTML = templates.get(path);
    const fragment = document.createDocumentFragment();
    while (holder.firstChild) fragment.appendChild(holder.firstChild);
    return fragment;
}

function renderStub(container, section) {
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'ui-empty';
    const title = document.createElement('h3');
    title.textContent = section.title;
    const text = document.createElement('p');
    text.textContent = 'Раздел ещё не перенесён в оболочку. Панель показана для проверки поведения окон.';
    box.append(title, text);
    container.appendChild(box);
}

function renderFailure(container, section, err) {
    console.error(`Раздел «${section.key}» не открылся:`, err);
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'ui-empty';
    const title = document.createElement('h3');
    title.textContent = `«${section.title}» не открылся`;
    const text = document.createElement('p');
    text.textContent = err && err.message ? err.message : 'Неизвестная ошибка.';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'ui-btn ui-btn--sm';
    again.textContent = 'Открыть по старому адресу';
    again.addEventListener('click', () => window.open(section.legacyUrl, '_blank', 'noopener'));
    box.append(title, text, again);
    container.appendChild(box);
}

// ---------------------------------------------------------------- маршрут

function handleRoute({ keys, unknown, source }) {
    if (unknown.length) {
        showToast(`В адресе неизвестный раздел: ${unknown.join(', ')}`, 'error');
    }
    // Изменение адреса вручную или кнопкой «назад» — приводим панели к нему.
    if (source === 'address' || source === 'start') {
        syncToKeys(keys);
    }
}

function syncToKeys(keys) {
    const current = getVisibleKeys();
    if (current.join('+') === keys.join('+')) return;

    // Разделы, которых в адресе больше нет, закрываем; недостающие открываем.
    getMinimized(); // состояние свёрнутых адрес не описывает — не трогаем
    current.filter((key) => !keys.includes(key)).forEach((key) => {
        const panel = findPanelByKey(key);
        if (panel) closePanel(panel.panelId, { silent: true });
    });
    keys.filter((key) => !current.includes(key)).forEach((key) => openSection(key));
}

function findPanelByKey(key) {
    const state = getPanelsState();
    const index = state.panels.findIndex((p) => p.key === key && !p.minimized);
    if (index === -1) return null;
    const node = document.querySelector(`.shell-panel[data-section-key="${key}"]:not([hidden])`);
    return node ? { panelId: node.dataset.panelId } : null;
}

// ---------------------------------------------------------------- состояние
//
// sessionStorage: переживает F5, умирает вместе с вкладкой. Правило проекта
// уточнено брифом — здесь хранится состояние ИНТЕРФЕЙСА, но не бизнес-данные.

function saveState() {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(getPanelsState()));
    } catch (e) {
        // Приватный режим или переполнение — состояние стола не та вещь,
        // ради которой стоит показывать ошибку.
    }
}

function restoreState() {
    let saved = null;
    try {
        saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) { saved = null; }
    if (!saved) return;

    if (typeof saved.share === 'number') setShare(saved.share);

    // Восстанавливаем только свёрнутые: открытые панели задаёт адрес, и он
    // главнее — иначе ссылка, присланная коллегой, открывала бы чужой набор.
    (saved.panels || []).filter((p) => p.minimized).forEach((p) => {
        const section = find(p.key);
        if (!section) return;
        const panel = openPanelFor(p.key, { title: section.title, icon: section.icon });
        if (panel) minimizePanel(panel.id);
    });
}

// ---------------------------------------------------------------- подписки

function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => off(type, handler);
}

function off(type, handler) {
    const set = listeners.get(type);
    if (set) set.delete(handler);
}

function emit(type, payload) {
    const set = listeners.get(type);
    if (!set) return;
    set.forEach((handler) => {
        try { handler(payload); } catch (err) { console.error(err); }
    });
}

function find(key) {
    return registry.find((s) => s.key === key) || null;
}
