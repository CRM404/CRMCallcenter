// --- Shell/history/historyTable.js: строка журнала, общая на три места -----
//
// ОДИН МОДУЛЬ НА ТРИ МЕСТА (решение куратора, ответ И213): раздел «История
// изменений», вкладка «История» в карточке лида и такая же в карточке
// сотрудника. Показывают они одно и то же под разными углами — разным числом
// колонок, — и три реализации разошлись бы на первой же правке.
//
// Отсюда и место в дереве: `Shell/`, а не в разделе. Раздел монтируется в
// панель, а вкладки живут в чужих карточках — общий код не может лежать ни у
// одного из трёх.
//
// ЧТО ЭТОТ МОДУЛЬ ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ. Делает: строку таблицы, ячейку
// «Что изменилось», разворот и сводку партии. Не делает: запросов, отбора,
// подвала, пустых состояний — это разное у раздела и у вкладки, и общего в них
// только видимость.

import { fieldLabel } from './historyFields.js';

// СТИЛЬ ЖУРНАЛА ПОДТЯГИВАЕТСЯ САМИМ МОДУЛЕМ, и это не удобство, а условие
// работы. Раскладку раздела оболочка грузит при открытии раздела — а две трети
// применений этой строки живут в ЧУЖИХ карточках: в «Лидах» и «Сотрудниках».
// Открыв карточку лида, человек не открывал «Историю изменений», и её файл в
// документ не попадал: строки рисовались бы без единого правила.
//
// Файл один на все три места — тот самый, что объявляет пятнадцать классов
// раздела. Второй копии не заводится: разошлись бы на первой правке.
const STYLES_HREF = '/css/history-light.css';

function ensureStyles() {
    if (document.querySelector(`link[href="${STYLES_HREF}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLES_HREF;
    document.head.appendChild(link);
}

// Первые три поля видны без нажатия (паспорт Р5). Обычная правка — одно-три
// поля; прятать её под кнопку значит заставить нажимать на каждой строке.
const VISIBLE_FIELDS = 3;

// Подписи вида автора. «Указан браузером» и «не указан» — РАЗНЫЕ ВЕЩИ, и путать
// их нельзя: первое значит «кто-то назвался, и мы записали его слова», второе —
// «назваться было некому». Написать первое там, где никто не назывался, значит
// придать журналу достоверность, которой у него нет.
const ACTOR_SUB = {
    browser: 'указан браузером',
    none: 'правка из админки',
    service: 'служебный автор'
};

// ВИД МАССОВОЙ ОПЕРАЦИИ — ИМЯ СЛУЖЕБНОГО АВТОРА строки партии. Паспорт называет
// их прямо: «Импорт · Раздача · Миграция». Подпись партии («Удаление лида
// „P5TEST"») стоит в ячейке «Что изменилось» — ставить её ещё и автором значит
// написать одно и то же дважды в одной строке.
const BATCH_KIND = {
    import: 'Импорт',
    archive: 'Архивация',
    delete: 'Удаление',
    detach: 'Открепление',
    migration: 'Миграция',
    browser: 'Массовое действие'
};

// Разделы оболочки человеческими именами — для колонки «Раздел». Ключ приходит
// из журнала таким, каким его поставил единый транспорт.
const PAGE_LABEL = {
    requisites: 'Реквизиты',
    employees: 'Сотрудники',
    leads: 'Лиды',
    sources: 'Источники',
    cpa: 'CPA-сети',
    scripts: 'Скрипты',
    calls: 'Звонки',
    history: 'История изменений',
    operator: 'Оператор'
};

/**
 * Строка записи и, если есть что разворачивать, строка подробностей следом.
 *
 * @param {Object}   row      строка от сервера
 * @param {Object}   opts
 * @param {string[]} opts.columns  'when' | 'who' | 'page' | 'record' | 'changes'
 * @param {Function} [opts.onCard] (card) => void — переход в карточку записи
 * @param {Function} [opts.onBatch] (batchId) => void — «Показать записи партии»
 * @param {Function} [opts.loadBatch] (batchId) => Promise — сводка партии
 * @returns {HTMLElement[]} одна или две строки
 */
export function renderRow(row, opts) {
    ensureStyles();
    const columns = opts.columns;
    const tr = document.createElement('tr');
    const detailId = `hi-detail-${row.kind}-${row.kind === 'batch' ? row.batchId : row.id}`;

    if (columns.includes('when')) tr.appendChild(whenCell(row));
    if (columns.includes('who')) tr.appendChild(whoCell(row));
    if (columns.includes('page')) tr.appendChild(pageCell(row));
    if (columns.includes('record')) tr.appendChild(recordCell(row, opts));

    const changes = document.createElement('td');
    const box = document.createElement('div');
    box.className = 'hi-changes';
    changes.appendChild(box);
    tr.appendChild(changes);

    const more = buildChanges(box, row, detailId);
    // КНОПКА ВСТАВЛЯЕТСЯ ЗДЕСЬ, а не внутри buildChanges. Первая редакция её
    // только создавала и возвращала — в разметку она не попадала вовсе, и
    // разворачивать было нечем: на экране стояло «Запись создана» без всякого
    // намёка, что за ней есть поля. Поймала проверка в браузере: кнопок ноль
    // при тридцати строках, половина которых — создание.
    if (more) box.appendChild(more);
    const out = [tr];

    if (more) {
        const detail = document.createElement('tr');
        detail.className = 'hi-detail';
        detail.id = detailId;
        detail.hidden = true;
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        detail.appendChild(td);
        out.push(detail);

        more.addEventListener('click', () => toggleDetail(more, detail, row, opts));
    }

    return out;
}

// ---------------------------------------------------------------- ячейки

function whenCell(row) {
    const td = document.createElement('td');
    const d = new Date(row.changedAt);
    td.appendChild(span('ui-table__main', `${pad(d.getHours())}:${pad(d.getMinutes())}`));
    td.appendChild(span('ui-table__sub', `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`));
    return td;
}

function whoCell(row) {
    const td = document.createElement('td');
    const kind = row.actor.kind || 'none';
    if (row.kind === 'batch') {
        td.appendChild(span('ui-table__main', BATCH_KIND[row.batch && row.batch.kind] || 'Массовая операция'));
        td.appendChild(span('ui-table__sub', ACTOR_SUB.service));
        return td;
    }
    if (kind === 'none') {
        // ПРИГЛУШЕНИЕ НА СОДЕРЖИМОМ, А НЕ НА ЯЧЕЙКЕ: `.ui-table td` объявляет
        // цвет и по специфичности отменил бы класс, повешенный на `<td>`. Эта
        // ошибка уже стоила проекту двух корректировок — К199 в «Звонках» и
        // разбора в «Источниках».
        td.appendChild(span('ui-table__muted', 'не указан'));
    } else {
        td.appendChild(span('ui-table__main', row.actor.name || 'без имени'));
    }
    td.appendChild(span('ui-table__sub', ACTOR_SUB[kind] || ACTOR_SUB.none));
    return td;
}

function pageCell(row) {
    const td = document.createElement('td');
    td.className = 'hi-col-page';
    if (row.page) td.textContent = PAGE_LABEL[row.page] || row.page;
    else td.appendChild(span('ui-dash', '—'));
    return td;
}

function recordCell(row, opts) {
    const td = document.createElement('td');

    if (row.kind === 'batch') {
        // У СТРОКИ ПАРТИИ ССЫЛКИ НЕТ. Партия задела тысячи записей — вести
        // некуда, и это не пропуск, а свойство: записи открываются отбором.
        const count = row.batch && row.batch.rows;
        td.appendChild(span('ui-table__main', count ? `${count} ${plural(count, 'запись', 'записи', 'записей')}` : 'массовая операция'));
        if (row.batch && row.batch.fileName) td.appendChild(span('ui-table__sub', row.batch.fileName));
        return td;
    }

    const title = row.recordTitle || 'без имени';
    if (row.card && typeof opts.onCard === 'function') {
        const a = document.createElement('a');
        a.className = 'ui-link';
        a.href = `#/${row.card.section}?record=${row.card.id}`;
        a.textContent = title;
        a.addEventListener('click', (e) => { e.preventDefault(); opts.onCard(row.card); });
        td.appendChild(a);
    } else {
        td.appendChild(document.createTextNode(title));
    }

    // Подстрока — техническое имя таблицы и номер: они нужны для отбора, а не
    // для чтения, потому и стоят подстрокой, а не своей колонкой.
    //
    // «ЗАПИСЬ УДАЛЕНА» ГОВОРИТСЯ ТОЛЬКО ТОГДА, КОГДА ЭТО ПРОВЕРЕНО. Первая
    // редакция выводила её из отсутствия ссылки — а ссылки нет и у живой записи
    // в разделе, у которого просто нет карточки (справочники, настройки, сами
    // правила аудита). Экран объявлял удалённым всё, во что нельзя перейти.
    // Признак приходит с сервера: он один знает, искал ли он запись вообще.
    td.appendChild(span('ui-table__sub',
        row.deleted ? 'запись удалена' : `${row.table} #${row.recordId || '—'}`));
    return td;
}

// ---------------------------------------------------------------- «Что изменилось»

/**
 * Наполняет ячейку и возвращает кнопку разворота, если она нужна.
 *
 * ТРИ УРОВНЯ ПОДРОБНОСТИ РАЗЛИЧАЮТСЯ СЛОВАМИ, значок — второй сигнал.
 * «Изменён, значение не записано» понятно и без значка; значок нужен для
 * беглого просмотра сверху вниз.
 */
function buildChanges(box, row, detailId) {
    if (row.kind === 'batch') {
        box.appendChild(change([span('hi-new', row.batch && row.batch.title ? row.batch.title : 'Массовая операция')]));
        return moreButton(detailId, 'что в партии');
    }

    if (row.op === 'export') {
        box.appendChild(change([span('hi-new', 'Журнал выгружен')]));
    }

    const list = row.changes || [];
    const head = list.slice(0, VISIBLE_FIELDS);

    if (row.op === 'insert' && !list.length) box.appendChild(change([span('hi-new', 'Запись создана')]));
    if (row.op === 'delete' && !list.length) box.appendChild(change([span('hi-new', 'Запись удалена')]));

    // СОЗДАНИЕ И УДАЛЕНИЕ НАЗЫВАЮТСЯ СЛОВАМИ, а поля уходят под кнопку: без
    // этого создание неотличимо от правки, а удаление выглядит как обнуление
    // всех полей разом.
    if (row.op === 'insert' && list.length) {
        box.appendChild(change([span('hi-new', 'Запись создана')]));
        return moreButton(detailId, 'с чем создана');
    }
    if (row.op === 'delete' && list.length) {
        box.appendChild(change([span('hi-new', 'Запись удалена')]));
        return moreButton(detailId, 'что было в записи');
    }

    head.forEach((item) => box.appendChild(changeLine(row.table, item, row.op)));

    const rest = list.length - head.length;
    if (rest > 0) return moreButton(detailId, `и ещё ${rest} ${plural(rest, 'поле', 'поля', 'полей')}`);
    return null;
}

function changeLine(table, item, op) {
    const parts = [];

    // ЗНАЧОК СТОИТ ПЕРЕД ИМЕНЕМ ПОЛЯ, А НЕ ПОСЛЕ ЗНАЧЕНИЙ. Он объясняет, почему
    // значения нет, и должен быть прочитан раньше, чем глаз доберётся до его
    // отсутствия.
    if (item.level === 'masked') parts.push(levelIcon('shield', 'Значение маскировано'));
    if (item.level === 'fact') parts.push(levelIcon('eye-off', 'Значение не записывается'));

    const label = fieldLabel(table, item.field);
    if (label) {
        parts.push(span('hi-name', label));
    } else {
        // Расшифровки нет — переименованная в прошлом колонка. Показ не
        // ломается, а честно говорит, что имени не знает.
        const raw = span('hi-name hi-raw', item.field);
        parts.push(raw);
    }

    if (item.level === 'fact') {
        parts.push(span('hi-fact', factWording(label || item.field)));
        return change(parts);
    }

    // У СОЗДАНИЯ НЕТ «БЫЛО», У УДАЛЕНИЯ НЕТ «СТАЛО», и стрелке между ними
    // взяться неоткуда. Первая редакция печатала «Фамилия: пусто → Никитина» —
    // а «пусто» здесь не прежнее значение, а отсутствие прошлого: записи ещё не
    // существовало. Макет показывает ровно имя и значение, без стрелки.
    if (op === 'insert') {
        parts.push(span('hi-new', valueText(item, 'after')));
        return change(parts);
    }
    if (op === 'delete') {
        parts.push(span('hi-old', valueText(item, 'before')));
        return change(parts);
    }

    const before = valueText(item, 'before');
    const after = valueText(item, 'after');

    parts.push(span('hi-old', before));
    parts.push(span('hi-arrow', '→'));
    parts.push(span('hi-new', after));

    return change(parts);
}

/**
 * Значение поля: расшифрованное, если расшифровка есть.
 *
 * ПУСТОЕ ПРЕЖНЕЕ ЗНАЧЕНИЕ — СЛОВО «ПУСТО», А НЕ ПРОЧЕРК: прочерк в этой строке
 * читался бы как значение. Пустое НОВОЕ значение — тоже «пусто»: поле очистили,
 * и это изменение.
 */
function valueText(item, side) {
    const title = item[`${side}Title`];
    if (title) return title;
    const raw = item[side];
    if (raw === null || raw === undefined || raw === '') return 'пусто';
    return humanValue(String(raw));
}

// ВРЕМЯ ПОКАЗЫВАЕТСЯ ЧЕЛОВЕКУ, А НЕ МАШИНЕ. В журнале значение лежит так, как
// его отдала база — «2026-08-25T16:41:22.763606»; строка верная, но читать её
// глазами нельзя, а колонок с временем у записи по три-четыре.
//
// Приводится ТОЛЬКО то, что заведомо является меткой времени: остальное едет
// как есть. Угадывать смысл значения экран не вправе — он показывает то, что
// записано.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

function humanValue(text) {
    const m = STAMP.exec(text);
    if (!m) return text;
    return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
}

// «изменён» или «изменена» — по роду имени поля. Согласование делается здесь, а
// не в базе: это свойство подписи, а не данных.
function factWording(label) {
    const word = String(label).trim().split(' ')[0].toLowerCase();
    if (/(а|ь|я)$/.test(word) && !/(тель|атор)$/.test(word)) return 'изменена, значение не записано';
    return 'изменён, значение не записано';
}

function levelIcon(name, title) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ui-ic ui-ic--sm ui-ic--quiet');
    svg.setAttribute('aria-hidden', 'true');
    const t = document.createElementNS(NS, 'title');
    t.textContent = title;
    svg.appendChild(t);
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#ui-ic-${name}`);
    svg.appendChild(use);
    return svg;
}

function change(children) {
    const div = document.createElement('div');
    div.className = 'hi-change';
    children.forEach((c) => div.appendChild(c));
    return div;
}

function moreButton(detailId, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hi-more';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', detailId);
    btn.innerHTML = '<svg class="ui-ic" aria-hidden="true"><use href="#ui-ic-chevron-down"></use></svg>';
    btn.appendChild(document.createTextNode(label));
    return btn;
}

// ---------------------------------------------------------------- разворот

async function toggleDetail(btn, detail, row, opts) {
    const open = detail.hidden;
    btn.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
    if (!open) return;

    const td = detail.firstChild;
    if (td.childElementCount) return;

    if (row.kind === 'batch') {
        await fillBatch(td, row, opts);
        return;
    }

    // ПОЛЯ РАЗВОРОТА УЖЕ ЗДЕСЬ — они приехали вместе со строкой. Содержимое
    // разворота не ходит на сервер: состояния «загрузка» у него не бывает.
    const box = document.createElement('div');
    box.className = 'hi-changes';
    (row.changes || []).forEach((item) => box.appendChild(changeLine(row.table, item, row.op)));
    td.appendChild(box);
}

/**
 * Сводка партии: сколько записей, какие поля, имя файла — и кнопка «Показать
 * записи партии».
 *
 * ПЯТЬ ТЫСЯЧ СТРОК ВНУТРЬ РАЗВОРОТА НЕ ПОМЕЩАЮТСЯ НИКОГДА. Разворот отвечает на
 * «что это было», а сами записи открываются отбором — и своего «режима партии»
 * раздел не заводит.
 */
async function fillBatch(td, row, opts) {
    const box = document.createElement('div');
    box.className = 'hi-batch';
    td.appendChild(box);

    let data = null;
    try {
        data = await opts.loadBatch(row.batchId);
    } catch (err) {
        box.textContent = 'Сводку партии получить не удалось.';
        return;
    }

    const line = (label, value) => {
        const b = document.createElement('b');
        b.textContent = value;
        const wrap = document.createElement('span');
        wrap.appendChild(document.createTextNode(`${label} `));
        wrap.appendChild(b);
        return wrap;
    };

    box.appendChild(line('Записей:', String(data.records)));
    box.appendChild(line('Строк журнала:', String(data.rows)));
    if (data.fileName) box.appendChild(line('Файл:', data.fileName));
    if (data.tables && data.tables.length) box.appendChild(line('Таблицы:', data.tables.join(', ')));
    if (data.fields && data.fields.length) {
        box.appendChild(line('Поля:', data.fields
            .map((f) => fieldLabel(data.tables && data.tables[0], f) || f)
            .join(', ')));
    }

    if (typeof opts.onBatch === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-btn ui-btn--secondary';
        btn.textContent = 'Показать записи партии';
        btn.addEventListener('click', () => opts.onBatch(row.batchId, data));
        box.appendChild(btn);
    }
}

// ---------------------------------------------------------------- мелочи

function span(className, text) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}
