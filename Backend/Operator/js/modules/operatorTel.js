// --- operatorTel.js: телефонный пульт оператора -----------------------------
//
// Задача 1 реестра (К323), паспорт `d3afce57` ред. 3. Окно поверх страницы, не
// модальное: без затемнения, карточку не блокирует. Довод стоит рядом в коде
// дословно — «оператор во время возражения продолжает вводить данные»
// (`operator-light.css:996-997`); для телефона он сильнее: карточку заполняют
// ВО ВРЕМЯ разговора.
//
// ⚠⚠ ЧЕГО ЗДЕСЬ НЕТ СЕГОДНЯ, И ЭТО РЕШЕНИЕ, А НЕ НЕДОДЕЛКА.
// АТС не подключена: ключей Телфина нет, `INSERT INTO calls` в проекте ноль.
// Поэтому НЕ РИСУЮТСЯ ВОВСЕ — не серыми, не заглушками:
//   «Набрать», «Перевести», красная кнопка сброса — это команды станции;
//   точка состояния трубки — она приходит из `GET /extension/alive/`;
//   поле номера — по слову владельца 03.09.2026: без «Набрать» оно ничего не
//     делает, а поле, которое ничего не делает, обещает набор.
// Правило куратора (ответ И178): неактивная кнопка обещает то, чего нет.
//
// ⚠ ОСТАЁТСЯ ТО, ЧТО ОТ СТАНЦИИ НЕ ЗАВИСИТ: список состояний оператора.
// Решение владельца 119, вариант «б»: список и в пилюле наверху, и в пульте.
// Это НЕ второй список — тот же самый, вторым видом: строки рисует
// `operatorWorkState`, сюда он их только кладёт (`setMirror`). Два места,
// показывающие разное, — та самая поломка, ради которой источник один.

import { makeFloating } from '/ui/float.js';
import { icon } from '/ui/icons.js';
import { readFloatCollapsed, writeFloatCollapsed } from '/viewPrefs.js';

// Имя ячейки памяти места и свёрнутости. Одно на окно.
const KEY = 'operatorTel';

// Размер из паспорта. Здесь он нужен только для места по умолчанию — сам
// размер задан правилом `.op-tel`, и второго источника числа мы не заводим:
// это лишь то, от чего отсчитывается угол.
const W = 280;
const H = 350;

// Место по умолчанию — там же, где стоит свёрнутая кнопка: окно как будто
// вырастает из неё. Числа те же, что у `.op-fab--tel` (right 94, bottom 24).
const GAP_RIGHT = 94;
const GAP_BOTTOM = 24;

/**
 * @param {Object} deps
 * @param {Object} deps.workState панель состояний — источник списка
 */
export function createTelPult({ workState }) {
    let win = null;
    let fab = null;
    let floating = null;

    function defaultPlace() {
        return {
            left: window.innerWidth - W - GAP_RIGHT,
            top: window.innerHeight - H - GAP_BOTTOM
        };
    }

    // ⚠ СВЁРНУТОЕ ОКНО СНИМАЕТСЯ ИЗ РАЗМЕТКИ, А НЕ ПРЯЧЕТСЯ ПОД КНОПКОЙ.
    // Спрятанное продолжало бы ловить фокус Tab и читаться с экрана — то же
    // правило, что у складки: нет содержимого, нет и узла.
    function open() {
        if (win) return;
        removeFab();

        win = document.createElement('div');
        win.className = 'ui-float op-tel';
        win.id = 'opTelWindow';
        win.innerHTML = `
            <div class="ui-float__head">
                <span class="ui-float__title">Телефон</span>
                <button type="button" class="ui-btn ui-btn--icon" data-role="tel-min" aria-label="Свернуть">
                    ${icon('min', 'sm')}
                </button>
            </div>
            <div class="ui-float__body" data-role="tel-body"></div>
        `;
        document.body.appendChild(win);

        win.querySelector('[data-role="tel-min"]').addEventListener('click', collapse);

        floating = makeFloating(win, { key: KEY, place: defaultPlace() });
        // Список состояний кладёт сюда сам `operatorWorkState` — своих строк
        // пульт не рисует.
        workState.setMirror(win.querySelector('[data-role="tel-body"]'));
        writeFloatCollapsed(KEY, false);
    }

    function collapse() {
        if (!win) return;
        workState.setMirror(null);
        if (floating) { floating.destroy(); floating = null; }
        win.remove();
        win = null;
        showFab();
        writeFloatCollapsed(KEY, true);
    }

    function showFab() {
        if (fab) return;
        fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'op-fab op-fab--tel';
        fab.id = 'opTelBtn';
        fab.setAttribute('aria-label', 'Телефон');
        fab.innerHTML = icon('phone', 'sm');
        fab.addEventListener('click', open);
        document.body.appendChild(fab);
    }

    function removeFab() {
        if (!fab) return;
        fab.remove();
        fab = null;
    }

    // Первый заход — окно развёрнуто (паспорт, состояние 1). Дальше — как
    // оставили: свёрнутость помнится вместе с местом.
    if (readFloatCollapsed(KEY)) showFab();
    else open();

    return {
        open,
        collapse,
        destroy() {
            workState.setMirror(null);
            if (floating) { floating.destroy(); floating = null; }
            if (win) { win.remove(); win = null; }
            removeFab();
        }
    };
}
