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

import { iconNode } from './icons.js';

const OPEN_STACK = [];

/**
 * Открывает модальное окно.
 *
 * @param {Object}      opts
 * @param {string}      opts.title            заголовок
 * @param {string}      [opts.sub]            подпись под заголовком
 * @param {Node|string} [opts.body]           содержимое; строка вставляется текстом
 * @param {Node}        [opts.toolbar]        полоса между шапкой и телом, НЕ прокручивается
 * @param {Array}       [opts.actions]        кнопки подвала, см. ниже
 * @param {boolean}     [opts.spread]         развести подвал: side:'start' слева, прочие справа
 * @param {HTMLElement} [opts.scope]          панель, которую надо накрыть
 * @param {boolean}     [opts.screen]         накрыть весь экран (необратимое действие)
 * @param {string}      [opts.size]           'narrow' | 'wide' | 'xwide'
 * @param {boolean}     [opts.dismissable]    закрытие по Esc и клику вне (по умолчанию да)
 * @param {boolean}     [opts.scrimClose]     закрытие ЩЕЛЧКОМ ПО ЗАТЕМНЕНИЮ (по умолчанию да)
 * @param {Function}    [opts.confirmClose]   спросить перед закрытием; см. ниже
 * @returns {{ el, box, body, close, requestClose, result }}
 *
 * КНОПКА ПОДВАЛА: { label, variant, value, autofocus, role, side, onClick }
 *   role     — data-role кнопки. Раздел находит её у себя и управляет ею:
 *              прячет («Далее» на втором шаге), блокирует («Заполнить» без
 *              времени смены), переименовывает («Добавить» → «Сохранить
 *              изменения»). Без этого окно-форму на слой не перевести: у
 *              разметочного окна такие кнопки были своими.
 *   icon     — имя значка из набора; встаёт ПЕРЕД подписью.
 *   side     — 'start' ставит кнопку в ЛЕВУЮ часть разведённого подвала.
 *   onClick  — вернуть false, чтобы окно осталось открытым (ошибка проверки).
 *
 * ТРИ ДВЕРИ ИЗ ОКНА. Esc, щелчок по затемнению и крестик закрывают окно
 * одинаково — и все три проходят через confirmClose, если он задан. Пока
 * дверей было три, а проверка стояла на одной, окно с набранными данными
 * выпускало молча именно через ту, которую нажимают не глядя (К112).
 * confirmClose возвращает true (закрыть) или false (остаться); пока висит
 * его вопрос, повторное Esc второго вопроса не задаёт.
 *
 * Дверь можно закрыть на ключ поодиночке: scrimClose: false оставляет Esc и
 * крестик, но делает щелчок по затемнению безответным. Это не отмена правила
 * про три двери, а его продолжение — вопрос «точно уйти?» имеет смысл там, где
 * уход намеренный, а промах мимо окна намеренным не бывает.
 */
export function openModal(opts = {}) {
    const {
        title = '',
        sub = '',
        body = null,
        toolbar = null,
        actions = [],
        spread = false,
        scope = null,
        screen = false,
        size = '',
        dismissable = true,
        // ТРЕТЬЯ ДВЕРЬ ОТДЕЛЬНО ОТ ДВУХ ОСТАЛЬНЫХ. Esc и крестик — движения
        // намеренные, щелчок мимо окна — чаще промах. У длинной формы (окно
        // оффера «CPA-сетей» — тридцать полей) цена промаха равна всему вводу,
        // поэтому её затемнение не закрывает вовсе; Esc при этом остаётся и
        // спрашивает. Одним флагом dismissable это не выражается: он гасит и
        // клавиатуру тоже.
        scrimClose = true,
        confirmClose = null
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

    // Заголовок и подпись — одной колонкой: подпись объясняет заголовок и
    // стоит под ним, а не рядом. Класс подписи в слое был давно, но окно,
    // собранное вызовом, его не строило — и раздел с подписью в паспорте не мог
    // переехать на окно слоя, не потеряв её.
    const heading = document.createElement('h2');
    heading.className = 'ui-modal__title';
    heading.textContent = title;

    if (sub) {
        const titles = document.createElement('div');
        const subEl = document.createElement('p');
        subEl.className = 'ui-modal__sub';
        subEl.textContent = sub;
        titles.append(heading, subEl);
        head.appendChild(titles);
    } else {
        head.appendChild(heading);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ui-modal__close';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    // Значок, а не символ шрифта: символ не слушается ступеней значков и
     // живёт в метрике шрифта, из-за чего крестик окна слоя отличался от
     // крестика разметочных окон (родня К40).
    closeBtn.appendChild(iconNode('close', 'sm'));
    head.appendChild(closeBtn);

    box.appendChild(head);

    // --- полоса под шапкой ---
    //
    // Стоит МЕЖДУ шапкой и телом и прокрутке тела не подчиняется. Без неё
    // карточку лида нельзя было собрать вызовом: её вкладки («Данные лида» /
    // «Офферы N») обязаны оставаться на месте, пока тело едет под ними, — а
    // тело у окна слоя прокручивается само. Пятое такое дополнение слоя после
    // sub, role, spread и confirmClose, и по той же причине: окно раздела не
    // переезжает, пока слой не умеет того, что окно обещает.
    if (toolbar instanceof Node) box.appendChild(toolbar);

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
        actionsBox.className = 'ui-modal__actions' + (spread ? ' ui-modal__actions--spread' : '');
        // Разведённый подвал: «Сбросить» у левого края, «Отмена» и действие —
        // парой у правого. Группа нужна именно как узел: без неё
        // space-between растащил бы все три кнопки по углам.
        const group = spread ? document.createElement('div') : null;
        if (group) group.className = 'ui-modal__actions-group';
        actions.forEach((action) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ui-btn' + (action.variant ? ` ui-btn--${action.variant}` : '');
            btn.textContent = action.label || '';
            // ЗНАЧОК ПЕРЕД ПОДПИСЬЮ — по требованию паспорта Р7: «Вывести»
            // несёт знак archive, «Удалить насовсем» — trash. Своего правила
            // раскладки это не приносит: .ui-btn уже умеет знак рядом с
            // текстом, а .ui-modal__actions .ui-btn задаёт им размер. Опция
            // добавлена, а не подставлена разделом через innerHTML: подпись
            // приходит из данных, и собирать её строкой значит открыть дорогу
            // разметке в тексте.
            if (action.icon) btn.prepend(iconNode(action.icon, 'sm'));
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
            if (action.role) btn.dataset.role = action.role;
            const host = group && action.side !== 'start' ? group : actionsBox;
            host.appendChild(btn);
        });
        if (group) actionsBox.appendChild(group);
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
                requestClose(false);
            }
            return;
        }
        if (event.key === 'Tab') trapFocus(event, box);
    }

    function onOverlayClick(event) {
        if (event.target === overlay && dismissable && scrimClose) requestClose(false);
    }

    // Закрытие ПО ПРОСЬБЕ ЧЕЛОВЕКА — через вопрос, если он задан. Программное
    // закрытие (сохранили и уходим) идёт мимо: спрашивать «точно закрыть?»
    // после успешного сохранения незачем.
    let asking = false;
    async function requestClose(value) {
        if (closed || asking) return;
        if (typeof confirmClose === 'function') {
            asking = true;
            let ok = false;
            try {
                ok = await confirmClose();
            } finally {
                asking = false;
            }
            if (!ok) return;
        }
        close(value);
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
    closeBtn.addEventListener('click', () => requestClose(false));

    focusFirst(box);

    return { el: overlay, box, body: bodyBox, close, requestClose, result };
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
        // Подпись под заголовком: ОБЪЕКТ действия. Вопрос стоит в заголовке,
        // последствие в тексте, а кого именно это касается — здесь. У
        // openModal она была с самого начала, а до confirm() не доходила: окно
        // подтверждения могло назвать объект только внутри текста, где он
        // теряется (паспорт Р1Б, окно перевыпуска ключа).
        sub = '',
        message = '',
        confirmLabel = 'Да',
        cancelLabel = 'Отмена',
        scope = null,
        screen = false,
        danger = false
    } = opts;

    return openModal({
        title,
        sub,
        body: message,
        scope,
        screen,
        size: 'narrow',
        // ФОКУС — НА ОТМЕНЯЮЩЕЙ КНОПКЕ, и у обоих видов подтверждения (К161).
        // Раньше он стоял на подтверждающей, когда действие обратимо, — и
        // <kbd>Enter</kbd>, нажатый вслепую сразу после открытия окна,
        // срабатывал действием, а не отменой. У необратимого действия autofocus
        // не стоял вовсе, и фокус доставался крестику: до «Отмены» всё равно
        // надо было дойти. Правило одно на оба: окно, которое спрашивает,
        // открывается на ответе «нет».
        actions: [
            { label: cancelLabel, variant: 'ghost', value: false, autofocus: true },
            {
                label: confirmLabel,
                variant: danger ? 'danger' : '',
                value: true
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
