// --- shell/router.js: адрес приложения ---
//
// Одна точка входа, раздел адресуется hash-маршрутом:
//
//     /#/leads                одна панель
//     /#/leads+employees      две панели: слева «Лиды», справа «Сотрудники»
//     /#/  или пустой hash    рабочий стол, панелей нет
//
// ПОЧЕМУ HASH, А НЕ History API: при статической раздаче hash не требует
// серверной поддержки deep-link и не ломается при прямом заходе по адресу.
// Catch-all в server.js есть, но hash проще и не создаёт нового класса
// ошибок — решение брифа, раздел 3.1.
//
// ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО:
//   - редиректы со старых адресов (/leads.html → /#/leads) живут в server.js
//     и включаются по одному на каждом этапе переноса;
//   - свёрнутые панели и положение границы в адрес не пишутся. Адресом
//     делятся — получатель должен увидеть те же разделы ОТКРЫТЫМИ, а не
//     чужую полосу свёрнутых. Это состояние интерфейса, оно в sessionStorage.

const SEPARATOR = '+';

let known = [];
let onRoute = null;

/**
 * @param {Object}   opts
 * @param {string[]} opts.known    допустимые ключи разделов
 * @param {Function} opts.onRoute  ({ keys, unknown, source }) => void
 */
export function startRouter(opts = {}) {
    known = opts.known || [];
    onRoute = opts.onRoute || null;
    window.addEventListener('hashchange', handleHashChange);
    emit('start');
}

// ЗАМЕТКА ПРО СОБСТВЕННЫЕ ЗАПИСИ АДРЕСА.
// Первой редакцией здесь стоял флаг «сейчас пишем сами», гасивший ответ на
// собственное событие hashchange. Флаг убран намеренно: он снимался только в
// обработчике события, и любой сценарий, где событие не приходило или
// приходило дважды, оставлял его поднятым — а поднятый флаг глушит уже
// НАСТОЯЩЕЕ изменение адреса, и приложение перестаёт слушать кнопку «назад».
//
// Вместо этого приведение панелей к адресу сделано идемпотентным: получив
// маршрут, который уже открыт, оболочка ничего не делает. Ответ на своё же
// событие безвреден, и специальный случай не нужен.

export function stopRouter() {
    window.removeEventListener('hashchange', handleHashChange);
    onRoute = null;
}

/** Текущий маршрут: массив ключей, 0–2 штуки. */
export function getRoute() {
    return parseHash(window.location.hash).keys;
}

/**
 * Записать маршрут в адрес. Вызывается оболочкой при открытии, закрытии и
 * перестановке панелей.
 *
 * @param {string[]} keys       [левая, правая]
 * @param {boolean}  [replace]  заменить запись истории вместо добавления
 */
export function setRoute(keys, replace = false) {
    const next = buildHash(keys);
    if (next === window.location.hash) return;

    if (replace) {
        const url = window.location.pathname + window.location.search + next;
        window.history.replaceState(null, '', url);
    } else {
        window.location.hash = next;
    }
}

/** Разбор адреса. Неизвестные ключи не выбрасываются молча — их возвращаем. */
export function parseHash(hash) {
    const full = String(hash || '').replace(/^#/, '').replace(/^\//, '');
    // ХВОСТ ПОСЛЕ «?» — ОДНОРАЗОВОЕ УКАЗАНИЕ РАЗДЕЛУ, а не часть маршрута.
    // Сегодня он один: `#/leads?record=1042` — «открой карточку этой записи».
    // Такие ссылки ставит раздел «Звонки» на телефон лида: переход в карточку и
    // есть смысл колонки, а без параметра ссылка приводила бы в список, где
    // нужную строку ещё надо найти.
    //
    // В АДРЕСЕ ОН НЕ ЗАДЕРЖИВАЕТСЯ. buildHash его не пишет: оболочка приведёт
    // адрес к `#/leads` первой же перестановкой панелей — и это правильно.
    // Указание исполняется один раз; ссылка, которую человек скопирует уже
    // после открытия карточки, не должна открывать её снова у получателя.
    const cut = full.indexOf('?');
    const raw = cut === -1 ? full : full.slice(0, cut);
    const params = cut === -1 ? {} : parseParams(full.slice(cut + 1));
    if (!raw) return { keys: [], unknown: [], params };

    const parts = raw.split(SEPARATOR).map((p) => p.trim()).filter(Boolean);
    const keys = [];
    const unknown = [];

    parts.forEach((part) => {
        if (!known.length || known.includes(part)) {
            // Один и тот же раздел дважды — не две панели с копией, а одна:
            // /#/leads+leads даёт /#/leads.
            if (!keys.includes(part)) keys.push(part);
        } else {
            unknown.push(part);
        }
    });

    // Больше двух панелей нет: лишнее в адресе отбрасываем и сообщаем о нём
    // как о неизвестном — молча урезать адрес нельзя, человек не поймёт,
    // почему открылось не то, что он вставил.
    const extra = keys.splice(2);
    return { keys, unknown: unknown.concat(extra), params };
}

// Разбор хвоста. Своего формата не выдумываем — это обычная строка запроса, и
// URLSearchParams разбирает её так же, как её разберёт любой, кто будет читать
// этот адрес глазами.
function parseParams(text) {
    const out = {};
    try {
        new URLSearchParams(text).forEach((value, key) => { out[key] = value; });
    } catch (err) {
        // Испорченный хвост — то же, что его отсутствие: раздел откроется, а
        // указание не исполнится. Ронять маршрут из-за него нельзя.
    }
    return out;
}

export function buildHash(keys) {
    const list = (keys || []).filter(Boolean).slice(0, 2);
    return list.length ? `#/${list.join(SEPARATOR)}` : '#/';
}

function handleHashChange() {
    emit('address');
}

function emit(source) {
    if (!onRoute) return;
    const { keys, unknown, params } = parseHash(window.location.hash);
    onRoute({ keys, unknown, params, source });
}
