// --- ui/float.js: поведение перемещаемого окна ------------------------------
//
// Узел слоя `.ui-float` (паспорт `d3afce57` ред. 3, К323). Вид — в `float.css`,
// здесь ПОВЕДЕНИЕ: перетаскивание за шапку, границы, память места. Та же
// граница, что у окна слоя: вид в `modal.css`, ловушка фокуса и Esc в
// `modal.js`.
//
// ⚠⚠ ОКНО ДВИГАЕТСЯ `left`/`top`, А НЕ `transform`, И ЭТО НЕСУЩЕЕ РЕШЕНИЕ, А НЕ
// вкус. `position: fixed` внутри узла, у которого есть `transform`, считается
// не от окна браузера, а ОТ ЭТОГО УЗЛА. Поповер слоя — `fixed`
// (`popover.css:14`), и решение владельца 119 кладёт выпадающий список
// состояний ВНУТРЬ пульта. Поставь окну `transform: translate(...)` — и
// координаты, которые `popover.js` посчитал от окна браузера, разъедутся ровно
// на смещение пульта. Ловушку назвал куратор в наряде; проверка на неё стоит
// отдельной поломкой.
//
// ⚠ ГРАНИЦЫ ОБЯЗАТЕЛЬНЫ, А НЕ ЖЕЛАТЕЛЬНЫ. Окно целиком остаётся в видимой
// области: уехавшее за край вернуть НЕЧЕМ — ручка снаружи. По той же причине
// место пересчитывается при каждом изменении размера окна браузера: сузили
// экран — окно подтягивается к ближайшему допустимому месту само.
//
// ⚠ ХРАНИЛИЩЕ НЕДОСТУПНО — ОКНО РАБОТАЕТ. Место живёт в `viewPrefs`
// (`localStorage`), и оно может быть переполнено или запрещено настройками
// браузера. Настройка вида не то, ради чего роняют экран: не прочиталось —
// окно встаёт на место по умолчанию.

import { readFloatPlace, writeFloatPlace } from '/viewPrefs.js';

// Отступ окна от края видимой области. Ноль сделал бы «в углу» единственным
// допустимым местом у края и склеивал бы окно с рамкой браузера.
const EDGE = 8;

/**
 * Сделать узел перемещаемым.
 *
 * @param {HTMLElement} el    узел с классом `ui-float`
 * @param {Object} opts
 * @param {string} opts.key   имя ячейки памяти места; без него место не помнится
 * @param {HTMLElement} [opts.handle] ручка; по умолчанию `.ui-float__head`
 * @param {{left:number, top:number}} [opts.place] место по умолчанию
 * @returns {{ moveTo: Function, destroy: Function }}
 */
export function makeFloating(el, opts = {}) {
    const handle = opts.handle || el.querySelector('.ui-float__head');
    if (!handle) throw new Error('ui-float: ручки нет — окну не за что взяться');

    const key = opts.key || '';
    let pointerId = null;
    let grabX = 0;
    let grabY = 0;

    // Место, допустимое ПРЯМО СЕЙЧАС. Считается от настоящего размера окна, а
    // не от заявленного: окно могло вырасти содержимым, и старая граница
    // выпустила бы его за край.
    function clamp(left, top) {
        const box = el.getBoundingClientRect();
        const maxLeft = Math.max(EDGE, window.innerWidth - box.width - EDGE);
        const maxTop = Math.max(EDGE, window.innerHeight - box.height - EDGE);
        return {
            left: Math.min(Math.max(left, EDGE), maxLeft),
            top: Math.min(Math.max(top, EDGE), maxTop)
        };
    }

    function moveTo(left, top, remember) {
        const p = clamp(left, top);
        el.style.left = `${p.left}px`;
        el.style.top = `${p.top}px`;
        // ⚠ `right`/`bottom` снимаются: место по умолчанию раздел может задать
        // ими, и оставленное `right` спорило бы с `left` при первом же сдвиге.
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        if (remember && key) writeFloatPlace(key, p);
        return p;
    }

    function onDown(event) {
        // ⚠ КНОПКА В ШАПКЕ РУЧКОЙ НЕ ЯВЛЯЕТСЯ: нажатие на «Свернуть» не
        // начинает перетаскивания. Иначе закрыть окно можно было бы только
        // безупречно неподвижным щелчком.
        if (event.button !== 0) return;
        if (event.target.closest('button, a, input, select, textarea')) return;

        const box = el.getBoundingClientRect();
        grabX = event.clientX - box.left;
        grabY = event.clientY - box.top;
        pointerId = event.pointerId;
        handle.setPointerCapture(pointerId);
        el.classList.add('ui-float--moving');
        event.preventDefault();
    }

    function onMove(event) {
        if (pointerId === null || event.pointerId !== pointerId) return;
        moveTo(event.clientX - grabX, event.clientY - grabY, false);
    }

    function onUp(event) {
        if (pointerId === null || event.pointerId !== pointerId) return;
        try { handle.releasePointerCapture(pointerId); } catch (err) { /* уже отпущено */ }
        pointerId = null;
        el.classList.remove('ui-float--moving');
        // Запоминается ОДИН раз в конце, а не на каждом движении: иначе на
        // каждое дрожание мыши приходилась бы запись в хранилище.
        const box = el.getBoundingClientRect();
        moveTo(box.left, box.top, true);
    }

    // Экран сузился — подтянуть к ближайшему допустимому месту. Без этого
    // окно, поставленное на широком экране, уходит за край на узком.
    function onResize() {
        const box = el.getBoundingClientRect();
        moveTo(box.left, box.top, false);
    }

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', onResize);

    // Начальное место: запомненное, иначе заданное разделом, иначе левый верх.
    const saved = key ? readFloatPlace(key) : null;
    const start = saved || opts.place || null;
    if (start) moveTo(start.left, start.top, false);
    else onResize();

    return {
        moveTo: (left, top) => moveTo(left, top, true),
        destroy() {
            handle.removeEventListener('pointerdown', onDown);
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            window.removeEventListener('resize', onResize);
        }
    };
}
