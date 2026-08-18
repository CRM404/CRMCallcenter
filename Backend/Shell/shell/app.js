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
    restorePanel, minimizeAll, setActive, canSplit, reorderPanels as reorderTo,
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
//   styles     — файл раскладки раздела или список файлов
//   legacyUrl  — старый адрес: пока раздел не перенесён, открывается там,
//                в новой вкладке, и плитка это честно показывает

// Временного поля `stub` здесь больше нет: оно заводилось на этап 1, пока не
// был перенесён ни один раздел и оболочку было не на чем проверить. Все шесть
// перенесены — поле снято вместе с кодом, который его читал (бриф: «если stub
// дожил до конца — это дефект»).

export const registry = [
    { key: 'requisites', title: 'Реквизиты',  icon: 'fas fa-building',       module: '/js/modules/mainApp.js', template: '/main-section.html', styles: '/css/main-light.css', legacyUrl: '/main.html' },
    { key: 'employees',  title: 'Сотрудники', icon: 'fas fa-users',          module: '/js/modules/employeesApp.js', template: '/employees-section.html', styles: ['/css/employees-light.css', '/css/employees-schedule.css'], legacyUrl: '/emploees.html' },
    { key: 'leads',      title: 'Лиды',       icon: 'fas fa-address-book',   module: '/js/modules/leadsApp.js', template: '/leads-section.html', styles: '/css/leads-light.css', legacyUrl: '/leads.html' },
    { key: 'sources',    title: 'Источники',  icon: 'fas fa-diagram-project',module: '/js/modules/sourcesSection.js', template: '/sources-section.html', styles: '/css/sources-light.css', legacyUrl: '/sources.html' },
    { key: 'cpa',        title: 'CPA-сети',   icon: 'fas fa-handshake',      module: '/js/modules/cpaApp.js', template: '/cpa-networks-section.html', styles: '/css/cpa-networks-light.css', legacyUrl: '/cpa-networks.html' },
    { key: 'scripts',    title: 'Скрипты',    icon: 'fas fa-file-lines',     module: '/js/modules/scriptsSection.js', template: '/scripts-admin-section.html', styles: '/css/scripts-admin-light.css', legacyUrl: '/scripts-admin.html' }
];

const STORAGE_KEY = 'shellDesktopState';

const listeners = new Map();
const mounted = new Map();      // panelId → { key, api, unmount, container }
const templates = new Map();    // путь фрагмента → текст разметки

let started = false;

// Пока идёт восстановление из sessionStorage, адрес трогать НЕЛЬЗЯ. Иначе
// заход по ссылке /#/leads+employees со свёрнутыми панелями в хранилище
// затирает адрес на «#/» ещё до того, как маршрутизатор его прочитает, — и
// присланная коллегой ссылка открывает пустой стол.
let restoring = false;

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
    return !!section && !!section.module;
}

/**
 * Открыть раздел ПО ДЕЙСТВИЮ ЧЕЛОВЕКА — клик по плитке, по чипу, по пункту
 * выбора. Неперенесённый уходит в новую вкладку по старому адресу; плитка
 * предупреждает об этом заранее, чтобы переход не сочли поломкой.
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

/**
 * Открытие ПО АДРЕСУ — заход по ссылке, правка адреса, кнопка «назад».
 *
 * Отличается от openSection одним, но важным: новую вкладку здесь открывать
 * нельзя. Пользовательского жеста нет, браузер такое всплывающее окно
 * заблокирует, и человек получит предупреждение о блокировке вместо раздела.
 * Поэтому неперенесённый раздел из адреса — только объяснение тостом и
 * ссылка, по которой можно перейти самому.
 */
function openFromAddress(key) {
    const section = find(key);
    if (!section) return;

    if (!isMigrated(key)) {
        showToast(`«${section.title}» ещё не перенесён — он открывается по старому адресу ${section.legacyUrl}`);
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
        if (!restoring) {
            setRoute(getVisibleKeys());
            saveState();
        }
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

    try {
        // Стили раздела — пятый блок структуры («раскладка разделов»).
        // Грузятся при первом открытии раздела, а не все шестью ссылками в
        // index.html: иначе первый экран тянет раскладку всех разделов сразу.
        // styles — строка или список: у «Сотрудников» два файла, режим
        // «График» намеренно живёт в своём (режим «Список» им не задет).
        if (section.styles) {
            const sheets = Array.isArray(section.styles) ? section.styles : [section.styles];
            await Promise.all(sheets.map(loadStyles));
        }

        if (section.template) {
            const fragment = await loadTemplate(section.template);
            // Панель могли закрыть, пока грузилась разметка.
            if (!mounted.has(panelId)) return;
            container.innerHTML = '';
            container.appendChild(fragment);
        }
        const module = await import(section.module);
        // И пока грузился модуль — тоже.
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

/**
 * Стили раздела. Ждём загрузки, а не просто вставляем ссылку: иначе раздел
 * успевает нарисоваться раньше своей раскладки, и человек видит вспышку
 * неоформленного содержимого.
 */
const styleSheets = new Map();
function loadStyles(href) {
    if (styleSheets.has(href)) return styleSheets.get(href);
    const promise = new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        // Раздел без своей раскладки хуже, чем раздел с вспышкой: не даём
        // отказу стилей заблокировать открытие.
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', resolve, { once: true });
        document.head.appendChild(link);
    });
    styleSheets.set(href, promise);
    return promise;
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

    // Тот же набор разделов, но в другом порядке. Открывать и закрывать
    // нечего — а расхождение между адресом и экраном оставлять нельзя: адрес
    // обещал «слева Сотрудники», и это должно быть правдой.
    if (current.length === keys.length && current.every((key) => keys.includes(key))) {
        reorderTo(keys);
        return;
    }

    // Разделы, которых в адресе больше нет, закрываем; недостающие открываем.
    // Свёрнутые не трогаем: адрес их не описывает.
    current.filter((key) => !keys.includes(key)).forEach((key) => {
        const panel = findPanelByKey(key);
        if (panel) closePanel(panel.panelId, { silent: true });
    });
    keys.filter((key) => !current.includes(key)).forEach((key) => openFromAddress(key));
}

function findPanelByKey(key) {
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
    restoring = true;
    try {
        (saved.panels || []).filter((p) => p.minimized).forEach((p) => {
            const section = find(p.key);
            if (!section) return;
            const panel = openPanelFor(p.key, { title: section.title, icon: section.icon });
            if (panel) minimizePanel(panel.id);
        });
    } finally {
        restoring = false;
    }
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
