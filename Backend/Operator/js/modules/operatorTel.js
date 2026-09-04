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
// ⚠⚠ «НАБРАТЬ» ОЖИЛА (Е2, 04.09.2026), И ПРЕЖНИЙ ДОВОД СНЯТ ПО ФАКТУ. Здесь
// стояло: «неактивна всегда… ключей Телфина нет, `INSERT INTO calls` в проекте
// ноль». Оба утверждения были верны и оба перестали: ключи живут в настройках
// с задачи 57, вставок в `calls` теперь ДВЕ — разбор события станции
// (`services/pbxEventStore.js`) и этот самый набор (`services/pbxDial.js`).
//
// ⚠ ПРАВИЛО КНОПКИ ВЗЯТО ПОЛОВИНОЙ, И ЭТО НАРЯД, А НЕ НЕДОДЕЛКА. Состояние 8
// паспорта: «неактивна, если номер пуст ИЛИ трубка не подключена». Живёт
// первая половина; вторая придёт с Е3 вместе с признаком трубки. Ветки под
// неё здесь НЕТ намеренно — узел без потребителя это то же мёртвое имя, за
// которое сняли К317.
//
// ⚠ И ПОСТОЯННАЯ ПЛАШКА «ТЕЛЕФОНИЯ НЕ ПОДКЛЮЧЕНА» УБРАНА. Она говорила про
// состояние, которого больше нет; её место занял ответ на конкретный набор —
// плашка появляется по итогу нажатия и исчезает со следующим. Тревога,
// которая горит всегда, не тревога.
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
import { wireDialMask } from '/phoneMask.js';
import { dialNumber } from './operatorStorage.js';

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
 * @param {number} deps.employeeId кто звонит — тот же номер, что у всех
 *        запросов страницы; сервер помечает его «указан браузером»
 * @param {Function} deps.currentLeadId лид, открытый СЕЙЧАС, или null.
 *        ⚠ Функцией, а не числом: пульт живёт дольше карточки, и число,
 *        взятое при открытии окна, к третьему звонку указывало бы на
 *        позавчерашнего человека.
 */
export function createTelPult({ workState, employeeId, currentLeadId }) {
    let win = null;
    let fab = null;
    let floating = null;
    // ⚠ ПРИЗНАК «ЗАПРОС ИДЁТ», А НЕ «ЗВОНОК ИДЁТ». Второго у нас нет вовсе —
    // он приходит с Е3 вместе с состоянием трубки. Держит кнопку от двойного
    // нажатия ровно от нажатия до ответа, и большего не обещает.
    let busy = false;

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

        // ⚠ МАСКА У ПУЛЬТА СВОЯ, И ЭТО РЕШЕНИЕ ВЛАДЕЛЬЦА 147, А НЕ КОПИЯ.
        // Общая (`wireRuPhoneMask`) дописывает семёрку всему, и `101` в ней
        // становится `+7 (101)` — внутренний вызов невозможен. Обе обёртки
        // лежат в одном файле, довод «почему их две» — там же.
        const num = win.querySelector('[data-role="tel-num"]');
        wireDialMask(num);
        num.addEventListener('input', syncDial);
        win.querySelector('[data-role="tel-dial"]').addEventListener('click', dial);
        syncDial();

        floating = makeFloating(win, { key: KEY, place: defaultPlace() });
        // Список состояний кладёт сюда сам `operatorWorkState` — своих строк
        // пульт не рисует.
        workState.setMirror(win.querySelector('[data-role="tel-state-field"]'));
        writeFloatCollapsed(KEY, false);
    }

    // ---------------------------------------------------------------- набор
    //
    // Кнопка живёт по половине правила состояния 8: «номер не пуст». Вторая
    // половина — про трубку, её признак приходит с Е3.
    function syncDial() {
        if (!win) return;
        const num = win.querySelector('[data-role="tel-num"]');
        const btn = win.querySelector('[data-role="tel-dial"]');
        if (!num || !btn) return;
        btn.disabled = busy || num.value.trim() === '';
    }

    // ⚠⚠ ПЛАШКА ЯВЛЯЕТСЯ УЗЛОМ, А НЕ ПРЯЧЕТСЯ. То же правило, что у свёрнутого
    // окна выше: спрятанный узел продолжает ловить фокус и читаться с экрана,
    // а пустой — ещё и занимать зазор колонки (`.ui-float__body`, gap).
    function setNote(text, kind) {
        if (!win) return;
        const body = win.querySelector('.ui-float__body');
        const old = body.querySelector('[data-role="tel-note"]');
        if (old) old.remove();
        if (!text) return;
        const note = document.createElement('div');
        note.className = 'ui-note' + (kind === 'warn' ? ' ui-note--warn' : '');
        note.setAttribute('data-role', 'tel-note');
        note.setAttribute('role', 'status');
        note.innerHTML = `${icon(kind === 'warn' ? 'warn' : 'info', 'sm', 'ui-note__icon')}`
            + `<div class="ui-note__body"><span class="ui-note__text"></span></div>`;
        // Текст ставится СВОЙСТВОМ, а не разметкой: сюда приезжает ответ
        // станции, то есть чужая строка, и вклеивать её в HTML нельзя.
        note.querySelector('.ui-note__text').textContent = text;
        body.insertBefore(note, body.firstChild);
    }

    // ⛔ ОТКАЗ ПОКАЗЫВАЕТСЯ ТЕКСТОМ, А НЕ МОЛЧАНИЕМ (решение владельца 147).
    // Если станция не примет внутренний номер — это факт, который владелец
    // должен увидеть; обходить его подстановкой префикса мы не будем.
    //
    // ⚠ «НАБОР ПРИНЯТ» — НЕ «ПОЗВОНИЛИ». Станция сначала звонит оператору и
    // только после снятия трубки — клиенту; состоялся ли разговор, покажет
    // журнал звонков, когда придёт событие.
    async function dial() {
        if (!win || busy) return;
        const num = win.querySelector('[data-role="tel-num"]');
        const number = num ? num.value.trim() : '';
        if (!number) return;

        busy = true;
        syncDial();
        setNote(null);
        try {
            const leadId = typeof currentLeadId === 'function' ? currentLeadId() : null;
            const answer = await dialNumber({ employeeId, number, leadId });
            setNote(answer && answer.internal
                ? 'Набор принят: звоним на добавочный. Сначала трубка зазвонит у вас.'
                : 'Набор принят. Сначала трубка зазвонит у вас, потом у клиента.');
        } catch (err) {
            // Своё сообщение станции приложено отдельным полем — показываем
            // его следом за нашим, а не вместо: чужие слова остаются чужими.
            const said = err && err.station ? ` Станция: ${err.station}` : '';
            setNote(((err && err.message) || 'Не удалось начать звонок') + said, 'warn');
        } finally {
            busy = false;
            syncDial();
        }
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
