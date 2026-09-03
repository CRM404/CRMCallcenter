// --- operatorTel.js: телефонный пульт оператора -----------------------------
//
// Задача 1 реестра (К323), паспорт `d3afce57` ред. 3. Окно поверх страницы, не
// модальное: без затемнения, карточку не блокирует. Довод стоит рядом в коде
// дословно — «оператор во время возражения продолжает вводить данные»
// (`operator-light.css:996-997`); для телефона он сильнее: карточку заполняют
// ВО ВРЕМЯ разговора.
//
// ⚠⚠ ЧТО ИЗМЕНИЛОСЬ ВТОРЫМ ЗАХОДОМ — РЕШЕНИЕ ВЛАДЕЛЬЦА 134.
// Первой сборкой я снял поле номера и «Набрать», сославшись на слово
// владельца. Слово было сказано, но в реестр решений не попало — а 134
// подтвердило состав из решения 119: «поле номера с маской +7, ниже кнопка
// „Набрать“ — неактивна, пока номер не введён». Оба органа возвращены.
// Правило куратора И178 («неактивная кнопка обещает то, чего нет») к ним НЕ
// применяется: владелец рассмотрел этот случай и решил иначе.
//
// ⚠⚠ ЧЕГО НЕТ И СЕГОДНЯ, И ЭТО РЕШЕНИЕ, А НЕ НЕДОДЕЛКА. Граница названа в
// самом 134: «Перевести», красная кнопка сброса и точка состояния трубки —
// про состояние «идёт звонок», которое без АТС не наступает вовсе; они не
// рисуются никак, даже серыми. «Набрать» — про «звонка нет», которое
// наступает всегда, поэтому оно здесь.
//
// ⚠ «НАБРАТЬ» СЕГОДНЯ НЕАКТИВНА ВСЕГДА, И ПРИЧИНА СТОИТ В ОКНЕ СТРОКОЙ, а не
// всплывает подсказкой на выключенной кнопке (макет `6cd2d954`, состояние
// «трубки нет»). Ключей Телфина нет, `INSERT INTO calls` в проекте ноль.
// Целевое правило — состояние 8 паспорта: «неактивна, если номер пуст ИЛИ
// трубка не подключена». Сегодня верна вторая половина всегда, и ветки под
// первую здесь НЕТ: она придёт вместе с телефонией и своим потребителем.
//
// ⚠⚠ СПИСОК СОСТОЯНИЙ — ВЫПАДАЮЩЕЕ ПОЛЕ, И ЭТО ПРАВКА ПЕРВОЙ СБОРКИ.
// Так его называют все три источника: решение владельца 119 — «сверху
// ВЫПАДАЮЩИЙ список статусов», паспорт `d3afce57` — «поле слоя
// `.ui-field__control`», макет `6cd2d954` — `<select>` с пятью значениями.
// Первым заходом я собрал теми же строками, что в панели пилюли, и приёмка
// этого не поймала. Вскрыла ГЕОМЕТРИЯ: пять строк вместе с полем номера и
// «Набрать» в окно 280 × 350 не помещаются, а поле занимает один ряд.
// ⚠ Источник у обоих видов ПРЕЖНИЙ ОДИН — `current` в `operatorWorkState`;
// расходится только способ показа, чего решение 119 и требует.

import { makeFloating } from '/ui/float.js';
import { icon } from '/ui/icons.js';
import { readFloatCollapsed, writeFloatCollapsed } from '/viewPrefs.js';
import { wireRuPhoneMask } from '/phoneMask.js';

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
            <div class="ui-float__body">
                <div class="ui-note ui-note--warn">
                    ${icon('warn', 'sm', 'ui-note__icon')}
                    <div class="ui-note__body">
                        <span class="ui-note__text">Телефония не подключена — набор не сработает</span>
                    </div>
                </div>
                <div class="ui-field" data-role="tel-state-field"></div>
                <div class="ui-field">
                    <label class="ui-field__label" for="opTelNum">Номер</label>
                    <input class="ui-field__control" type="tel" id="opTelNum" data-role="tel-num"
                        placeholder="+7" inputmode="tel" autocomplete="off">
                </div>
                <button type="button" class="ui-btn ui-btn--lg ui-btn--block" data-role="tel-dial" disabled>Набрать</button>
            </div>
        `;
        document.body.appendChild(win);

        win.querySelector('[data-role="tel-min"]').addEventListener('click', collapse);
        // Маска — из общего файла, своей копии у пульта нет (решение 134).
        wireRuPhoneMask(win.querySelector('[data-role="tel-num"]'));

        floating = makeFloating(win, { key: KEY, place: defaultPlace() });
        // Список состояний кладёт сюда сам `operatorWorkState` — своих строк
        // пульт не рисует.
        workState.setMirror(win.querySelector('[data-role="tel-state-field"]'));
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
