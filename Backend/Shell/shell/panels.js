// --- shell/panels.js: панели, разделение экрана, тянущаяся граница ---
//
// Панель — окно раздела поверх рабочего стола. Одновременно ВИДИМЫХ панелей
// не больше двух; свёрнутых может быть сколько угодно, они живут в полосе
// внизу (её рисует shell/minimized.js).
//
// СВЁРНУТАЯ ПАНЕЛЬ НЕ РАЗМОНТИРУЕТСЯ. Её узел остаётся в документе под
// [hidden], раздел продолжает жить: введённый в форму текст, выбранные
// фильтры и позиция прокрутки при возврате остаются на месте. Свернуть —
// это не «закрыть и открыть заново», иначе полоса свёрнутых бессмысленна.
//
// Этот модуль НЕ решает, что показать внутри панели, и не показывает тостов
// сам: он сообщает оболочке через onEvent, а та монтирует раздел и говорит
// с пользователем. Иначе панели потянули бы за собой зависимость от реестра
// разделов и слоя элементов.

const MIN_SHARE = 0.28;   // ни одна панель не уже 28 % ширины (бриф, 5.3)
const DEFAULT_SHARE = 0.5;

let workspace = null;
let emit = () => {};
let panels = [];          // { id, key, meta, el, bodyEl, minimized }
let activeId = null;
let share = DEFAULT_SHARE; // доля ЛЕВОЙ панели
let seq = 0;

/**
 * @param {HTMLElement} root                 контейнер рабочей области
 * @param {Object}      opts
 * @param {Function}    opts.onEvent         ({ type, ... }) => void
 */
export function initPanels(root, opts = {}) {
    workspace = document.createElement('div');
    workspace.className = 'shell-workspace';
    workspace.dataset.role = 'workspace';
    root.appendChild(workspace);
    emit = opts.onEvent || (() => {});
    return workspace;
}

/**
 * Открыть раздел.
 *
 * Три случая, все три обязаны быть проговорены пользователю, а не случиться
 * молча (бриф, 5.3):
 *   - раздел уже открыт → фокус на его панель, копии не создаём;
 *   - есть свободное место → новая панель;
 *   - обе панели заняты → заменяем АКТИВНУЮ и говорим, что именно закрыли.
 */
export function openSection(key, meta = {}) {
    const existing = panels.find((p) => p.key === key);
    if (existing) {
        if (existing.minimized) {
            restorePanel(existing.id);
        } else {
            setActive(existing.id);
            emit({ type: 'notice', message: `«${meta.title || key}» уже открыт` });
        }
        return existing;
    }

    const visible = panels.filter((p) => !p.minimized);

    if (visible.length >= 2) {
        const victim = panels.find((p) => p.id === activeId && !p.minimized) || visible[visible.length - 1];
        const victimTitle = victim.meta.title || victim.key;
        closePanel(victim.id, { silent: true });
        const panel = createPanel(key, meta);
        emit({
            type: 'notice',
            message: `Открыто вместо «${victimTitle}» — свободных панелей нет`
        });
        return panel;
    }

    return createPanel(key, meta);
}

/** Разделить экран: доступно, только когда открыта ровно одна панель. */
export function canSplit() {
    return panels.filter((p) => !p.minimized).length === 1;
}

export function closePanel(panelId, opts = {}) {
    const at = panels.findIndex((p) => p.id === panelId);
    if (at === -1) return;
    const panel = panels[at];

    emit({ type: 'unmount', panelId: panel.id, key: panel.key });
    panel.el.remove();
    panels.splice(at, 1);

    if (activeId === panelId) {
        const next = panels.find((p) => !p.minimized);
        activeId = next ? next.id : null;
    }
    layout();
    if (!opts.silent) emit({ type: 'change', reason: 'close' });
}

export function minimizePanel(panelId) {
    const panel = panels.find((p) => p.id === panelId);
    if (!panel || panel.minimized) return;
    panel.minimized = true;
    panel.el.hidden = true;
    if (activeId === panelId) {
        const next = panels.find((p) => !p.minimized);
        activeId = next ? next.id : null;
    }
    layout();
    emit({ type: 'change', reason: 'minimize' });
}

/**
 * Развернуть свёрнутую. Если обе панели заняты — сворачиваем активную, и это
 * проговаривается: содержимое не пропало, оно ушло в полосу.
 */
export function restorePanel(panelId) {
    const panel = panels.find((p) => p.id === panelId);
    if (!panel || !panel.minimized) return;

    const visible = panels.filter((p) => !p.minimized);
    if (visible.length >= 2) {
        const victim = panels.find((p) => p.id === activeId && !p.minimized) || visible[visible.length - 1];
        victim.minimized = true;
        victim.el.hidden = true;
        emit({
            type: 'notice',
            message: `«${victim.meta.title || victim.key}» свёрнут — свободных панелей нет`
        });
    }

    panel.minimized = false;
    panel.el.hidden = false;
    activeId = panel.id;
    layout();
    emit({ type: 'change', reason: 'restore' });
}

/** «Главная»: сворачивает все панели, а не закрывает их. */
export function minimizeAll() {
    let touched = false;
    panels.forEach((p) => {
        if (!p.minimized) { p.minimized = true; p.el.hidden = true; touched = true; }
    });
    if (!touched) return;
    activeId = null;
    layout();
    emit({ type: 'change', reason: 'minimize-all' });
}

export function setActive(panelId) {
    const panel = panels.find((p) => p.id === panelId && !p.minimized);
    if (!panel || activeId === panelId) return;
    activeId = panelId;
    paintActive();
    emit({ type: 'activate', panelId });
}

/** Состояние для sessionStorage и для адреса. */
export function getState() {
    return {
        share,
        panels: panels.map((p) => ({ key: p.key, minimized: p.minimized, active: p.id === activeId }))
    };
}

/** Ключи ВИДИМЫХ панелей слева направо — то, что попадает в адрес. */
export function getVisibleKeys() {
    return panels.filter((p) => !p.minimized).map((p) => p.key);
}

export function getMinimized() {
    return panels.filter((p) => p.minimized).map((p) => ({ panelId: p.id, key: p.key, meta: p.meta }));
}

export function setShare(value) {
    share = clampShare(value);
    layout();
}

// ---------------------------------------------------------------- внутреннее

function createPanel(key, meta) {
    const panel = {
        id: `panel-${++seq}`,
        key,
        meta,
        minimized: false,
        el: null,
        bodyEl: null
    };

    const el = document.createElement('section');
    el.className = 'shell-panel';
    el.dataset.panelId = panel.id;
    el.dataset.sectionKey = key;

    const head = document.createElement('header');
    head.className = 'shell-panel__head';

    const icon = document.createElement('i');
    icon.className = `shell-panel__icon ${meta.icon || 'fas fa-window-maximize'}`;
    icon.setAttribute('aria-hidden', 'true');
    head.appendChild(icon);

    const titles = document.createElement('div');
    titles.className = 'shell-panel__titles';
    const title = document.createElement('div');
    title.className = 'shell-panel__title';
    title.textContent = meta.title || key;
    titles.appendChild(title);
    if (meta.subtitle) {
        const sub = document.createElement('div');
        sub.className = 'shell-panel__sub';
        sub.textContent = meta.subtitle;
        titles.appendChild(sub);
    }
    head.appendChild(titles);

    const tools = document.createElement('div');
    tools.className = 'shell-panel__tools';
    tools.appendChild(toolButton('split', 'fa-table-columns', 'Разделить экран'));
    tools.appendChild(toolButton('minimize', 'fa-window-minimize', 'Свернуть'));
    tools.appendChild(toolButton('close', 'fa-xmark', 'Закрыть'));
    head.appendChild(tools);

    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'shell-panel__body';
    body.dataset.role = 'panel-body';
    el.appendChild(body);

    // Клик в любое место панели делает её активной — иначе, чтобы открыть
    // раздел во вторую половину, пришлось бы целиться в шапку.
    el.addEventListener('mousedown', () => setActive(panel.id));

    head.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'close') closePanel(panel.id);
        else if (act === 'minimize') minimizePanel(panel.id);
        else if (act === 'split') emit({ type: 'split-request', panelId: panel.id });
    });

    panel.el = el;
    panel.bodyEl = body;
    panels.push(panel);
    workspace.appendChild(el);

    activeId = panel.id;
    layout();
    emit({ type: 'mount', panelId: panel.id, key, container: body });
    emit({ type: 'change', reason: 'open' });
    return panel;
}

function toolButton(act, icon, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ui-btn ui-btn--icon ui-btn--sm';
    btn.dataset.act = act;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const i = document.createElement('i');
    i.className = `fas ${icon}`;
    i.setAttribute('aria-hidden', 'true');
    btn.appendChild(i);
    return btn;
}

/** Пересборка раскладки: ширины, разделитель, состояние кнопок, активность. */
function layout() {
    const visible = panels.filter((p) => !p.minimized);

    // Разделитель существует, только когда панели две.
    const old = workspace.querySelector('.shell-splitter');
    if (old) old.remove();

    if (visible.length === 2) {
        const [left, right] = visible;
        left.el.style.flex = `1 1 ${share * 100}%`;
        right.el.style.flex = `1 1 ${(1 - share) * 100}%`;
        workspace.insertBefore(makeSplitter(), right.el);
    } else if (visible.length === 1) {
        visible[0].el.style.flex = '1 1 100%';
    }

    // «Разделить экран» имеет смысл только при одной открытой панели.
    panels.forEach((p) => {
        const btn = p.el.querySelector('[data-act="split"]');
        if (!btn) return;
        const enabled = visible.length === 1 && !p.minimized;
        btn.disabled = !enabled;
        btn.setAttribute('aria-disabled', String(!enabled));
    });

    if (activeId && !visible.some((p) => p.id === activeId)) {
        activeId = visible.length ? visible[0].id : null;
    }
    paintActive();
}

function paintActive() {
    panels.forEach((p) => p.el.classList.toggle('is-active', p.id === activeId && !p.minimized));
}

function makeSplitter() {
    const el = document.createElement('div');
    el.className = 'shell-splitter';
    el.dataset.role = 'splitter';
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.setAttribute('aria-label', 'Граница панелей');
    el.tabIndex = 0;
    el.addEventListener('mousedown', startDrag);
    // С клавиатуры — тоже: границу двигают стрелками по 2 % за нажатие.
    el.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') { setShare(share - 0.02); event.preventDefault(); }
        if (event.key === 'ArrowRight') { setShare(share + 0.02); event.preventDefault(); }
    });
    return el;
}

function startDrag(event) {
    event.preventDefault();
    const splitter = event.currentTarget;
    splitter.classList.add('is-dragging');
    workspace.classList.add('is-resizing');

    const move = (e) => {
        const box = workspace.getBoundingClientRect();
        if (!box.width) return;
        setShare((e.clientX - box.left) / box.width);
    };
    const stop = () => {
        splitter.classList.remove('is-dragging');
        workspace.classList.remove('is-resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', stop);
        emit({ type: 'change', reason: 'resize' });
    };

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', stop);
}

function clampShare(value) {
    if (!Number.isFinite(value)) return DEFAULT_SHARE;
    return Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, value));
}
