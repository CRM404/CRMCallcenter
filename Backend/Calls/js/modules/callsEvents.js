// --- Calls/js/modules/callsEvents.js: вкладка «Звонки → События» ------------
//
// Третья вкладка раздела и первая настройка, которая меняет ПОВЕДЕНИЕ системы, а
// не её вид (паспорт Р12). Числа, стоявшие константами в коде — перезвон через
// час, двадцать попыток, окно 9–21, — стали тремя событиями руководителя.
//
// СОБЫТИЙ РОВНО ТРИ, И ЧЕТВЁРТОГО НЕ БЫВАЕТ: каждое отвечает за своё место в
// коде, а «добавить событие» означало бы «добавить поведение». Отсюда всё
// остальное — счётчика у вкладки нет (число, которое никогда не меняется, это
// украшение), пустого состояния нет (`.ui-empty` спрятал бы единственное, что
// человеку нужно увидеть, — какие события бывают), и вместо него у каждого
// события строка «Не настроено» с ПОСЛЕДСТВИЕМ.
//
// ⚠ БЫЛО ЧЕТЫРЕ. Решение владельца 109 (К259) сняло «Время перевода»: одно
// число на всех стало полем строки — своим у каждого сотрудника, ровно как у
// оффера. Окна у события больше нет, и «ждать без предела» сказать больше
// нечем: поле обязательное.
//
// СТРОКА-ИТОГ — ТО, РАДИ ЧЕГО ВКЛАДКА СУЩЕСТВУЕТ. Руководитель приходит
// посмотреть, что система делает сама; строка «Включено» этого не отвечает и
// заставляет открыть три окна подряд, чтобы собрать картину, которую экран
// обязан показать сразу. Поэтому здесь столько работы со словами.
//
// СВОЙ МОДУЛЬ, А НЕ ЧАСТЬ callsApp. У вкладки три окна, и вместе они больше
// самого раздела; складывать журнал звонков и настройку планировщика в один
// файл значит получить полторы тысячи строк, в которых правка одного не видна
// на фоне другого. Экземпляр создаётся разделом и живёт ровно столько же.
//
// РАЗМЕТКА СОБИРАЕТСЯ УЗЛАМИ, А НЕ СТРОКОЙ. Имена статусов, скриптов, офферов и
// сотрудников приходят из базы и попадают на экран только через textContent:
// незаэкранированное имя в innerHTML уже становилось находкой приёмки на
// прошлой задаче.

import { openModal } from '/ui/modal.js';
import { iconNode } from '/ui/icons.js';
import { showToast } from '/ui/toast.js';
import { isAbort } from '/api.js';
import {
    fetchEvents, fetchEventDirectories, setEventEnabled,
    saveAutoRecall, saveTransfer, saveWrapup
} from './callsStorage.js';

// Дни недели — числами 1..7, как их держит база (`weekdays SMALLINT[]`).
// Понедельник первый: это календарь руководителя, а не ISO-упражнение.
const DAYS = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [7, 'Вс']];

// Линия — те же два значения, что у сотрудника и у лида (`employees.line_type`).
const LINE_TYPES = ['Входящая', 'Исходящая'];

// Умолчание рабочего окна — сегодняшнее поведение системы (наряд, раздел 8:
// «умолчания равны сегодняшним числам»). Ставится только новому окну, которого
// в базе нет вовсе; заполненное отсюда не перетирается.
const DEFAULT_WINDOW = { from: '09:00', to: '21:00' };

// Три события в том порядке, в каком они стоят на вкладке. Порядок не
// алфавитный и не по важности: сначала то, что работает без участия оператора
// (автоперезвон), потом то, что он запускает сам (перевод), потом то, что
// случается после разговора (пост-обработка).
const EVENTS = [
    { slug: 'auto-recall', key: 'autoRecall', title: 'Автоперезвон' },
    { slug: 'transfer', key: 'transfer', title: 'Перевод' },
    { slug: 'wrapup', key: 'wrapup', title: 'Пост-обработка' }
];

// ТЕКСТЫ «НЕ НАСТРОЕНО» — ДОСЛОВНО ИЗ ПАСПОРТА Р12. Каждый называет не пустоту,
// а её последствие: пустое поле говорит, чего нет, экран обязан сказать, что
// из-за этого происходит.
const NOT_SET = {
    autoRecall: 'Не настроено. Система не перезванивает — лид ждёт, пока оператор возьмёт его сам.',
    transfer: 'Не настроено. Ни одного адресата — перевод недоступен оператору в любое время.',
    wrapup: 'Не настроено. Пост-обработка не кончается сама ни для одной пары.'
};

// ПОСЛЕДСТВИЕ ВЫКЛЮЧЕНИЯ — вторым предложением к настроенному событию. Текст
// пост-обработки взят с макета дословно; три остальных написаны по его образцу
// из последствий выше: выключенное событие ведёт себя ровно как ненастроенное,
// и молчать об этом нельзя — настройки-то на месте и читаются.
const OFF_TAIL = {
    autoRecall: 'Событие выключено: система не перезванивает.',
    transfer: 'Событие выключено: перевод недоступен оператору.',
    wrapup: 'Событие выключено: пост-обработка не кончается сама.'
};

const MARK_TAIL = {
    'окончательный': 'лид уходит в архив сам',
    'промежуточный': 'лид останется в работе'
};

// ---------------------------------------------------------------- слова

/**
 * Русское число: одна форма из трёх.
 *
 * Своя копия, а не общий помощник: такая же живёт в `Shell/history/historyTable.js`
 * и в `Shell/deleteBlocked.js`. Выносить её в слой — отдельная работа со своим
 * разбором, и делать её мимоходом внутри чужой задачи нельзя.
 */
function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

// Родительный падеж — то, что стоит после «от» и «до»: «от 30 минут до 4 часов»,
// «до 21 часа». Форм здесь две, а не три, и это не упрощение: в родительном
// «2 часов» и «5 часов» совпадают.
function gen(n, one, many) {
    return n % 10 === 1 && n % 100 !== 11 ? one : many;
}

/**
 * Длительность словами. ДВА ПАДЕЖА, И ЭТО НЕ ПРИДИРКА.
 *
 * Именительный стоит сам по себе — «интервал 1 час»; родительный идёт после «от»
 * и «до» — «от 30 минут до 4 часов». Одной формой обойтись нельзя: строка-итог
 * читается человеком вслух, и «по 1 часа» в ней выглядит опечаткой продукта, а
 * не грамматикой. Проверено собственным набором — первая версия писала именно
 * так.
 */
function durationNom(minutes) {
    return durationParts(minutes,
        (n) => `${n} ${plural(n, 'час', 'часа', 'часов')}`,
        (n) => `${n} ${plural(n, 'минута', 'минуты', 'минут')}`);
}

function durationGen(minutes) {
    return durationParts(minutes,
        (n) => `${n} ${gen(n, 'часа', 'часов')}`,
        (n) => `${n} ${gen(n, 'минуты', 'минут')}`);
}

function durationParts(minutes, hourWord, minuteWord) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const parts = [];
    if (hours) parts.push(hourWord(hours));
    if (rest || !hours) parts.push(minuteWord(rest));
    return parts.join(' ');
}

// «20.08.2026» — тот же вид даты, что во всём разделе.
function dateLabel(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
}

// ---------------------------------------------------------------- строки-итоги

function autoRecallSummary(data) {
    const rules = data.rules || [];
    // «Не настроено» — это И пустой перечень, И незаполненное окно: без окна
    // система не перезванивает точно так же, и `usableWindow` на сервере читает
    // обе половины одинаково. Разные слова для одного бездействия врали бы.
    if (!rules.length || !data.windowFrom || !data.windowTo) return NOT_SET.autoRecall;

    const intervals = rules.map((r) => r.intervalMinutes);
    const limits = rules.map((r) => r.maxAttempts);
    // Целевые считаются ПО ИДЕНТИФИКАТОРУ, а не по имени: имена статусов
    // уникальны внутри этапа, но не между этапами, и два разных статуса с
    // одинаковым именем слились бы в один.
    const targets = [...new Set(rules.map((r) => r.afterLimitStatusId))];

    const head = `Перезвон по ${rules.length} ${gen(rules.length, 'статусу', 'статусам')}`
        + `, обзвон с ${data.windowFrom} до ${data.windowTo}`;

    const minInterval = Math.min(...intervals);
    const maxInterval = Math.max(...intervals);
    const interval = minInterval === maxInterval
        ? `интервал ${durationNom(minInterval)}`
        : `интервал от ${durationGen(minInterval)} до ${durationGen(maxInterval)}`;

    const minLimit = Math.min(...limits);
    const maxLimit = Math.max(...limits);
    const limit = minLimit === maxLimit
        ? `предел ${minLimit} ${plural(minLimit, 'попытка', 'попытки', 'попыток')}`
        : `предел от ${minLimit} до ${maxLimit} ${gen(maxLimit, 'попытки', 'попыток')}`;

    // Целевой статус один на все строки — называем его и последствие; разные —
    // называть первый попавшийся нельзя, это была бы неправда про остальные.
    let tail;
    if (targets.length === 1) {
        const rule = rules[0];
        const mark = rule.afterStatusMark ? MARK_TAIL[rule.afterStatusMark] : null;
        tail = `После предела — «${rule.afterStatusName}»${mark ? `, и ${mark}` : ''}.`;
    } else {
        tail = 'После предела — свой статус у каждой строки.';
    }
    return `${head}, ${interval}, ${limit}. ${tail}`;
}

function transferSummary(data) {
    const offers = data.offers || [];
    const employees = data.employees || [];
    if (!offers.length && !employees.length) return NOT_SET.transfer;

    const parts = [];
    if (offers.length) parts.push(`Партнёрам — ${offers.length} ${plural(offers.length, 'оффер', 'оффера', 'офферов')}, ${worksWords(offers)}`);
    if (employees.length) parts.push(`Своим — ${employees.length} ${plural(employees.length, 'сотрудник', 'сотрудника', 'сотрудников')}, ${worksWords(employees)}`);
    return `${parts.join('. ')}. Вне разрешённого времени перевод недоступен.`;
}

// «работает 1» / «работают 3» / «не работает ни одна». Строка считается
// работающей, когда она включена И не заблокирована — блокировку называет
// сервер, потому что две из трёх её причин завязаны на «сегодня».
function worksWords(rows) {
    const live = rows.filter((r) => r.enabled && !r.blockedReason).length;
    if (!live) return 'не работает ни одна';
    return live === 1 ? 'работает 1' : `работают ${live}`;
}

function wrapupSummary(data) {
    const pairs = data.pairs || [];
    if (!pairs.length) return NOT_SET.wrapup;
    if (pairs.length === 1) {
        const p = pairs[0];
        return `${p.lineType} линия + «${p.scriptTitle}» — ${p.durationSeconds} ${plural(p.durationSeconds, 'секунда', 'секунды', 'секунд')}.`;
    }
    const seconds = pairs.map((p) => p.durationSeconds);
    const min = Math.min(...seconds);
    const max = Math.max(...seconds);
    const range = min === max
        ? `длительность ${min} ${plural(min, 'секунда', 'секунды', 'секунд')}`
        : `от ${min} до ${max} ${gen(max, 'секунды', 'секунд')}`;
    return `${pairs.length} ${plural(pairs.length, 'пара', 'пары', 'пар')} «линия + скрипт», ${range}.`;
}

const SUMMARY = {
    autoRecall: autoRecallSummary,
    transfer: transferSummary,
    wrapup: wrapupSummary
};

// Настроено ли событие вообще — по тому же признаку, что и строка-итог: если
// итог равен тексту «Не настроено», хвоста про выключение не будет. Двух
// определений «настроено» в одном экране быть не должно.
function isConfigured(key, data) {
    return SUMMARY[key](data) !== NOT_SET[key];
}

// ---------------------------------------------------------------- узлы

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function button(className, text, iconName) {
    const node = el('button', className);
    node.type = 'button';
    if (iconName) node.appendChild(iconNode(iconName, 'sm'));
    if (text) node.appendChild(document.createTextNode(text));
    return node;
}

/**
 * Поле формы: метка, орган управления, место под ошибку и подсказка.
 *
 * `short` — четвёртый ключ рядом с `wide`, а не отдельный помощник: `--wide` и
 * `--short` объявлены соседними модификаторами одного `.ui-field`
 * (`field.css:299` и `:309`), и разводить одну природу по двум помощникам
 * значило бы собирать её двумя способами. Сужается ОРГАН УПРАВЛЕНИЯ, а не
 * ячейка сетки: метка и подсказка читаются во всю ширину, а раскладка не едет.
 */
function fieldBox(label, control, { required = false, hint = '', wide = false, short = false } = {}) {
    const box = el('div', `ui-field${wide ? ' ui-field--wide' : ''}${short ? ' ui-field--short' : ''}`);
    if (label) {
        box.appendChild(el('label', `ui-field__label${required ? ' ui-field__label--required' : ''}`, label));
    }
    box.appendChild(control);
    box.appendChild(el('div', 'ui-field__error'));
    if (hint) box.appendChild(el('div', 'ui-field__hint', hint));
    return box;
}

function input(type, value, aria, small) {
    const node = el('input', `ui-field__control${small ? ' ui-field__control--sm' : ''}`);
    node.type = type;
    if (value !== null && value !== undefined) node.value = String(value);
    if (aria) node.setAttribute('aria-label', aria);
    return node;
}

/**
 * Поле с единицей измерения справа: «45» + «секунд».
 *
 * ОСТАЛОСЬ ТОЛЬКО В ПЕРЕЧНЯХ «ПЕРЕВОДА», и это не остаток недоделки: там нет
 * колонок, и подписать единицу больше негде. В таблицах «Автоперезвона» и
 * «Пост-обработки» единица уехала в шапку колонки (К254, К256) — подпись рядом
 * с полем не давала полю сжаться, и число вылезало из ячейки.
 */
function withUnit(control, unit) {
    const row = el('div', 'ui-field__row');
    row.appendChild(control);
    row.appendChild(el('span', 'ui-table__muted', unit));
    return row;
}

function select(options, value, aria, small) {
    const node = el('select', `ui-field__control${small ? ' ui-field__control--sm' : ''}`);
    if (aria) node.setAttribute('aria-label', aria);
    options.forEach((opt) => {
        const option = el('option', '', opt.label);
        option.value = String(opt.value);
        if (opt.disabled) option.disabled = true;
        if (String(opt.value) === String(value)) option.selected = true;
        node.appendChild(option);
    });
    return node;
}

function note(text, { title = '', kind = '' } = {}) {
    const box = el('div', `ui-note${kind ? ` ui-note--${kind}` : ''}`);
    box.appendChild(iconNode(kind === 'warn' ? 'warn' : 'info', 'sm', 'ui-note__icon'));
    const body = el('div', 'ui-note__body');
    if (title) body.appendChild(el('div', 'ui-note__title', title));
    body.appendChild(el('div', 'ui-note__text', text));
    box.appendChild(body);
    return box;
}

/** Ряд чипов дней недели. Чип — <label> со своим checkbox: пробел переключает. */
function daysRow(selected) {
    const row = el('div', 'ui-choices');
    const chosen = new Set((selected || []).map(Number));
    DAYS.forEach(([value, label]) => {
        const on = chosen.has(value);
        const chip = el('label', `ui-choice${on ? ' ui-choice--on' : ''}`);
        const box = el('input');
        box.type = 'checkbox';
        box.value = String(value);
        box.checked = on;
        box.addEventListener('change', () => chip.classList.toggle('ui-choice--on', box.checked));
        chip.appendChild(box);
        chip.appendChild(document.createTextNode(label));
        row.appendChild(chip);
    });
    return row;
}

function readDays(row) {
    return Array.from(row.querySelectorAll('input[type="checkbox"]'))
        .filter((box) => box.checked)
        .map((box) => Number(box.value));
}

/** Чип-выключатель строки перечня: «Включена». */
function enabledChip(enabled) {
    const chip = el('label', `ui-choice${enabled ? ' ui-choice--on' : ''}`);
    const box = el('input');
    box.type = 'checkbox';
    box.checked = enabled;
    box.dataset.role = 'row-enabled';
    box.addEventListener('change', () => {
        chip.classList.toggle('ui-choice--on', box.checked);
        const rowBox = chip.closest('.zv-row');
        if (rowBox) rowBox.classList.toggle('zv-row--off', !box.checked);
    });
    chip.appendChild(box);
    chip.appendChild(document.createTextNode('Включена'));
    return chip;
}

function trashButton(label) {
    const btn = button('ui-btn ui-btn--ghost ui-btn--icon ui-btn--danger', '', 'trash');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    return btn;
}

// ---------------------------------------------------------------- ошибки полей

function clearErrors(root) {
    root.querySelectorAll('.ui-field--error').forEach((f) => f.classList.remove('ui-field--error'));
    root.querySelectorAll('.ui-field__error').forEach((e) => { e.textContent = ''; });
}

/**
 * Отметить поле ошибкой.
 *
 * ОШИБКА ЖИВЁТ ПОД СВОИМ ПОЛЕМ, а не сводкой вверху окна (паспорт Р12). Сводка
 * называет число вместо места, и слой уже держит обратное правило: подсказка
 * уступает место ошибке, `field.css:145`.
 */
function markError(control, text) {
    const box = control.closest('.ui-field');
    if (!box) return control;
    box.classList.add('ui-field--error');
    const slot = box.querySelector('.ui-field__error');
    if (slot) slot.textContent = text;
    return control;
}

/**
 * Показать первую ошибку человеку: докрутить до неё и поставить курсор.
 *
 * Без прокрутки отказ сохранения выглядит как «кнопка не работает»: ошибка может
 * стоять в строке, которой сейчас не видно.
 */
function focusFirstError(root) {
    const box = root.querySelector('.ui-field--error');
    if (!box) return;
    const control = box.querySelector('input, select');
    if (box.scrollIntoView) box.scrollIntoView({ block: 'center' });
    if (control) control.focus();
}

/**
 * КЛЮЧ СРАВНЕНИЯ НОМЕРА, А НЕ ФОРМАТ (К265, ответ куратора 12).
 *
 * Формат живёт на сервере — `services/phoneFormat.js`, — и в базу номер кладёт
 * он же: все сохранённые строки уже в едином виде `+7XXXXXXXXXX`
 * (`routes/callEvents.js`, `normalizePhone` перед записью). Экрану приводить
 * нечего: ему нужен ответ на один вопрос — «один ли это номер».
 *
 * ДЕСЯТЬ ПОСЛЕДНИХ ЦИФР — ЭТО ВЕСЬ НОМЕР: в приведённом виде перед ними стоит
 * только `+7`. Поэтому «8 (495) 120-45-67» и «+74951204567» дают один ключ, а
 * «просто цифры» без хвоста дали бы разные — `8495…` против `7495…`.
 *
 * ⚠ ВТОРОЙ КОПИИ ПРИВЕДЕНИЯ ЗДЕСЬ НЕТ НАМЕРЕННО. Отдать фронту сам
 * `phoneFormat.js` нельзя — он CommonJS, а модули экрана ESM, и один файл в
 * двух видах это два источника правды (К36). Написать приведение второй раз —
 * та же К36 прямо. Экрану и не нужны шесть причин отказа: ему нужно одно
 * сравнение.
 *
 * ⚠ ЧЕСТНАЯ ГРАНИЦА КЛЮЧА: он не отличит номер с добавочным, дописанным в
 * конец, от номера без него. СЕРВЕР ОТЛИЧИТ — у него полный разбор. Это и есть
 * та дверь, ради которой оставлен `serverRefusal`: «на случай, когда правила
 * разойдутся».
 */
function phoneKey(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\D/g, '').slice(-10);
}

/**
 * Текст отказа «одна сеть на номер».
 *
 * ⚠ СЛОВО В СЛОВО ТОТ ЖЕ, ЧТО НА СЕРВЕРЕ (`routes/callEvents.js`,
 * `oneNetworkError`). Двух формулировок одного отказа быть не должно; общего
 * модуля у экрана и сервера нет — среды разные, — и связь держится этой
 * пометкой с обеих сторон.
 */
function oneNetworkError(networkName) {
    return `Этот номер уже стоит у оффера сети «${networkName}» — `
        + 'у одного номера может быть только одна сеть';
}

// Целое положительное из поля. Пусто — НЕ ноль: у события все поля обязательны,
// и «не заполнено» обязано отличаться от «заполнено нулём».
function wholeNumber(value) {
    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------- вкладка

export function createEventsTab({ pane, api, scope }) {
    const $ = (sel) => pane.querySelector(sel);

    const state = { events: null, dirs: null, loaded: false, alive: true };
    let openWindow = null;
    // ВТОРАЯ РУЧКА, А НЕ ТА ЖЕ САМАЯ (К255). Окно «Добавить офферы» стоит
    // ПОВЕРХ окна «Перевод», и оба живы одновременно. Положи его в `openWindow`
    // — и уход с вкладки закрыл бы только верхнее, оставив нижнее висеть над
    // чужим разделом. Слой стопку окон держит сам (`modal.js`, `OPEN_STACK`);
    // здесь надо помнить обе, чтобы закрыть обе.
    let pickWindow = null;

    async function load() {
        // Справочники и события — одним заходом: без справочника окна нечем
        // наполнить, а показывать вкладку и отказывать при нажатии «Настроить»
        // значит соврать строкой-итогом дважды.
        const [events, dirs] = await Promise.all([fetchEvents(api), fetchEventDirectories(api)]);
        if (!state.alive) return;
        state.events = events;
        state.dirs = dirs;
        state.loaded = true;
        render();
    }

    function render() {
        const list = $('[data-role="events-list"]');
        list.innerHTML = '';
        if (!state.events) return;
        EVENTS.forEach((event) => list.appendChild(eventRow(event)));
        // Плашка про бесконечную пост-обработку показывается вместе со
        // столбиком, а не сама по себе: до загрузки объяснять нечего.
        $('[data-role="events-note"]').hidden = false;
    }

    function eventRow(event) {
        const data = state.events[event.key];
        const configured = isConfigured(event.key, data);
        const box = el('div', `zv-event${data.enabled ? '' : ' zv-event--off'}`);
        box.dataset.event = event.slug;

        const left = el('div');
        left.appendChild(el('b', '', event.title));
        // Выключенное настроенное событие говорит и что настроено, и что
        // настройка сейчас не работает. Одно без другого вводит в заблуждение.
        const summary = configured && !data.enabled
            ? `${SUMMARY[event.key](data)} ${OFF_TAIL[event.key]}`
            : SUMMARY[event.key](data);
        left.appendChild(el('div', 'zv-event__sum', summary));
        box.appendChild(left);

        const switcher = el('div', 'ui-switch');
        switcher.setAttribute('role', 'group');
        switcher.setAttribute('aria-label', event.title);
        [[true, 'Включено'], [false, 'Выключено']].forEach(([value, label]) => {
            const opt = button(`ui-switch__option${data.enabled === value ? ' ui-switch__option--active' : ''}`, label);
            opt.addEventListener('click', () => toggle(event, value));
            switcher.appendChild(opt);
        });
        box.appendChild(switcher);

        const setup = button('ui-btn ui-btn--secondary', 'Настроить');
        setup.addEventListener('click', () => openEventWindow(event));
        box.appendChild(setup);
        return box;
    }

    /**
     * Выключатель срабатывает сразу и шлёт ТОЛЬКО себя.
     *
     * Слать вместе с ним весь перечень значило бы отправлять настройку целиком
     * ради одной галочки — и затирать правку, сделанную в окне между чтением
     * списка и щелчком.
     */
    async function toggle(event, enabled) {
        const data = state.events[event.key];
        if (data.enabled === enabled) return;
        try {
            await setEventEnabled(api, event.slug, enabled);
            if (!state.alive) return;
            data.enabled = enabled;
            render();
        } catch (err) {
            if (!state.alive || isAbort(err)) return;
            showToast(err.message || 'Не удалось переключить событие', 'error');
        }
    }

    function openEventWindow(event) {
        const openers = {
            autoRecall: openAutoRecallWindow,
            transfer: openTransferWindow,
            wrapup: openWrapupWindow
        };
        openers[event.key]();
    }

    // Общая обвязка окна: заголовок, тело, «Отмена» и «Сохранить». Само окно
    // берётся из слоя целиком — своих окон раздел не заводит.
    function modal({ title, sub, body, size, onSave }) {
        openWindow = openModal({
            title,
            sub,
            body,
            scope,
            size,
            // ТРЕТЬЯ ДВЕРЬ ЗАКРЫТА НА КЛЮЧ. В окне события набирают перечни; цена
            // промаха мимо окна равна всему вводу. Esc и крестик остаются.
            scrimClose: false,
            actions: [
                { label: 'Отмена', variant: 'ghost', value: false },
                { label: 'Сохранить', onClick: onSave }
            ]
        });
        return openWindow;
    }

    // Отказ сервера, которого не поймала проверка на экране. В норме сюда не
    // приходят: всё, что сервер отбивает, экран проверяет сам. Оставлено на
    // случай, когда правила разойдутся, — молча закрыть окно и потерять ввод
    // было бы хуже.
    function serverRefusal(err) {
        if (isAbort(err)) return true;
        showToast(err.message || 'Не удалось сохранить событие', 'error');
        return false;
    }

    // ------------------------------------------------------ окно «Автоперезвон»

    function openAutoRecallWindow() {
        const data = state.events.autoRecall;
        const statuses = state.dirs.statuses;
        const rows = (data.rules || []).map((r) => ({
            id: r.id,
            funnelStatusId: r.funnelStatusId,
            statusName: r.statusName,
            intervalMinutes: r.intervalMinutes,
            maxAttempts: r.maxAttempts,
            afterLimitStatusId: r.afterLimitStatusId
        }));

        const body = el('div', 'zv-recall');

        // ОКНО ОБЗВОНА — ОДНО НА ВСЁ СОБЫТИЕ И СТОИТ НАД ТАБЛИЦЕЙ (дозаказ
        // куратора от 27.08.2026). Колонкой в строке оно повторяло бы одно и то
        // же число пятьдесят раз; интервал и предел свои у каждого статуса,
        // окно общее — так это работает и в коде, `shiftIntoCallWindow` один на
        // все перезвоны.
        const windowGrid = el('div', 'ui-form-grid');
        const fromInput = input('time', data.windowFrom || DEFAULT_WINDOW.from, 'Обзвон с');
        const toInput = input('time', data.windowTo || DEFAULT_WINDOW.to, 'Обзвон до');
        // ПОДСКАЗКИ У ЭТИХ ДВУХ ПОЛЕЙ НЕТ. Прежний довод — «сетка равняет поля
        // по низу, и поле с подсказкой поднимает свой ввод над соседним на
        // 37 px» — СНЯТ К253: с 29.08.2026 `.ui-form-grid` равняет по верху
        // (`field.css:297`), и подсказка соседа больше не двигает. Решение
        // остаётся, но держится другим: часовой пояс — свойство окна, а не
        // поля, и сказан он в плашке под таблицей. Два поля времени подписывать
        // им по отдельности значило бы повторить одно и то же дважды.
        windowGrid.appendChild(fieldBox('Обзвон с', fromInput, { required: true }));
        windowGrid.appendChild(fieldBox('до', toInput, { required: true }));
        body.appendChild(windowGrid);

        // ШИРИНЫ КОЛОНОК ЗАДАЁТ РАЗДЕЛ, А НЕ БРАУЗЕР (К231). Без них браузер
        // раздал ширины по содержимому: поле на три цифры стало самой широкой
        // колонкой окна, имя целевого статуса обрезалось, а пилюля с
        // последствием ломалась пополам. «Статус» забирает остаток.
        //
        // ЧИСЛА ПЕРЕМЕРЕНЫ ЗАНОВО (К256). Прежние 132 · 118 · 266 оставляли
        // «Статусу» 106, и самое длинное имя вставало в три строки; на 130 оно
        // встаёт в две, а три коротких — в одну. Больше 130 «Статусу» не даёт
        // ничего до 207 — столько нужно, чтобы «Автоответчик / голосовая почта»
        // встал в строку, а такой ширины в этой таблице нет.
        //
        // ЕДИНИЦА — В ШАПКЕ КОЛОНКИ, А НЕ В ЯЧЕЙКЕ. Подпись рядом с полем не
        // давала полю сжаться, и `<input type="number">` занимал свои 164 px
        // при заказанной колонке — 54 px наружу. Решение владельца по К254,
        // и оно же применено здесь.
        //
        // `ui-table--fields` — ячейки с полями равняются по ВЕРХУ: у «Статуса
        // после предела» под списком живёт подстрока-последствие, и общая для
        // таблиц середина поднимала поля соседей на 16,5 px.
        const wrap = el('div', 'ui-table-wrap');
        const table = el('table', 'ui-table ui-table--fields zv-fixed');
        table.innerHTML = '<thead><tr>'
            + '<th>Статус</th><th style="width:118px">Интервал, мин</th>'
            + '<th style="width:100px">Предел</th><th style="width:274px">Статус после предела</th>'
            + '<th class="ui-table__acts" style="width:54px"></th></tr></thead>';
        const tbody = el('tbody');
        table.appendChild(tbody);
        wrap.appendChild(table);
        body.appendChild(wrap);

        const addBtn = button('ui-btn ui-btn--ghost ui-btn--add', 'Добавить статус', 'plus');
        body.appendChild(addBtn);

        // Состояние 7б паспорта: не размечен НИ ОДИН статус. Плашка объясняет,
        // что это значит и где размечают, — без неё список целевых статусов
        // выглядит сломанным.
        if (!statuses.some((s) => s.mark)) {
            body.appendChild(note(
                'Пока у статуса не сказано, окончательный он или промежуточный, система не знает, '
                + 'уходить ли лиду в архив. Разметить статусы можно во вкладке «Статусы воронки» — '
                + 'это разовая работа, и делается она один раз.',
                { title: 'Целевым можно выбрать только размеченный статус' }));
        }

        body.appendChild(note(
            'Счёт попыток — нарастающим итогом за всё время, а не за день. Звонок, не состоявшийся '
            + 'по нашей вине, попыткой не считается. Оператор интервалы не меняет. Окно обзвона '
            + 'ограничивает все перезвоны события: интервал досчитал до 22:40 — звонок уедет на утро. '
            + 'Время московское — для всех, включая тех, кто работает не из Москвы.'));

        function renderRows(focusLast) {
            tbody.innerHTML = '';
            rows.forEach((row, index) => tbody.appendChild(ruleRow(row, index)));
            // ПУСТОЙ ПЕРЕЧЕНЬ ПРЯЧЕТ ТАБЛИЦУ ЦЕЛИКОМ, А НЕ ПОКАЗЫВАЕТ ГОЛУЮ
            // ШАПКУ (К233). Шапка над пустотой обещает перечень, которого нет:
            // видна должна быть только кнопка «Добавить статус».
            wrap.hidden = rows.length === 0;
            const free = statuses.filter((s) => !rows.some((r) => Number(r.funnelStatusId) === s.id));
            addBtn.disabled = !free.length;
            addBtn.title = free.length ? '' : 'Все статусы справочника уже названы';
            if (focusLast) {
                const last = tbody.lastElementChild;
                const control = last && last.querySelector('select, input');
                if (control) control.focus();
            }
        }

        function ruleRow(row, index) {
            const tr = el('tr');
            tr.dataset.index = String(index);

            // У ЗАВЕДЁННОЙ СТРОКИ СТАТУС НЕ МЕНЯЕТСЯ, И ЭТО НЕ ЗАПРЕТ РАДИ
            // ЗАПРЕТА. Правило автоперезвона принадлежит статусу — сменить
            // статус значит удалить одно правило и завести другое, а из журнала
            // изменений это читалось бы как «интервал у статуса поменяли». Новая
            // строка выбирает статус списком; заведённая показывает своё имя.
            const statusCell = el('td');
            if (row.id) {
                statusCell.appendChild(el('span', 'ui-table__main', row.statusName));
            } else {
                const free = statuses.filter((s) => s.id === Number(row.funnelStatusId)
                    || !rows.some((r) => Number(r.funnelStatusId) === s.id));
                const control = select(
                    [{ value: '', label: '— выберите статус —' }]
                        .concat(free.map((s) => ({ value: s.id, label: s.statusName }))),
                    row.funnelStatusId, 'Статус', true);
                control.dataset.role = 'status';
                statusCell.appendChild(fieldBox('', control));
            }
            tr.appendChild(statusCell);

            const intervalCell = el('td');
            const intervalInput = input('number', row.intervalMinutes, 'Интервал, минут', true);
            intervalInput.dataset.role = 'interval';
            // Единица стоит в шапке колонки — «Интервал, мин» (К256).
            intervalCell.appendChild(fieldBox('', intervalInput));
            tr.appendChild(intervalCell);

            const limitCell = el('td');
            const limitInput = input('number', row.maxAttempts, 'Предел попыток', true);
            limitInput.dataset.role = 'limit';
            limitCell.appendChild(fieldBox('', limitInput));
            tr.appendChild(limitCell);

            const afterCell = el('td');
            // НЕРАЗМЕЧЕННЫЙ СТАТУС ВИДЕН И ВЫКЛЮЧЕН. Спрятанный читается как
            // «такого статуса нет», и человек пойдёт искать ошибку не туда.
            const afterControl = select(
                [{ value: '', label: '— выберите статус —' }].concat(statuses.map((s) => ({
                    value: s.id,
                    label: s.mark ? s.statusName : `${s.statusName} — не размечен`,
                    disabled: !s.mark
                }))),
                row.afterLimitStatusId, 'Статус после предела', true);
            afterControl.dataset.role = 'after';
            const afterBox = fieldBox('', afterControl);
            const consequence = el('span', 'ui-table__sub');
            afterBox.insertBefore(consequence, afterBox.querySelector('.ui-field__error'));
            const paintConsequence = () => {
                consequence.innerHTML = '';
                const chosen = statuses.find((s) => String(s.id) === afterControl.value);
                if (chosen && chosen.mark) {
                    consequence.appendChild(el('span', 'ui-pill ui-pill--mute', chosen.mark));
                    consequence.appendChild(document.createTextNode(` — ${MARK_TAIL[chosen.mark]}`));
                    return;
                }
                // ПОКА ЦЕЛЕВОЙ НЕ ВЫБРАН, ЯЧЕЙКА ОБЪЯСНЯЕТ, ПОЧЕМУ ПОЛОВИНА
                // СПИСКА ВЫКЛЮЧЕНА (К234). Плашка под таблицей закрывает только
                // случай «не размечен НИ ОДИН»; при половинной разметке новая
                // строка молчала бы, и выключенные пункты выглядели бы поломкой.
                consequence.textContent =
                    'пока статус не размечен, система не знает, кончена ли по нему работа';
            };
            afterControl.addEventListener('change', paintConsequence);
            paintConsequence();
            afterCell.appendChild(afterBox);
            tr.appendChild(afterCell);

            const acts = el('td', 'ui-table__acts');
            const remove = trashButton('Убрать статус');
            remove.addEventListener('click', () => {
                syncRows();
                rows.splice(index, 1);
                renderRows(false);
            });
            acts.appendChild(remove);
            tr.appendChild(acts);
            return tr;
        }

        // Прочитать введённое обратно в модель. Нужно перед каждой перерисовкой:
        // иначе «Убрать строку» стирало бы всё, что человек успел набрать в
        // соседних строках.
        function syncRows() {
            Array.from(tbody.children).forEach((tr, index) => {
                const row = rows[index];
                if (!row) return;
                const statusControl = tr.querySelector('[data-role="status"]');
                if (statusControl) row.funnelStatusId = statusControl.value || null;
                row.intervalMinutes = tr.querySelector('[data-role="interval"]').value;
                row.maxAttempts = tr.querySelector('[data-role="limit"]').value;
                row.afterLimitStatusId = tr.querySelector('[data-role="after"]').value || null;
            });
        }

        addBtn.addEventListener('click', () => {
            syncRows();
            rows.push({ id: null, funnelStatusId: null, statusName: '', intervalMinutes: '', maxAttempts: '', afterLimitStatusId: null });
            renderRows(true);
        });

        renderRows(false);

        async function save() {
            syncRows();
            clearErrors(body);
            let ok = true;

            const from = fromInput.value;
            const to = toInput.value;
            // Окно — пара, и половины окна не бывает; нулевая длина — это
            // «никогда», а не «круглые сутки» (ответ куратора 32).
            if (!from) { markError(fromInput, 'Не задано — без окна система не перезванивает'); ok = false; }
            if (!to) { markError(toInput, 'Не задано — без окна система не перезванивает'); ok = false; }
            if (from && to && from === to) {
                markError(toInput, 'Окно нулевой длины — это «никогда»: время «до» должно отличаться');
                ok = false;
            }

            Array.from(tbody.children).forEach((tr, index) => {
                const row = rows[index];
                const statusControl = tr.querySelector('[data-role="status"]');
                if (statusControl && !row.funnelStatusId) { markError(statusControl, 'Не задан'); ok = false; }
                if (wholeNumber(row.intervalMinutes) === null) {
                    markError(tr.querySelector('[data-role="interval"]'), 'Не задан'); ok = false;
                }
                if (wholeNumber(row.maxAttempts) === null) {
                    markError(tr.querySelector('[data-role="limit"]'), 'Не задан'); ok = false;
                }
                if (!row.afterLimitStatusId) {
                    markError(tr.querySelector('[data-role="after"]'), 'Не задан'); ok = false;
                }
            });

            if (!ok) { focusFirstError(body); return false; }

            try {
                const fresh = await saveAutoRecall(api, {
                    windowFrom: from,
                    windowTo: to,
                    rules: rows.map((r) => ({
                        id: r.id,
                        funnelStatusId: Number(r.funnelStatusId),
                        intervalMinutes: wholeNumber(r.intervalMinutes),
                        maxAttempts: wholeNumber(r.maxAttempts),
                        afterLimitStatusId: Number(r.afterLimitStatusId)
                    }))
                });
                if (!state.alive) return true;
                state.events = fresh;
                render();
                return true;
            } catch (err) {
                return serverRefusal(err);
            }
        }

        modal({
            title: 'Автоперезвон',
            sub: 'Система сама перезванивает по этим статусам',
            body,
            size: 'wide',
            onSave: save
        });
    }

    // ---------------------------------------------------------- окно «Перевод»

    function openTransferWindow() {
        const data = state.events.transfer;
        const offers = (data.offers || []).map((r) => ({ ...r }));
        const staff = (data.employees || []).map((r) => ({ ...r }));

        const body = el('div', 'zv-list');

        // ДВА ПЕРЕЧНЯ ВИДНЫ СРАЗУ, ни вкладок, ни переключателя. Экран
        // существует ради ответа «что система делает сама»; вкладка прячет
        // половину ответа, и настроивший офферы не узнает, что переводы на
        // своих не настроены вовсе.
        body.appendChild(listHead('Офферы',
            'перевод партнёру на внешний номер · порядок по приоритету оффера'));
        const offerList = el('div', 'zv-list');
        body.appendChild(offerList);
        const addOffer = button('ui-btn ui-btn--ghost ui-btn--add', 'Добавить оффер', 'plus');
        body.appendChild(addOffer);

        body.appendChild(listHead('Сотрудники',
            'перевод внутрь, на внутренний номер · ожидание своё у каждой строки'));
        const staffList = el('div', 'zv-list');
        body.appendChild(staffList);
        const addStaff = button('ui-btn ui-btn--ghost ui-btn--add', 'Добавить сотрудника', 'plus');
        body.appendChild(addStaff);

        function listHead(name, sub) {
            const head = el('div', 'zv-listhead');
            head.appendChild(el('b', '', name));
            head.appendChild(el('span', 'ui-table__muted', sub));
            return head;
        }

        function renderAll(focus) {
            syncOffers();
            syncStaff();
            offerList.innerHTML = '';
            offers.forEach((row, index) => offerList.appendChild(offerRow(row, index)));
            staffList.innerHTML = '';
            staff.forEach((row, index) => staffList.appendChild(staffRow(row, index)));

            const freeOffers = state.dirs.offers.filter((o) => !offers.some((r) => Number(r.offerId) === o.id));
            addOffer.disabled = !freeOffers.length;
            addOffer.title = freeOffers.length ? '' : 'Все офферы уже названы: одна строка на оффер, второй быть не может';
            const freeStaff = state.dirs.employees.filter((e) => !staff.some((r) => Number(r.employeeId) === e.id));
            addStaff.disabled = !freeStaff.length;
            addStaff.title = freeStaff.length ? ''
                : 'Свободных сотрудников с внутренним номером нет';

            if (focus === 'offer') focusNew(offerList);
            if (focus === 'staff') focusNew(staffList);
        }

        function focusNew(list) {
            const last = list.lastElementChild;
            // ВЫКЛЮЧАТЕЛЬ И ЧИПЫ ДНЕЙ ПРОПУСКАЮТСЯ. У строки оффера первым
            // органом управления теперь идёт «Включена»: оффер строке даёт окно
            // выбора (К255), и своего списка у неё больше нет. Фокус на
            // выключателе означал бы «начните с того, чтобы её выключить».
            const control = last && last.querySelector('select, input:not([type="checkbox"])');
            if (control) control.focus();
        }

        // ПОЧЕМУ СТРОКА ВИДНА И НЕ РАБОТАЕТ — НАЗЫВАЕТСЯ ВСЕГДА. Серая строка
        // без объяснения — это загадка: человек не знает, чинить ему оффер,
        // номер или расписание. И строка НЕ ИСЧЕЗАЕТ: исчезнувшая читается как
        // «я её не заводил», и человек заведёт вторую.
        function blockNote(row, kind) {
            if (!row.blockedReason) return null;
            if (kind === 'offer') {
                if (row.blockedReason === 'expired') {
                    return note(`Строка не работает: оффер закончился ${dateLabel(row.dateEnd)}. `
                        + 'Настройки сохранены — продлите оффер в «CPA-сетях», и перевод заработает снова.',
                    { kind: 'warn' });
                }
                // ПОДПИСЬ, А НЕ КЛЮЧ КОЛОНКИ (К229). Плашка отправляет человека
                // в «CPA-сети», а там это состояние называется «На паузе», а не
                // «paused»: он придёт искать слово, которого там нет. Подпись
                // считает сервер по общему перечню — второй список подписей на
                // экране был бы ровно К36.
                return note(`Строка не работает: оффер не активен — ${row.offerStatusLabel}. `
                    + 'Настройки сохранены — включите оффер в «CPA-сетях», и перевод заработает снова.',
                { kind: 'warn' });
            }
            if (row.blockedReason === 'no_extension') {
                return note('Строка не работает: у сотрудника нет внутреннего номера. '
                    + 'Переводить некуда, пока номер не заведут в карточке сотрудника.', { kind: 'warn' });
            }
            return note('Строка не работает: сотрудник выведен из работы. '
                + 'Переводить некому, пока его не вернут в «Сотрудниках».', { kind: 'warn' });
        }

        function rowHead(main, sub, enabled, onRemove, removeLabel) {
            const head = el('div', 'zv-row__head');
            const who = el('div');
            if (typeof main === 'string') who.appendChild(el('span', 'ui-table__main', main));
            else who.appendChild(main);
            if (sub) who.appendChild(el('span', 'ui-table__sub', sub));
            head.appendChild(who);
            head.appendChild(enabledChip(enabled));
            const remove = trashButton(removeLabel);
            remove.addEventListener('click', onRemove);
            head.appendChild(remove);
            return head;
        }

        function offerRow(row, index) {
            const box = el('div', `zv-row${row.enabled ? '' : ' zv-row--off'}`);
            box.dataset.index = String(index);

            // ОФФЕР В СТРОКЕ УЖЕ НАЗВАН И БОЛЬШЕ НЕ МЕНЯЕТСЯ (К255, паспорт Р12).
            // Выпадающего списка здесь нет ни у сохранённой строки, ни у только
            // что заведённой: выбор целиком переехал в окно «Добавить офферы»,
            // где есть поиск и где держится правило «одна сеть». Оставь список
            // в строке — и у одного и того же выбора стало бы два входа, а
            // правило стерегло бы только один из них. Чтобы сменить оффер,
            // строку убирают и заводят заново.
            //
            // Приоритет в подстроке объясняет порядок строк — без него порядок
            // выглядит случайным. Пустой приоритет не выдумываем: миграция
            // `2026-08-28-offer-priority-fill` заполнила прежние единицей, но
            // колонку оставила необязательной, и у нового оффера он может быть
            // пуст.
            const sub = row.priority === null || row.priority === undefined
                ? row.networkName
                : `${row.networkName} · приоритет ${row.priority}`;
            box.appendChild(rowHead(row.offerName, sub, row.enabled, () => {
                syncOffers();
                offers.splice(index, 1);
                renderAll(null);
            }, 'Убрать строку'));

            const blocked = blockNote(row, 'offer');
            if (blocked) box.appendChild(blocked);

            const grid = el('div', 'ui-form-grid');
            const phone = input('text', row.transferPhone || '', 'Номер для перевода');
            phone.dataset.role = 'phone';
            // ПОЛЕ С ПОДСКАЗКОЙ ЗАНИМАЕТ СТРОКУ СЕТКИ ЦЕЛИКОМ (К232) — то же
            // правило, что в «CPA-сетях» (`cpaApp.js`, `wide` по умолчанию).
            // ⚠ Прежний довод — «сетка равняет по низу, и без `--wide` соседнее
            // „Разрешён с“ уезжает на 54 px ниже» — СНЯТ К253: сетка равняет по
            // верху (`field.css:297`). Само `--wide` остаётся, и по своим
            // причинам: подсказка укладывается в одну строку и не удлиняет
            // окно, а пара «Разрешён с … до» встаёт в одну строку рядом.
            //
            // Про московское время здесь больше не сказано: фраза повторялась
            // столько раз, сколько заведено офферов. Часовой пояс — свойство
            // окна, и живёт он теперь подписью под заголовком.
            grid.appendChild(fieldBox('Номер для перевода', phone, {
                required: true,
                wide: true,
                // Дословный текст паспорта («внутренний номер конкретного
                // оператора») остался от редакции 1, когда перевод был только
                // внутренним, и противоречит телу того же паспорта. Дизайн-сессия
                // приняла эту замену и переиздаёт таблицу текстов (К230).
                hint: 'Внешний номер партнёра — городской или мобильный.'
            }));
            const from = input('time', row.timeFrom || '', 'Разрешён с');
            from.dataset.role = 'from';
            grid.appendChild(fieldBox('Разрешён с', from, { required: true }));
            const to = input('time', row.timeTo || '', 'Разрешён до');
            to.dataset.role = 'to';
            grid.appendChild(fieldBox('до', to, { required: true }));
            const wait = input('number', row.waitSeconds, 'Ожидание, секунд');
            wait.dataset.role = 'wait';
            // ПОЛЕ УЗКОЕ (К255, макет редакции 2). Ожидание принимает 1..3600 —
            // так его и проверяет сервер, `wholeNumber(row.waitSeconds, 1, 3600)`
            // в `routes/callEvents.js`, — то есть не больше четырёх знаков, а
            // занимало оно всю ячейку сетки: ровно тот случай, ради которого
            // К253 и завела `.ui-field--short`. Ячейка при этом не сужается —
            // сужается только орган управления, и раскладка не едет.
            grid.appendChild(fieldBox('Ожидание', withUnit(wait, 'секунд'), { required: true, short: true }));
            const days = daysRow(row.weekdays);
            days.dataset.role = 'days';
            grid.appendChild(fieldBox('Дни недели', days, { required: true, wide: true }));
            box.appendChild(grid);
            return box;
        }

        function staffRow(row, index) {
            const box = el('div', `zv-row${row.enabled ? '' : ' zv-row--off'}`);
            box.dataset.index = String(index);

            let main;
            let sub = '';
            if (row.id) {
                main = row.fullName;
                sub = row.extension ? `доб. ${row.extension}` : 'внутренний номер снят';
            } else {
                const free = state.dirs.employees.filter((e) => e.id === Number(row.employeeId)
                    || !staff.some((r) => Number(r.employeeId) === e.id));
                const control = select(
                    [{ value: '', label: '— выберите сотрудника —' }].concat(free.map((e) => ({
                        value: e.id,
                        label: `${e.fullName} · доб. ${e.extension}`
                    }))),
                    row.employeeId, 'Сотрудник');
                control.dataset.role = 'employee';
                main = fieldBox('', control);
            }
            box.appendChild(rowHead(main, sub, row.enabled, () => {
                syncStaff();
                staff.splice(index, 1);
                renderAll(null);
            }, 'Убрать строку'));

            const blocked = blockNote(row, 'employee');
            if (blocked) box.appendChild(blocked);

            const grid = el('div', 'ui-form-grid');
            const from = input('time', row.timeFrom || '', 'Разрешён с');
            from.dataset.role = 'from';
            grid.appendChild(fieldBox('Разрешён с', from, { required: true }));
            const to = input('time', row.timeTo || '', 'Разрешён до');
            to.dataset.role = 'to';
            grid.appendChild(fieldBox('до', to, { required: true }));
            // ОЖИДАНИЕ — ТАКОЕ ЖЕ ПОЛЕ, ЧТО У ОФФЕРА, и стоит на том же месте
            // ряда: решение владельца 109 (К259). Одно правило на оба перечня —
            // иначе одно и то же число набирается в двух разных видах.
            const wait = input('number', row.waitSeconds, 'Ожидание, секунд');
            wait.dataset.role = 'wait';
            // Узкое — как у оффера. Одно правило на оба перечня: иначе одно и
            // то же число набирается в двух разных видах.
            grid.appendChild(fieldBox('Ожидание', withUnit(wait, 'секунд'), { required: true, short: true }));
            const days = daysRow(row.weekdays);
            days.dataset.role = 'days';
            grid.appendChild(fieldBox('Дни недели', days, { required: true, wide: true }));
            box.appendChild(grid);
            return box;
        }

        // ------------------------------------------- окно «Добавить офферы»
        //
        // Решение владельца 108, К255, макет `4733e795`. Офферов у сети десятки,
        // а настройка у них одна и та же — заводить их по одному значит набрать
        // одно и то же пять раз подряд.
        //
        // «ОДНА СЕТЬ» ДЕРЖИТСЯ СУЖЕНИЕМ, А НЕ ОТКАЗОМ. Пока не отмечен ни один
        // оффер — видны все свободные; отмечен первый — офферы чужих сетей
        // ОСТАЮТСЯ ВИДИМЫМИ и выключаются, а причина стоит в самой строке.
        // Прятать их нельзя по тому же правилу, по которому в «Автоперезвоне»
        // неразмеченный статус остаётся в списке выключенным: спрятанный пункт
        // читается как «такого оффера нет», и человек идёт искать ошибку не туда.
        // Отказ после нажатия отпадает по другой причине: он наказывал бы за
        // действие, которое форма сама позволила совершить.
        //
        // СЕТИ СРАВНИВАЮТСЯ ПО НОМЕРУ, А НЕ ПО ИМЕНИ: `cpa_networks` объявлена
        // без `UNIQUE` на `name` (`schema.sql:401-409`), и две одноимённые сети
        // слились бы в одну молча.
        //
        // Серверной проверки «одна сеть» здесь нет намеренно: решение владельца
        // 108 говорит «запрещается ФОРМОЙ», а правило, выразимое на данных
        // («один номер перевода — одна сеть»), шире решения и отбивало бы ещё и
        // ручной ввод номера в строке перечня. Оно заведено отдельным предметом
        // — К265, вместе со своим местом на экране.
        function openOffersPick() {
            // Свободные — те, которых в перечне ещё нет. Порядок берётся у
            // справочника (приоритет по возрастанию, затем номер записи) и здесь
            // не переставляется: тот же порядок, что у строк перечня.
            const free = state.dirs.offers.filter((o) => !offers.some((r) => Number(r.offerId) === o.id));
            const picked = new Set();

            const body = el('div');

            const search = input('search', '', 'Поиск офферов');
            search.placeholder = 'Найти оффер по названию…';
            search.addEventListener('input', () => { renderList(); syncPick(); });
            body.appendChild(fieldBox('', search, {
                hint: 'Офферы одной сети: номер для перевода — это номер партнёра, '
                    + 'и общий номер у чужих друг другу офферов означал бы перевод не туда.'
            }));

            const listBox = el('div');
            body.appendChild(listBox);

            const countNote = el('p', 'ui-table-note');
            body.appendChild(countNote);

            // НАСТРОЙКИ СОБИРАЮТСЯ ОДИН РАЗ И ДАЛЬШЕ ТОЛЬКО ПРЯЧУТСЯ. Пересобери
            // их при каждой отметке — и набранный номер пропадал бы от лишней
            // галочки.
            const grid = el('div', 'ui-form-grid');
            const phone = input('text', '', 'Номер для перевода');
            phone.dataset.role = 'phone';
            grid.appendChild(fieldBox('Номер для перевода', phone, {
                required: true,
                wide: true,
                hint: 'Внешний номер партнёра — городской или мобильный.'
            }));
            const from = input('time', '', 'Разрешён с');
            from.dataset.role = 'from';
            grid.appendChild(fieldBox('Разрешён с', from, { required: true }));
            const to = input('time', '', 'Разрешён до');
            to.dataset.role = 'to';
            grid.appendChild(fieldBox('до', to, { required: true }));
            const wait = input('number', '', 'Ожидание, секунд');
            wait.dataset.role = 'wait';
            // ТРЕТЬЕ МЕСТО ОДНОГО ПОЛЯ, и узкое оно здесь по той же причине.
            // Сузить только в строке перечня значило бы развести одно поле
            // одного события по двум окнам: до сужения оно стояло 265,8 в
            // строке и 282,8 здесь — 17 px разницы, измеренных, а не
            // предположенных (дизайн-сессия, 30.08.2026).
            grid.appendChild(fieldBox('Ожидание', withUnit(wait, 'секунд'), { required: true, short: true }));
            const days = daysRow([]);
            days.dataset.role = 'days';
            grid.appendChild(fieldBox('Дни недели', days, { required: true, wide: true }));
            body.appendChild(grid);

            const noteBox = el('div');
            body.appendChild(noteBox);

            /** Сеть выбора: её задаёт первый отмеченный оффер. */
            function pickedNetwork() {
                for (const o of free) if (picked.has(o.id)) return o.networkId;
                return null;
            }

            function pickedName() {
                for (const o of free) if (picked.has(o.id)) return o.networkName;
                return '';
            }

            function renderList() {
                listBox.innerHTML = '';
                const query = search.value.trim().toLowerCase();
                // ПО НАЗВАНИЮ, И ТОЛЬКО ПО НЕМУ: поле обещает «Найти оффер по
                // названию…», а обещание поля — договор. Подстрока с первого
                // знака, без учёта регистра — как в «CPA-сетях», откуда офферы
                // и приходят (`cpaApp.js:263-264`): порог в два-три знака нужен
                // там, где запрос дорог, а список уже в руках экрана.
                const shown = query
                    ? free.filter((o) => o.name.toLowerCase().includes(query))
                    : free.slice();
                if (!shown.length) { listBox.appendChild(nothingFound()); return; }

                const wrap = el('div', 'ui-table-wrap');
                const table = el('table', 'ui-table');
                const head = el('tr');
                head.appendChild(el('th', 'ui-table__sel'));
                head.appendChild(el('th', '', 'Оффер'));
                // Приоритет — ОТДЕЛЬНОЙ КОЛОНКОЙ, а не припиской к имени: по
                // нему сравнивают строки глазами, а приписка в конце строки для
                // сравнения не годится.
                const priorityHead = el('th', '', 'Приоритет');
                priorityHead.style.width = '104px';
                head.appendChild(priorityHead);
                const thead = el('thead');
                thead.appendChild(head);
                table.appendChild(thead);

                const tbody = el('tbody');
                shown.forEach((o) => tbody.appendChild(pickRow(o)));
                table.appendChild(tbody);
                wrap.appendChild(table);
                listBox.appendChild(wrap);
            }

            function pickRow(offer) {
                const net = pickedNetwork();
                const other = net !== null && offer.networkId !== net;
                const on = picked.has(offer.id);
                const tr = el('tr', on ? 'ui-table__row--selected' : '');

                const sel = el('td', 'ui-table__sel');
                const box = el('input');
                box.type = 'checkbox';
                box.checked = on;
                box.disabled = other;
                box.dataset.offer = String(offer.id);
                box.setAttribute('aria-label', other ? `${offer.name} — другая сеть` : offer.name);
                box.addEventListener('change', () => {
                    if (box.checked) picked.add(offer.id); else picked.delete(offer.id);
                    renderList();
                    syncPick();
                });
                sel.appendChild(box);

                const who = el('td');
                who.appendChild(el('span', `ui-table__main${other ? ' ui-table__muted' : ''}`, offer.name));
                const sub = el('span', 'ui-table__sub');
                if (other) {
                    // ПРИЧИНА СТОИТ В САМОЙ СТРОКЕ, а не только в подсказке под
                    // таблицей: человек читает ту строку, на которую смотрит.
                    sub.appendChild(document.createTextNode(`${offer.networkName} — `));
                    sub.appendChild(el('b', '', 'другая сеть'));
                } else {
                    sub.textContent = offer.networkName;
                }
                who.appendChild(sub);

                const priority = el('td', `ui-table__num${other ? ' ui-table__muted' : ''}`);
                if (offer.priority === null || offer.priority === undefined) {
                    priority.appendChild(el('span', 'ui-dash', '—'));
                } else {
                    priority.textContent = String(offer.priority);
                }

                tr.append(sel, who, priority);
                return tr;
            }

            function nothingFound() {
                const box = el('div', 'ui-empty');
                const icon = el('span', 'ui-empty__icon');
                icon.appendChild(iconNode('search', 'lg'));
                box.appendChild(icon);
                box.appendChild(el('b', 'ui-empty__title', 'Ничего не найдено по запросу'));
                box.appendChild(el('span', 'ui-empty__text',
                    'Проверьте написание или очистите поиск — свободные офферы есть, '
                    + 'просто не по этому запросу.'));
                const clear = button('ui-btn ui-btn--ghost ui-empty__action', 'Очистить поиск');
                // Сбрасывается ТОЛЬКО поиск. Отметки остаются: выбор поиском не
                // делался, и снимать его чужой кнопкой нельзя.
                clear.addEventListener('click', () => {
                    search.value = '';
                    renderList();
                    syncPick();
                    search.focus();
                });
                box.appendChild(clear);
                return box;
            }

            // Счётчик, настройки, плашка и кнопка подвала — всё считается от
            // одного числа, поэтому и обновляется одним местом.
            function syncPick() {
                const n = picked.size;
                countNote.innerHTML = '';
                countNote.appendChild(document.createTextNode('Выбрано: '));
                countNote.appendChild(el('b', '', String(n)));
                if (n === 0) {
                    // Строка предупреждает ЗАРАНЕЕ: поле, появляющееся без
                    // предупреждения, читается как сбой.
                    countNote.appendChild(document.createTextNode(
                        '. Отметьте офферы — настройки появятся ниже.'));
                } else if (n === 1) {
                    countNote.appendChild(document.createTextNode(` · сеть «${pickedName()}».`));
                } else {
                    countNote.appendChild(document.createTextNode(
                        ` · все из сети «${pickedName()}». Офферы других сетей выключены, `
                        + 'пока выбор не сброшен.'));
                }

                // Настроек без адресатов не бывает, а погашенная форма из шести
                // полей читается как поломка.
                grid.hidden = n === 0;

                noteBox.innerHTML = '';
                // При одном выбранном плашка врала бы про «все».
                if (n >= 2) {
                    noteBox.appendChild(note(
                        `Появятся ${n} ${plural(n, 'отдельная строка', 'отдельные строки', 'отдельных строк')}`
                        + ' — по одной на оффер. После сохранения каждая правится сама: '
                        + 'правка одной остальных не трогает.',
                        { title: `Настройки лягут на все ${n} ${plural(n, 'строку', 'строки', 'строк')}` }));
                }

                if (addBtn) {
                    // Число в кнопке — цифрой, как в счётчике над ней: слово в
                    // одном месте окна и цифра в другом это разнобой внутри
                    // одного окна.
                    addBtn.textContent = n ? `Добавить (${n})` : 'Добавить';
                    addBtn.disabled = n === 0;
                }
            }

            // ПРОВЕРКА СТОИТ ЗДЕСЬ, а не только при сохранении «Перевода».
            // Пустить незаполненные значит привезти N негодных строк разом:
            // «общие настройки» превратятся в «общую ошибку на N строк», и
            // чинить её придётся по одной — ровно против того, ради чего
            // множественный выбор и заводится. Тексты те же, что у строки
            // перечня: одно правило — один текст.
            function addPicked() {
                clearErrors(body);
                const draft = {
                    transferPhone: phone.value,
                    timeFrom: from.value,
                    timeTo: to.value,
                    waitSeconds: wait.value,
                    weekdays: readDays(days)
                };
                let ok = true;
                if (!String(draft.transferPhone).trim()) {
                    markError(phone, 'Укажите номер для перевода: без него перевод не сработает');
                    ok = false;
                }
                if (wholeNumber(draft.waitSeconds) === null) {
                    markError(wait, 'Не задано');
                    ok = false;
                }
                if (!checkTimes(grid, draft)) ok = false;
                if (!ok) { focusFirstError(body); return false; }

                // ЗАВОДЯТСЯ N САМОСТОЯТЕЛЬНЫХ СТРОК, а не одна на несколько
                // офферов: `call_transfer_offers.offer_id` объявлен
                // `NOT NULL UNIQUE` (`schema.sql:2706`), и сущности «группа» в
                // данных нет. Множественный выбор — способ завести N строк
                // одинаково, а не связь между ними.
                free.filter((o) => picked.has(o.id)).forEach((offer) => {
                    offers.push({
                        id: null,
                        offerId: offer.id,
                        offerName: offer.name,
                        networkName: offer.networkName,
                        priority: offer.priority,
                        transferPhone: draft.transferPhone,
                        weekdays: draft.weekdays,
                        timeFrom: draft.timeFrom,
                        timeTo: draft.timeTo,
                        waitSeconds: draft.waitSeconds,
                        enabled: true,
                        blockedReason: null
                    });
                });
                renderAll('offer');
                return true;
            }

            pickWindow = openModal({
                title: 'Добавить офферы',
                sub: 'Настройки лягут на все выбранные. После сохранения каждая строка правится сама',
                body,
                scope,
                size: 'wide',
                // Та же дверь на ключе, что у окна события, и тем же доводом:
                // цена промаха мимо окна равна всему вводу. Здесь она выше —
                // окно стоит ПОВЕРХ «Перевода», и две разные двери у двух окон
                // одного события были бы разнобоем.
                scrimClose: false,
                actions: [
                    { label: 'Отмена', variant: 'ghost', value: false },
                    { label: 'Добавить', role: 'add', onClick: addPicked }
                ]
            });
            const addBtn = pickWindow.box.querySelector('[data-role="add"]');
            pickWindow.result.then(() => { pickWindow = null; });

            renderList();
            syncPick();
        }

        function syncOffers() {
            Array.from(offerList.children).forEach((node, index) => {
                const row = offers[index];
                if (!row) return;
                // `offerId` отсюда не читается: оффер строке даёт окно выбора и
                // после этого он не правится (К255). Читать нечего — органа
                // управления для него в строке нет.
                row.transferPhone = node.querySelector('[data-role="phone"]').value;
                row.timeFrom = node.querySelector('[data-role="from"]').value;
                row.timeTo = node.querySelector('[data-role="to"]').value;
                row.waitSeconds = node.querySelector('[data-role="wait"]').value;
                row.weekdays = readDays(node.querySelector('[data-role="days"]'));
                row.enabled = node.querySelector('[data-role="row-enabled"]').checked;
            });
        }

        function syncStaff() {
            Array.from(staffList.children).forEach((node, index) => {
                const row = staff[index];
                if (!row) return;
                const picker = node.querySelector('[data-role="employee"]');
                if (picker) row.employeeId = picker.value || null;
                row.timeFrom = node.querySelector('[data-role="from"]').value;
                row.timeTo = node.querySelector('[data-role="to"]').value;
                row.waitSeconds = node.querySelector('[data-role="wait"]').value;
                row.weekdays = readDays(node.querySelector('[data-role="days"]'));
                row.enabled = node.querySelector('[data-role="row-enabled"]').checked;
            });
        }

        addOffer.addEventListener('click', openOffersPick);
        addStaff.addEventListener('click', () => {
            staff.push({
                id: null, employeeId: null, weekdays: [],
                timeFrom: '', timeTo: '', waitSeconds: '', enabled: true, blockedReason: null
            });
            renderAll('staff');
        });

        renderAll(null);

        function checkTimes(node, row) {
            let ok = true;
            if (!row.timeFrom) { markError(node.querySelector('[data-role="from"]'), 'Не задано'); ok = false; }
            if (!row.timeTo) { markError(node.querySelector('[data-role="to"]'), 'Не задано'); ok = false; }
            if (row.timeFrom && row.timeTo && row.timeFrom === row.timeTo) {
                markError(node.querySelector('[data-role="to"]'),
                    'Окно нулевой длины — это «никогда»: время «до» должно отличаться');
                ok = false;
            }
            if (!row.weekdays.length) {
                markError(node.querySelector('[data-role="days"]'),
                    'Отметьте хотя бы один день — иначе перевод не работает никогда');
                ok = false;
            }
            return ok;
        }

        async function save() {
            syncOffers();
            syncStaff();
            clearErrors(body);
            let ok = true;

            Array.from(offerList.children).forEach((node, index) => {
                const row = offers[index];
                if (!String(row.transferPhone || '').trim()) {
                    markError(node.querySelector('[data-role="phone"]'),
                        'Укажите номер для перевода: без него перевод не сработает');
                    ok = false;
                }
                if (wholeNumber(row.waitSeconds) === null) {
                    markError(node.querySelector('[data-role="wait"]'), 'Не задано'); ok = false;
                }
                if (!checkTimes(node, row)) ok = false;
            });
            // ⚠⚠ ОДНА СЕТЬ НА НОМЕР — ПРАВИЛО ДАННЫХ (К265, решение владельца 118).
            //
            // Тот же запрет стоит на сервере и отбивает любой путь, включая
            // запрос мимо экрана; здесь он повторён по правилу проекта «всё,
            // что сервер отбивает, экран проверяет сам».
            //
            // ⚠ ЭТО НЕ ТО ЖЕ, ЧТО ЗАПРЕТ ОКНА ВЫБОРА. Тот не даёт отметить
            // офферы разных сетей В ОДНОМ выборе (`pickedNetwork` ниже) и
            // ДВУХ ДЫР НЕ ЗАКРЫВАЕТ: два раздельных выбора с одним номером и
            // правку номера в уже стоящей строке. Снятие того запрета — К309,
            // отдельная работа: правка видна глазом, а видимое решает владелец.
            //
            // ⚠ ВЫКЛЮЧЕННЫЕ СТРОКИ ПРОВЕРЯЮТСЯ НАРАВНЕ: номер в них лежит, и
            // включат — нарушение оживёт молча.
            //
            // Сеть берётся из СПРАВОЧНИКА по `offerId`, а не из строки перечня:
            // в строке едет только имя сети, а имена сетей не уникальны
            // (`schema.sql`, `cpa_networks.name` без UNIQUE). Второго источника
            // одного факта не заводим — через месяц они разойдутся.
            const netById = new Map(state.dirs.offers.map((o) => [o.id, o]));
            const firstByPhone = new Map();
            Array.from(offerList.children).forEach((node, index) => {
                const row = offers[index];
                const own = netById.get(Number(row.offerId));
                const key = phoneKey(row.transferPhone);
                // Пустой номер уже отбит выше своим отказом — второй поверх
                // него назвал бы человеку не ту причину.
                if (!own || !key) return;
                const seen = firstByPhone.get(key);
                if (!seen) { firstByPhone.set(key, own); return; }
                if (seen.networkId === own.networkId) return;
                // Метятся ВСЕ нарушающие строки, фокус уйдёт на первую — ровно
                // как у остальных полей окна: человек чинит одну и сразу видит,
                // сколько осталось.
                markError(node.querySelector('[data-role="phone"]'), oneNetworkError(seen.networkName));
                ok = false;
            });

            Array.from(staffList.children).forEach((node, index) => {
                const row = staff[index];
                const picker = node.querySelector('[data-role="employee"]');
                if (picker && !row.employeeId) { markError(picker, 'Не задан'); ok = false; }
                if (wholeNumber(row.waitSeconds) === null) {
                    markError(node.querySelector('[data-role="wait"]'), 'Не задано'); ok = false;
                }
                if (!checkTimes(node, row)) ok = false;
            });

            if (!ok) { focusFirstError(body); return false; }

            try {
                const fresh = await saveTransfer(api, {
                    offers: offers.map((r) => ({
                        id: r.id,
                        offerId: Number(r.offerId),
                        transferPhone: r.transferPhone,
                        weekdays: r.weekdays,
                        timeFrom: r.timeFrom,
                        timeTo: r.timeTo,
                        waitSeconds: wholeNumber(r.waitSeconds),
                        enabled: r.enabled
                    })),
                    employees: staff.map((r) => ({
                        id: r.id,
                        employeeId: Number(r.employeeId),
                        weekdays: r.weekdays,
                        timeFrom: r.timeFrom,
                        timeTo: r.timeTo,
                        waitSeconds: wholeNumber(r.waitSeconds),
                        enabled: r.enabled
                    }))
                });
                if (!state.alive) return true;
                state.events = fresh;
                render();
                return true;
            } catch (err) {
                return serverRefusal(err);
            }
        }

        modal({
            title: 'Перевод',
            // Часовой пояс сказан ОДИН РАЗ НА ОКНО (К232), а не в каждой строке
            // перечня: это свойство всего времени в окне, а не отдельного поля.
            sub: 'Кому оператор может передать лида и в какое время. '
                + 'Время московское — для всех, включая тех, кто работает не из Москвы.',
            body,
            size: 'wide',
            onSave: save
        });
    }

    // ----------------------------------------------------- окно «Пост-обработка»

    function openWrapupWindow() {
        const data = state.events.wrapup;
        const rows = (data.pairs || []).map((p) => ({ ...p }));

        const body = el('div', 'zv-recall');

        // ЦЕЛЕВОЙ СТАТУС ТАЙМ-АУТА — СТРОКОЙ, А НЕ ВЫБОРОМ (паспорт Р12
        // редакции 5). Он один на всё событие, как рабочее окно у
        // «Автоперезвона», и стоит над таблицей пар.
        //
        // ПОЧЕМУ НЕ СПИСОК. Список сказал бы «это можно менять», а менять это
        // сегодня нельзя ничем, кроме выкатки; погашенный список сказал бы то
        // же самое и добавил вопрос «почему не работает». Строка не обещает
        // ничего.
        const statusBox = el('div', 'ui-field');
        statusBox.appendChild(el('label', 'ui-field__label', 'Статус после тайм-аута'));
        statusBox.appendChild(el('span', 'ui-table__main', data.statusName || 'не задан'));
        // Пусто бывает только на базе, где выкатка захода 6 ещё не прошла:
        // засев ставит статус вместе с самим событием. Текст пустого случая
        // написан по описанию паспорта — дословной строки для него там нет.
        statusBox.appendChild(el('span', 'ui-table__sub', data.statusName
            ? 'его ставит система карточке, закрытой по времени; выбрать другой нельзя — статус задаётся выкаткой'
            : 'статус не задан выкаткой: карточка всё равно закроется, но со своим прежним статусом'));
        body.appendChild(statusBox);

        const wrap = el('div', 'ui-table-wrap');
        const table = el('table', 'ui-table ui-table--fields zv-fixed');
        // Ширины — та же К231. «Скрипт» забирает остаток: он единственное место
        // строки, где лежит длинный текст, а без правила ему доставалось ровно
        // столько же, сколько полю на две цифры.
        //
        // К254: «сек» ушло из ячейки в шапку колонки — решение владельца.
        // Подпись рядом с полем не давала полю сжаться, и число вылезало из
        // ячейки на 36 px. Колонка 140, а не 136: шапка «ДЛИТЕЛЬНОСТЬ, СЕК» —
        // 113,4 px текста, а `.ui-table th` запрещает перенос, и 136 прошло бы
        // впритык, без запаса на другой шрифт.
        table.innerHTML = '<thead><tr><th style="width:190px">Линия</th><th>Скрипт</th>'
            + '<th style="width:140px">Длительность, сек</th>'
            + '<th class="ui-table__acts" style="width:54px"></th></tr></thead>';
        const tbody = el('tbody');
        table.appendChild(tbody);
        wrap.appendChild(table);
        body.appendChild(wrap);

        const addBtn = button('ui-btn ui-btn--ghost ui-btn--add', 'Добавить пару', 'plus');
        body.appendChild(addBtn);

        body.appendChild(note(
            'Оператор остаётся в ней, пока не вернётся на линию сам. Это законное состояние, а не '
            + 'поломка: пока пара не названа, системе нечего отсчитывать.',
            { title: 'Для пар, которых здесь нет, пост-обработка не кончается сама' }));

        // ЛИНИЯ И СКРИПТ ПРАВЯТСЯ У ЛЮБОЙ СТРОКИ, в отличие от статуса в
        // автоперезвоне. Разница не в прихоти: правило автоперезвона
        // ПРИНАДЛЕЖИТ статусу — у него на статусе стоит запрет в базе; пара
        // «линия + скрипт» — это просто условие срабатывания, и поправить
        // опечатку в ней естественно.
        function pairRow(row, index) {
            const tr = el('tr');
            const lineCell = el('td');
            const line = select(
                [{ value: '', label: '— выберите линию —' }]
                    .concat(LINE_TYPES.map((t) => ({ value: t, label: t }))),
                row.lineType, 'Линия', true);
            line.dataset.role = 'line';
            lineCell.appendChild(fieldBox('', line));
            tr.appendChild(lineCell);

            const scriptCell = el('td');
            const script = select(
                [{ value: '', label: '— выберите скрипт —' }]
                    .concat(state.dirs.scripts.map((s) => ({ value: s.id, label: s.title }))),
                row.scriptId, 'Скрипт', true);
            script.dataset.role = 'script';
            scriptCell.appendChild(fieldBox('', script));
            tr.appendChild(scriptCell);

            const secondsCell = el('td');
            const seconds = input('number', row.durationSeconds, 'Длительность, секунд', true);
            seconds.dataset.role = 'seconds';
            // Единица стоит в шапке колонки — «Длительность, сек» (К254).
            secondsCell.appendChild(fieldBox('', seconds));
            tr.appendChild(secondsCell);

            const acts = el('td', 'ui-table__acts');
            const remove = trashButton('Убрать пару');
            remove.addEventListener('click', () => {
                syncRows();
                rows.splice(index, 1);
                renderRows(false);
            });
            acts.appendChild(remove);
            tr.appendChild(acts);
            return tr;
        }

        function syncRows() {
            Array.from(tbody.children).forEach((tr, index) => {
                const row = rows[index];
                if (!row) return;
                row.lineType = tr.querySelector('[data-role="line"]').value || null;
                row.scriptId = tr.querySelector('[data-role="script"]').value || null;
                row.durationSeconds = tr.querySelector('[data-role="seconds"]').value;
            });
        }

        function renderRows(focusLast) {
            tbody.innerHTML = '';
            rows.forEach((row, index) => tbody.appendChild(pairRow(row, index)));
            // Та же К233: пустой перечень показывает одну кнопку, а не шапку
            // «Линия · Скрипт · Длительность» над пустотой.
            wrap.hidden = rows.length === 0;
            addBtn.disabled = !state.dirs.scripts.length;
            addBtn.title = state.dirs.scripts.length ? '' : 'Скриптов в справочнике нет';
            if (focusLast) {
                const control = tbody.lastElementChild && tbody.lastElementChild.querySelector('select');
                if (control) control.focus();
            }
        }

        addBtn.addEventListener('click', () => {
            syncRows();
            rows.push({ id: null, lineType: '', scriptId: null, durationSeconds: '' });
            renderRows(true);
        });

        renderRows(false);

        async function save() {
            syncRows();
            clearErrors(body);
            let ok = true;
            const seen = new Set();
            Array.from(tbody.children).forEach((tr, index) => {
                const row = rows[index];
                if (!row.lineType) { markError(tr.querySelector('[data-role="line"]'), 'Не задана'); ok = false; }
                if (!row.scriptId) { markError(tr.querySelector('[data-role="script"]'), 'Не задан'); ok = false; }
                if (wholeNumber(row.durationSeconds) === null) {
                    markError(tr.querySelector('[data-role="seconds"]'), 'Не задана'); ok = false;
                }
                const key = `${row.lineType}|${row.scriptId}`;
                if (row.lineType && row.scriptId) {
                    if (seen.has(key)) {
                        markError(tr.querySelector('[data-role="script"]'),
                            'Такая пара уже названа выше: одна пара — одна строка');
                        ok = false;
                    }
                    seen.add(key);
                }
            });
            if (!ok) { focusFirstError(body); return false; }

            try {
                const fresh = await saveWrapup(api, {
                    pairs: rows.map((r) => ({
                        id: r.id,
                        lineType: r.lineType,
                        scriptId: Number(r.scriptId),
                        durationSeconds: wholeNumber(r.durationSeconds)
                    }))
                });
                if (!state.alive) return true;
                state.events = fresh;
                render();
                return true;
            } catch (err) {
                return serverRefusal(err);
            }
        }

        modal({
            title: 'Пост-обработка',
            sub: 'Сколько времени у оператора на карточку после разговора',
            body,
            size: 'wide',
            onSave: save
        });
    }

    // ⚠ ОКНА «ВРЕМЯ ПЕРЕВОДА» ЗДЕСЬ БОЛЬШЕ НЕТ (решение владельца 109, К259).
    // Оно правило одно число на все переводы внутрь; теперь ожидание — поле
    // строки сотрудника, и набирается оно там же, где остальные её поля. Вместе
    // с окном ушли его тексты и адрес `PUT /transfer-wait`: одно поле, живущее в
    // двух местах, — это два ответа на один вопрос.

    return {
        load,
        get loaded() { return state.loaded; },
        destroy() {
            state.alive = false;
            // Сначала верхнее, потом нижнее: закрытие возвращает фокус туда,
            // откуда окно открыли, и обратный порядок отправил бы его в уже
            // снятое окно.
            if (pickWindow) pickWindow.close();
            if (openWindow) openWindow.close();
        }
    };
}
