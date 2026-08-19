// --- ui/modal.js: модалки слоя элементов ---
//
// Заменяет пять копий модалки подтверждения, разбросанных по разделам
// (mainConfirm.js, leadsConfirm.js, cpaConfirm.js, sourcesConfirm.js,
// scriptsAdminConfirm.js, confirmModal.js). Каждая из них ищет свои элементы
// по глобальным id — в одном документе с двумя открытыми панелями это молча
// ломается: getElementById вернёт чужую модалку.
//
// Здесь глобальных id нет вообще: окно создаётся при вызове и удаляется при
// закрытии.
//
// ДВА ВИДА (правило дизайн-сессии):
//   openModal({ scope })  — накрывает свою панель;
//   confirmDanger(...)    — необратимое действие, накрывает весь экран.
//
// БЕЗОПАСНОСТЬ: пользовательский текст ставится только через textContent.
// innerHTML в этом модуле не используется ни для одной строки, приходящей
// снаружи, — на прошлой задаче незаэкранированное имя сотрудника в innerHTML
// уже становилось находкой приёмки.

const OPEN_STACK = [];

/**
 * Открывает модальное окно.
 *
 * @param {Object}      opts
 * @param {string}      opts.title            заголовок
 * @param {Node|string} [opts.body]           содержимое; строка вставляется текстом
 * @param {Array}       [opts.actions]        [{ label, variant, value, autofocus, onClick }]
 * @param {HTMLElement} [opts.scope]          панель, которую надо накрыть
 * @param {boolean}     [opts.screen]         накрыть весь экран (необратимое действие)
 * @param {string}      [opts.size]           'narrow' | 'wide'
 * @param {boolean}     [opts.dismissable]    закрытие по Esc и клику вне (по умолчанию да)
 * @returns {{ el: HTMLElement, close: Function, result: Promise }}
 */
export function openModal(opts = {}) {
    const {
        title = '',
        body = null,
        actions = [],
        scope = null,
        screen = false,
        size = '',
        dismissable = true
    } = opts;

    const host = screen || !scope ? document.body : scope;

    const overlay = document.createElement('div');
    overlay.className = screen || !scope ? 'ui-modal ui-modal--screen' : 'ui-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const box = document.createElement('div');
    box.className = 'ui-modal__box' + (size ? ` ui-modal__box--${size}` : '');

    // --- шапка ---
    const head = document.createElement('div');
    head.className = 'ui-modal__head';

    const heading = document.createElement('h2');
    heading.className = 'ui-modal__title';
    heading.textContent = title;
    head.appendChild(heading);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ui-modal__close';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    closeBtn.textContent = '×';
    head.appendChild(closeBtn);

    box.appendChild(head);

    // --- тело ---
    const bodyBox = document.createElement('div');
    bodyBox.className = 'ui-modal__body';
    if (body instanceof Node) {
        bodyBox.appendChild(body);
    } else if (typeof body === 'string' && body !== '') {
        const p = document.createElement('p');
        p.textContent = body;
        bodyBox.appendChild(p);
    }
    box.appendChild(bodyBox);

    // --- действия ---
    let resolveResult;
    const result = new Promise((resolve) => { resolveResult = resolve; });

    let actionsBox = null;
    if (actions.length) {
        actionsBox = document.createElement('div');
        actionsBox.className = 'ui-modal__actions';
        actions.forEach((action) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ui-btn' + (action.variant ? ` ui-btn--${action.variant}` : '');
            btn.textContent = action.label || '';
            btn.addEventListener('click', async () => {
                if (typeof action.onClick === 'function') {
                    // Кнопка блокируется на время работы обработчика: без этого
                    // двойной клик отправляет действие дважды.
                    btn.disabled = true;
                    btn.classList.add('is-busy');
                    try {
                        const outcome = await action.onClick();
                        if (outcome === false) {
                            btn.disabled = false;
                            btn.classList.remove('is-busy');
                            return;
                        }
                    } catch (err) {
                        btn.disabled = false;
                        btn.classList.remove('is-busy');
                        throw err;
                    }
                }
                close(action.value !== undefined ? action.value : true);
            });
            if (action.autofocus) btn.dataset.autofocus = 'true';
            actionsBox.appendChild(btn);
        });
        box.appendChild(actionsBox);
    }

    overlay.appendChild(box);
    host.appendChild(overlay);

    // Фокус возвращается туда, откуда окно открыли, — иначе после закрытия он
    // уезжает в начало документа.
    const returnFocusTo = document.activeElement;

    const entry = { overlay, close: (value) => close(value) };
    OPEN_STACK.push(entry);

    function onKeyDown(event) {
        if (event.key === 'Escape' && dismissable) {
            // Закрывается только верхнее окно стопки.
            if (OPEN_STACK[OPEN_STACK.length - 1] === entry) {
                event.stopPropagation();
                close(false);
            }
            return;
        }
        if (event.key === 'Tab') trapFocus(event, box);
    }

    function onOverlayClick(event) {
        if (event.target === overlay && dismissable) close(false);
    }

    let closed = false;
    function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeyDown, true);
        overlay.removeEventListener('mousedown', onOverlayClick);
        overlay.remove();
        const at = OPEN_STACK.indexOf(entry);
        if (at !== -1) OPEN_STACK.splice(at, 1);
        if (returnFocusTo && typeof returnFocusTo.focus === 'function' &&
            document.contains(returnFocusTo)) {
            returnFocusTo.focus();
        }
        resolveResult(value === undefined ? false : value);
    }

    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('mousedown', onOverlayClick);
    closeBtn.addEventListener('click', () => close(false));

    focusFirst(box);

    return { el: overlay, box, body: bodyBox, close, result };
}

/**
 * Подтверждение обычного действия — накрывает свою панель.
 *
 * Текст обязан называть объект: «Удалить сотрудника „Белов Д. С.“?», а не
 * «Вы уверены?». Это то же правило, что и для тостов.
 */
export function confirm(opts = {}) {
    const {
        title = 'Подтвердите действие',
        message = '',
        confirmLabel = 'Да',
        cancelLabel = 'Отмена',
        scope = null,
        screen = false,
        danger = false
    } = opts;

    return openModal({
        title,
        body: message,
        scope,
        screen,
        size: 'narrow',
        actions: [
            { label: cancelLabel, variant: 'ghost', value: false },
            {
                label: confirmLabel,
                variant: danger ? 'danger' : '',
                value: true,
                autofocus: !danger
            }
        ]
    }).result;
}

/**
 * Подтверждение НЕОБРАТИМОГО действия — накрывает весь экран, включая соседнюю
 * панель. Отдельная функция, а не флаг, чтобы это решение принималось на месте
 * вызова осознанно.
 */
export function confirmDanger(opts = {}) {
    return confirm({ ...opts, screen: true, danger: true, confirmLabel: opts.confirmLabel || 'Удалить' });
}

/** Есть ли открытые окна — оболочке нужно, чтобы не закрывать панель под ними. */
export function hasOpenModal() {
    return OPEN_STACK.length > 0;
}

function focusFirst(box) {
    const marked = box.querySelector('[data-autofocus="true"]');
    if (marked) { marked.focus(); return; }
    const first = box.querySelector(FOCUSABLE);
    if (first) first.focus();
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), ' +
                  'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Фокус не уходит за пределы окна: иначе Tab уводит на элементы панели под
// оверлеем, которые визуально заблокированы.
function trapFocus(event, box) {
    const items = Array.from(box.querySelectorAll(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}
