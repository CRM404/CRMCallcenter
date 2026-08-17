// --- ui/popover.js: поповер слоя элементов ---
//
// Что обязан уметь поповер (бриф, п.4 и 5.4):
//   - привязка к элементу;
//   - переворот вверх у нижнего края;
//   - прижатие к краю, чтобы не уехать за него;
//   - НЕ выходить за границы своей панели — панелей на экране может быть две,
//     и меню, вылезшее в соседнюю, читается как чужое;
//   - второй шаг ВНУТРИ того же поповера.
//
// Границей по умолчанию берётся ближайшая панель (.shell-panel). Пока
// оболочки нет, границей становится окно — каталог элементов работает без
// панелей, и это не должно быть отдельным случаем в коде разделов.
//
// Слушатели снимаются методом destroy(): раздел обязан уметь размонтироваться
// (контракт mount/unmount), а поповер, переживший свой раздел, — это чужой
// обработчик на document.

const GAP = 6;   // отступ от элемента-якоря
const EDGE = 8;  // минимальный зазор до края границы

function boundsOf(boundary) {
    if (boundary && typeof boundary.getBoundingClientRect === 'function') {
        const rect = boundary.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

function firstFocusable(root) {
    return root.querySelector(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
}

/**
 * @param {HTMLElement} el       корневой элемент поповера (.ui-popover, hidden)
 * @param {Object}      [options]
 * @param {HTMLElement|Function} [options.boundary] граница; по умолчанию —
 *        ближайшая к якорю панель, иначе окно
 * @param {Function}    [options.onClose] вызывается после закрытия
 * @returns {{open: Function, close: Function, isOpen: Function, step: Function,
 *            currentStep: Function, reposition: Function, destroy: Function,
 *            el: HTMLElement, anchor: Function}}
 */
export function createPopover(el, options = {}) {
    if (!el) throw new Error('createPopover: не передан элемент поповера');

    const steps = Array.from(el.querySelectorAll('[data-ui-pop-step]'));
    const firstStep = steps.length ? steps[0].dataset.uiPopStep : null;
    let anchor = null;
    let stepName = firstStep;
    let destroyed = false;

    function resolveBoundary() {
        const given = typeof options.boundary === 'function' ? options.boundary(anchor) : options.boundary;
        if (given) return given;
        return anchor ? anchor.closest('.shell-panel') : null;
    }

    function place() {
        if (el.hidden || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const limit = boundsOf(resolveBoundary());

        // По горизонтали — по центру якоря, но не за краем границы. Если
        // поповер шире самой границы, прижимаем к левому краю: уехавший вправо
        // хуже, чем срезанный справа.
        const maxLeft = Math.max(limit.left + EDGE, limit.right - box.width - EDGE);
        const left = Math.min(Math.max(limit.left + EDGE, rect.left + rect.width / 2 - box.width / 2), maxLeft);

        // По вертикали — под якорем, а у нижнего края переворачиваем вверх.
        let top = rect.bottom + GAP;
        if (top + box.height > limit.bottom - EDGE) {
            const above = rect.top - box.height - GAP;
            top = above >= limit.top + EDGE ? above : Math.max(limit.top + EDGE, limit.bottom - box.height - EDGE);
        }

        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
    }

    function showStep(name, { focus = false } = {}) {
        if (!steps.length) return;
        stepName = name;
        steps.forEach((node) => {
            node.hidden = node.dataset.uiPopStep !== name;
        });
        if (focus) {
            const target = steps.find((node) => node.dataset.uiPopStep === name);
            const focusable = target && firstFocusable(target);
            if (focusable) focusable.focus();
        }
        place();
    }

    function open(nextAnchor) {
        if (destroyed || !nextAnchor) return;
        anchor = nextAnchor;
        if (steps.length) showStep(firstStep);
        el.hidden = false;
        if (anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'true');
        // Позиция считается после показа: у скрытого элемента нет размеров.
        place();
    }

    function close() {
        if (el.hidden) return;
        el.hidden = true;
        if (anchor && anchor.hasAttribute('aria-expanded')) anchor.setAttribute('aria-expanded', 'false');
        anchor = null;
        if (steps.length) showStep(firstStep);
        if (typeof options.onClose === 'function') options.onClose();
    }

    function onDocumentMouseDown(event) {
        if (el.hidden) return;
        if (el.contains(event.target)) return;
        // Клик по тому же якорю обрабатывает вызывающий код (открыть/закрыть),
        // иначе поповер закроется здесь и тут же откроется обработчиком якоря.
        if (anchor && anchor.contains(event.target)) return;
        close();
    }

    function onKeyDown(event) {
        if (el.hidden || event.key !== 'Escape') return;
        // Esc на втором шаге сначала возвращает на первый — иначе одно нажатие
        // отменяет и шаг, и всё меню, и человек теряет место.
        if (steps.length && stepName !== firstStep) {
            showStep(firstStep, { focus: false });
            return;
        }
        close();
    }

    // Прокрутка и изменение размера двигают якорь. Поповер едет за ним и
    // закрывается, только когда якорь ушёл за границу — держать его больше не
    // за что.
    //
    // Закрывать на любую прокрутку (как это делает меню дня в графике) нельзя:
    // браузер докручивает страницу к элементу ПЕРЕД кликом, а событие scroll
    // приходит уже после обработчика — поповер закрывался сам собой сразу
    // после открытия. Поймано автопроверкой, воспроизводится и руками.
    function onViewportChange() {
        if (el.hidden || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        const limit = boundsOf(resolveBoundary());
        const gone = rect.bottom < limit.top || rect.top > limit.bottom
            || rect.right < limit.left || rect.left > limit.right;
        if (gone) { close(); return; }
        place();
    }

    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);

    return {
        el,
        open,
        close,
        isOpen: () => !el.hidden,
        anchor: () => anchor,
        step: (name) => showStep(name, { focus: true }),
        currentStep: () => stepName,
        reposition: place,
        destroy() {
            destroyed = true;
            close();
            document.removeEventListener('mousedown', onDocumentMouseDown, true);
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onViewportChange);
            window.removeEventListener('scroll', onViewportChange, true);
        }
    };
}
