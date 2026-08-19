// --- ui/toast.js: тосты слоя элементов ---
//
// Заменяет семь копий одного и того же модуля (mainToast.js, leadsToast.js,
// cpaToast.js, sourcesToast.js, scriptsAdminToast.js, toast.js у сотрудников —
// операторский остаётся, страница оператора в задачу не входит).
//
// ТРИ ОТЛИЧИЯ ОТ СТАРЫХ КОПИЙ, все существенные:
//
// 1. Текст ставится через textContent. Старые копии собирали тост строкой и
//    клали её в innerHTML — любое имя с угловой скобкой или кавычкой попадало
//    в разметку как разметка. На прошлой задаче это уже было находкой приёмки.
// 2. Срок жизни 3,2 с вместо 4 с — требование дизайн-сессии. Значение живёт в
//    токене --ui-toast-life, а не числом здесь.
// 3. Контейнер не привязан к разметке страницы. Старые копии искали
//    #toastContainer и молча ничего не делали, если его не было; здесь
//    контейнер создаётся при первом вызове.

import { iconNode } from './icons.js';

const ICONS = {
    info: 'info',
    success: 'check-circle',
    error: 'warn'
};

let container = null;

/**
 * Показывает тост.
 *
 * Текст обязан называть объект: «Белов Д. С.: 15 августа — выходной», а не
 * «Сохранено». Обезличенный тост не даёт понять, что именно произошло, когда
 * открыты две панели.
 *
 * @param {string} message         текст
 * @param {string} [type]          'info' | 'success' | 'error'
 * @param {Object} [opts]
 * @param {number} [opts.life]     срок жизни в мс; 0 — не гасить самому
 * @returns {{ close: Function }}
 */
export function showToast(message, type = 'info', opts = {}) {
    const kind = ICONS[type] ? type : 'info';
    const box = ensureContainer();

    const toast = document.createElement('div');
    toast.className = `ui-toast ui-toast--${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    toast.appendChild(iconNode(ICONS[kind], 'sm', 'ui-toast__icon'));

    const text = document.createElement('span');
    text.className = 'ui-toast__text';
    text.textContent = message == null ? '' : String(message);
    toast.appendChild(text);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ui-toast__close';
    closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
    closeBtn.appendChild(iconNode('close', 'sm'));
    toast.appendChild(closeBtn);

    box.appendChild(toast);

    const life = opts.life === undefined ? readLife() : opts.life;
    let timer = life > 0 ? setTimeout(close, life) : null;

    // Пока курсор на тосте, отсчёт стоит: длинное сообщение успевают дочитать.
    toast.addEventListener('mouseenter', () => {
        if (timer) { clearTimeout(timer); timer = null; }
    });
    toast.addEventListener('mouseleave', () => {
        if (!timer && life > 0) timer = setTimeout(close, life);
    });

    closeBtn.addEventListener('click', close);

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        toast.classList.add('is-leaving');
        // Узел снимается по окончании перехода, а не по второму таймеру: иначе
        // при вкладке в фоне (переходы не идут) тосты копятся на экране.
        const drop = () => toast.remove();
        toast.addEventListener('transitionend', drop, { once: true });
        setTimeout(drop, 600);
    }

    return { close };
}

/** Снимает все тосты разом — оболочке нужно при смене раздела в панели. */
export function clearToasts() {
    if (container) container.replaceChildren();
}

function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.querySelector('.ui-toasts');
    if (!container) {
        container = document.createElement('div');
        container.className = 'ui-toasts';
        document.body.appendChild(container);
    }
    return container;
}

// Срок жизни берётся из токена, чтобы не разъехаться с дизайном. Токен задан
// в миллисекундах ("3200ms"); если его почему-то нет — 3,2 с по умолчанию.
function readLife() {
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--ui-toast-life').trim();
    if (raw.endsWith('ms')) {
        const value = parseFloat(raw);
        if (!Number.isNaN(value)) return value;
    }
    if (raw.endsWith('s')) {
        const value = parseFloat(raw);
        if (!Number.isNaN(value)) return value * 1000;
    }
    return 3200;
}
