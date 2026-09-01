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
import { showLoadError, clearLoadError } from '../ui/load-error.js';

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
    // СКЛЕЙКА ЛИДОВ — ТОЖЕ ПАРТИЯ, и вид у неё свой (К211). Словарь её не знал,
    // и настоящее слияние подписывалось общим «Массовая операция» — то есть
    // ровно тем, чего строка партии как раз и не должна говорить.
    merge: 'Слияние',
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
        // ДВА ИМЕНИ, И ОБА НУЖНЫ (К295). Первое — узел слоя: подложка и
        // отступы развёрнутой строки. Второе — своё: по нему раздел теснит
        // список полей внутри разворота.
        detail.className = 'ui-table__detail hi-detail';
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
        // ТЕХНИЧЕСКОЕ ИМЯ ПОКАЗЫВАЕТСЯ ВСЕГДА, А НЕ ВЗАМЕН ПРОПАВШЕЙ ПОДПИСИ
        // (К258, паспорт Р5 редакции 9, решение владельца). «Способ покупки» на
        // экране и `purchase_method` в базе — разные слова об одном поле, и
        // человеку, который пришёл в журнал разбираться, нужны оба: первое
        // чтобы понять, второе чтобы спросить.
        //
        // ОНО ЛЕЖИТ ВНУТРИ `.hi-name`, а не рядом, и это не мелочь: двоеточие
        // подписи ставит `::after` у `.hi-name`, и оно само встаёт ПОСЛЕ
        // закрывающей скобки. Положи мы имя соседом — понадобилось бы второе
        // правило и порядок узлов стал бы значащим.
        //
        // ПРОБЕЛ — НАСТОЯЩИЙ УЗЕЛ, А СКОБКИ — СЛОЙ. Скобки рисует
        // `.hi-name > .hi-raw::before/::after`, и в буфер обмена они не
        // попадают: скопированная строка даёт «Способ покупки purchase_method»
        // — техническое имя остаётся целым словом, годным для запроса. Пробел
        // при этом обязан быть узлом, иначе слова слиплись бы при копировании.
        const name = span('hi-name', label);
        name.appendChild(document.createTextNode(' '));
        name.appendChild(span('hi-raw', item.field));
        parts.push(name);
    } else {
        // Расшифровки нет — снятая в прошлом колонка. Показ не ломается, а
        // честно говорит, что имени не знает. СКОБОК ЗДЕСЬ НЕТ, и это следствие
        // того же правила: они висят на `.hi-raw` ВНУТРИ `.hi-name`, а тут
        // узел один и оба класса на нём.
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
    //
    // У ВЫГРУЗКИ ПРЕЖНЕГО ЗНАЧЕНИЯ НЕТ ПО ТОЙ ЖЕ ПРИЧИНЕ (паспорт Р5, редакция
    // 6). Строка «Строк в файле: пусто → 5» читалась как «было пусто», а не
    // было ничего: выгрузка ничего не меняла, она случилась.
    if (op === 'insert' || op === 'export') {
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
// СЕКУНДЫ ПОКАЗЫВАЮТСЯ, А НЕ ОТБРАСЫВАЮТСЯ. Первая редакция резала метку до
// минут — и строка «Изменена: 24.08.2026 23:18 → 24.08.2026 23:18» читалась как
// изменение, которого не было: значения различались секундами. Служебные метки
// (`updated_at`, `merged_at`) правятся как раз внутри одной минуты, и на них
// это выходило почти всегда.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function humanValue(text) {
    const m = STAMP.exec(text);
    if (!m) return text;
    return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}`;
}

// РОД ПО МЯГКОМУ ЗНАКУ ИЗ ОКОНЧАНИЯ НЕ ВЫВОДИТСЯ — русский этого не позволяет:
// «пароль» и «должность» кончаются одинаково и разного рода (К203). Первая
// редакция считала «ь» женским с двумя исключениями и давала «Пароль изменена»
// — а пароль как раз самое частое поле уровня «только факт»: пароль сотрудника
// и пароль АТС, и видно это будет всегда.
//
// Поэтому «а» и «я» решаются окончанием — там правило работает, — а мягкий знак
// решается списком: надёжный суффикс «-сть/-сь» женского рода всегда, и
// поимённо те слова, что стоят подписями в словаре полей. Неизвестное слово на
// «ь» считается мужским: это же умолчание у функции и для всех прочих окончаний.
const FEM_SOFT = ['сеть', 'роль', 'связь', 'часть', 'ссылка'];

function isFeminineSoft(word) {
    // «-сть» и «-сь» женские всегда: должность, комнатность, область, подпись.
    if (/(сть|сь)$/.test(word)) return true;
    // СЛОВО СВЕРЯЕТСЯ ЦЕЛИКОМ, А НЕ ХВОСТОМ. Первая попытка правки сверяла
    // концом строки — и «пароль» попал в список через «роль», то есть ровно то
    // слово, ради которого правка и делается, осталось женского рода.
    // У составного берётся последняя часть: «CPA-сеть» — это сеть.
    const head = word.split('-').pop();
    return FEM_SOFT.includes(head);
}

// «изменён» или «изменена» — по роду имени поля. Согласование делается здесь, а
// не в базе: это свойство подписи, а не данных.
function factWording(label) {
    const word = String(label).trim().split(' ')[0].toLowerCase();
    const feminine = /(а|я)$/.test(word) || (/ь$/.test(word) && isFeminineSoft(word));
    return feminine ? 'изменена, значение не записано' : 'изменён, значение не записано';
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
    // ВИД — ИЗ СЛОЯ, МЕСТО — СВОЁ (К295). .ui-table__expand несёт всю кнопку;
    // .hi-more остался ради двух строк размещения в ячейке.
    // ⚠ ЛОВУШКА ЧИТАТЕЛЮ: в этом же файле есть data-role="hi-more" — и это
    // ДРУГАЯ кнопка, «Открыть в журнале» в подвале вкладки карточки. Имена
    // совпали, пространства разные; переименование одного не трогает второе.
    btn.className = 'ui-table__expand hi-more';
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


// ======================================================================
// ПАНЕЛЬ ИСТОРИИ В КАРТОЧКЕ — ОДНА НА ОБЕ КАРТОЧКИ
// ======================================================================
//
// Вкладка «История» стоит в карточке лида и в карточке сотрудника, и до этой
// правки в каждой лежала своя почти одинаковая копия загрузки и отрисовки.
// Копий стало бы три, как только у вкладки появился подвал и порядок, — а
// расходятся такие копии на первой же правке. Модуль общий уже по своему
// назначению; сюда и переезжает.
//
// ВКЛАДКА БОЛЬШЕ НЕ ОБРЕЗАЕТ МОЛЧА (К210). Прежде она слала один запрос и
// рисовала что пришло: у лида с сорока одним изменением показывались тридцать
// строк и ни слова о том, что их больше. Это ровно то, за что исправлена
// «запись удалена», — экран не вправе изображать полноту.
//
// ДОГРУЗКИ ЗДЕСЬ НЕТ, И ЭТО РЕШЕНИЕ, А НЕ ЭКОНОМИЯ (паспорт Р5, редакция 6).
// Вкладка отвечает на «что с записью происходило», раздел — на «разберись».
// Кнопка догрузки превратила бы карточку во второй журнал, а два места с одной
// работой расходятся на первой же правке. Вместо неё — «Показаны последние 30
// из N» и кнопка, открывающая раздел с уже поставленным отбором по этой записи.
//
// СОРТИРОВКИ ЗДЕСЬ ТОЖЕ НЕТ, и по той же причине. Слово «последние» в подвале
// говорит о порядке прямо, а признак сортируемого заголовка при нём означал бы
// «порядок можно перевернуть» — то есть сделать подпись подвала неправдой.
// Разбор порядка — работа раздела.
//
// РАЗМЕТКУ ДАЁТ КАРТОЧКА, а имена ролей — этот модуль: hi-wrap, hi-body,
// hi-foot, hi-shown, hi-more, hi-empty, hi-empty-text, hi-note.

// Порция вкладки. Сервер принимает размер закрытым списком (30 и 100);
// вкладке нужен больший: см. довод у `limit` в `load()`.
const CARD_PAGE_SIZE = 100;

const CARD_PERIOD_FROM = '2000-01-01';

/**
 * Заголовок колонки «Запись» на вкладке карточки: поставить или снять.
 *
 * Идемпотентна намеренно: вкладку рисуют заново при каждой загрузке, и второй
 * заход не должен давать второй заголовок. Признак — свой атрибут, а не
 * положение: положение сдвинется, стоит карточке поменять состав колонок.
 */
function syncRecordHeader(body, need) {
    const table = body.closest('table');
    const head = table && table.querySelector('thead tr');
    if (!head) return;
    const already = head.querySelector('[data-role="hi-th-record"]');
    if (need && !already) {
        const th = document.createElement('th');
        th.dataset.role = 'hi-th-record';
        th.textContent = 'Запись';
        // Перед последней: последняя — «Что изменилось», и она обязана остаться
        // последней, как в разделе.
        head.insertBefore(th, head.lastElementChild);
    } else if (!need && already) {
        already.remove();
    }
}

/**
 * @param {HTMLElement} pane  панель вкладки
 * @param {Object} opts
 * @param {Object} opts.api          транспорт панели (ctx.api)
 * @param {string} opts.recordTable  таблица записи: 'leads' | 'employees'
 * @param {Function} opts.recordId   () => number — номер записи
 * @param {string} opts.noteText     подпись под таблицей, первая половина
 * @param {Function} [opts.onLeave]  закрыть карточку перед уходом в раздел;
 *                                    вернуть false, если закрыть отказались
 * @param {Function} [opts.isAlive]  жива ли панель
 * @param {Function} [opts.isAbort]  оборван ли запрос
 */
export function createHistoryPane(pane, opts) {
    ensureStyles();

    const $ = (role) => pane.querySelector(`[data-role="${role}"]`);
    const isAlive = opts.isAlive || (() => true);
    const isAbort = opts.isAbort || (() => false);

    const state = { rows: [], total: 0, started: null, loaded: false };

    const moreBtn = $('hi-more');
    if (moreBtn) moreBtn.addEventListener('click', openInJournal);

    /**
     * Уйти в раздел с отбором по этой записи.
     *
     * Механизм тот же, что у «Показать записи партии»: экран не заводит своего
     * способа показать подмножество журнала — он ставит отбор. Карточка при
     * этом закрывается: оставить её открытой поверх раздела значило бы показать
     * два ответа на один вопрос.
     */
    async function openInJournal() {
        const id = opts.recordId();
        if (!id) return;
        // ВВЕДЁННОЕ НЕ ТЕРЯЕТСЯ МОЛЧА. Уход в раздел закрывает карточку, а
        // закрытие карточки с набранными полями спрашивает — тем же вопросом,
        // что «Отмена», Esc и крестик. Отказались закрывать — остаёмся на месте:
        // адрес меняется только после согласия.
        if (typeof opts.onLeave === 'function' && !(await opts.onLeave())) return;
        window.location.hash = `#/history?recordTable=${encodeURIComponent(opts.recordTable)}`
            + `&recordId=${encodeURIComponent(String(id))}`;
    }

    /** Загрузить один раз — при первом заходе на вкладку. */
    function ensure() {
        if (state.loaded) return;
        state.loaded = true;
        load(false);
    }

    /** Забыть загруженное: окно закрыли, следующая запись будет другой. */
    function reset() {
        state.rows = [];
        state.total = 0;
        state.loaded = false;
    }

    async function load() {
        const id = opts.recordId();
        if (!id) return;
        try {
            const data = await opts.api.get('/audit', {
                recordTable: opts.recordTable,
                recordId: String(id),
                // Период вкладки — весь журнал, а не последние семь дней:
                // человек открыл карточку, чтобы увидеть её прошлое целиком.
                from: CARD_PERIOD_FROM,
                // ⚠ СТО, А НЕ ТРИДЦАТЬ (К275). Вкладка грузит ОДНУ порцию и всё
                // — «показать ещё» у неё нет вовсе. С привязанными записями
                // тридцати строк не хватает: у лида с десятками звонков
                // собственные правки лида вытеснило бы из видимых, и вкладка
                // показала бы обратное тому, ради чего заведена. Число не
                // произвольное: сервер принимает его закрытым списком.
                limit: CARD_PAGE_SIZE
            });
            if (!isAlive() || !pane.isConnected) return;
            clearLoadError(pane);
            state.rows = data.rows;
            state.total = data.total;
            state.started = data.auditStartedAt;
            render();
        } catch (err) {
            if (isAbort(err) || !isAlive() || !pane.isConnected) return;
            // ОТКАЗ ПОКАЗЫВАЕТСЯ ПОЛОСОЙ СЛОЯ, А НЕ ТОСТОМ И НЕ ПУСТОТОЙ.
            // Пустое состояние здесь читается как «запись никто не трогал» —
            // самая дорогая неправда, какую эта вкладка может сказать.
            state.loaded = false;
            showLoadError(pane, err.message, () => { state.loaded = true; load(); });
        }
    }

    function render() {
        const body = $('hi-body');
        const wrap = $('hi-wrap');
        const empty = $('hi-empty');
        const foot = $('hi-foot');
        const started = state.started ? humanDate(state.started) : null;

        // ДАТА ВКЛЮЧЕНИЯ ЖУРНАЛА НАЗЫВАЕТСЯ ОБЯЗАТЕЛЬНО. Без неё пустая вкладка
        // читается как «запись никто не трогал», и журнал начинает врать в
        // самом чувствительном месте — там, где по нему судят о человеке.
        $('hi-note').textContent = started
            ? `${opts.noteText} Журнал ведётся с ${started}.`
            : opts.noteText;

        if (!state.rows.length) {
            body.innerHTML = '';
            wrap.hidden = true;
            foot.hidden = true;
            empty.hidden = false;
            $('hi-empty-text').textContent = started
                ? `С ${started}, когда включён журнал, эту запись не меняли. Что было раньше, в журнал не попало.`
                : 'Эту запись не меняли с тех пор, как включён журнал.';
            return;
        }

        wrap.hidden = false;
        empty.hidden = true;
        body.innerHTML = '';
        // ⚠ КОЛОНКА «ЗАПИСЬ» ВКЛЮЧАЕТСЯ, КОГДА ЕСТЬ ПРИВЯЗАННЫЕ (К275).
        // Пока строки только свои, запись одна и известна — называть её в
        // каждой строке незачем. Появились привязанные — без этой колонки они
        // неотличимы от собственных правок вовсе, и признак `attached` в ответе
        // не виден никому. Колонка существующая, своих видов раздел не заводит.
        //
        // ⚠ И ШАПКУ СТАВИТ ЭТОТ ЖЕ КОД, А НЕ КАРТОЧКА. В разметке обеих карточек
        // три жёстких <th>, и четвёртая ячейка тела против трёх заголовков —
        // сломанная таблица. Ставить <th> руками в двух местах значило бы завести
        // два источника правды о том, когда колонка есть.
        //
        // ПОРЯДОК ЯЧЕЕК ЗАДАЁТ `renderRow`, А НЕ ЭТОТ СПИСОК: там жёстко
        // «когда → кто → раздел → запись», а «что изменилось» дописывается
        // последним. Значит «Запись» встаёт ТРЕТЬЕЙ, и заголовок — туда же.
        const hasAttached = state.rows.some((row) => row.attached);
        const columns = hasAttached ? ['when', 'who', 'record'] : ['when', 'who'];
        syncRecordHeader(body, hasAttached);
        state.rows.forEach((row) => {
            renderRow(row, { columns }).forEach((tr) => body.appendChild(tr));
        });

        // ПОДВАЛ ПОЯВЛЯЕТСЯ, ТОЛЬКО КОГДА ЧТО-ТО СКРЫТО. Пока помещается всё,
        // говорить «показаны последние 12 из 12» не о чем: подвал существует
        // ради того, чего не видно.
        const hidden = state.total > state.rows.length;
        foot.hidden = !hidden;
        if (hidden) {
            $('hi-shown').textContent = `Показаны последние ${state.rows.length} из ${state.total}`;
        }
    }

    return { ensure, reset };
}

// «24 августа 2026», без «г.» на конце: точку в конце фразы ставит сам текст, и
// вместе они давали «…2026 г..». Хвост снимается здесь, а не правкой текста:
// текст паспортный, а «г.» — свойство браузерного формата.
export function humanDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        .replace(/\s*г\.?$/, '');
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
