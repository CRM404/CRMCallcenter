// --- viewPrefs.js: НАСТРОЙКИ ВИДА, общие для разделов ---------------------
//
// Здесь живёт ровно одно: что человек настроил в том, КАК ему показывать
// список. Сегодня это состав видимых колонок «Лидов», «Сотрудников» и офферов
// в «CPA-сетях» — и, с 01.09.2026, их ПОРЯДОК (пока настраивается только у
// офферов: решение владельца, у остальных разделов порядок задан разметкой).
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПО РАЗДЕЛУ. Одно и то же окно «Настройка
// колонок» помнило выбор двумя разными способами: «Сотрудники» — до закрытия
// вкладки, «Лиды» — до закрытия панели (К53 приёмки части 3). Двадцать пять
// переключателей никто не расставляет заново на каждый заход.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ sessionStorage, И ПОЧЕМУ ПРАВИЛО ПРОЕКТА НЕ НАРУШЕНО.
// Правило говорит: в sessionStorage — состояние ИНТЕРФЕЙСА, а не данные. Оно
// верное, но настройка вида под него не подходит:
//
//   состояние сеанса — какие панели открыты, какой раздел где, что свёрнуто.
//                      Умирает вместе с вкладкой, и это правильно.
//   настройка вида   — состав колонок. Человек выставил его один раз и ждёт
//                      его завтра. До К28 он и жил на сервере, то есть
//                      переживал всё.
//
// Поэтому первое остаётся в sessionStorage, второе живёт здесь — в
// localStorage. Это уточнённая формулировка К53 от дизайн-сессии.
//
// ЧТО БУДЕТ, КОГДА ПОЯВИТСЯ ВХОД. Настройки станут персональными и переедут на
// сервер: таблица `employee_column_settings` и маршруты
// `GET/PUT /api/employees/column-settings/:id` для этого не тронуты. Формат
// хранения здесь тот же, что там, — МАССИВ КЛЮЧЕЙ СКРЫТЫХ КОЛОНОК, — поэтому
// переезд будет переносом значения, а не переписыванием.
//
// БЕЗОПАСНОСТЬ ЧТЕНИЯ. Всё, что приходит из хранилища, — чужой ввод: его мог
// оставить прежний состав колонок, другая версия сборки или человек руками в
// консоли. Поэтому читается через try, проверяется на форму и просеивается по
// списку известных ключей: скрытая «колонка», которой больше нет, ничего не
// значит и только мешает следующему чтению.

const STORAGE_KEY = 'crm_viewPrefs';

/** Всё хранилище целиком. Испорченное значение — то же, что пустое. */
function readAll() {
    let raw;
    try {
        raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (err) {
        return {};
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function writeAll(prefs) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (err) {
        // Хранилище может быть переполнено или запрещено настройками браузера.
        // Настройка вида не то, ради чего стоит ронять раздел: не сохранилось —
        // человек увидит прежний состав колонок в следующий раз, и только.
    }
}

/**
 * Место перемещаемого окна `.ui-float`.
 *
 * ⚠ ОДНА ИМЕНОВАННАЯ ЯЧЕЙКА В СУЩЕСТВУЮЩЕМ ФАЙЛЕ, а не отдельный модуль
 * (паспорт `d3afce57`, К323). Файл написан как общее место «что человек
 * настроил в том, КАК ему показывать», и место окна — ровно это; заводить
 * рядом второе хранилище значило бы развести один вопрос по двум ключам.
 *
 * ⚠ ПОМНИТСЯ МЕСТО, А НЕ СОДЕРЖИМОЕ. Номер в поле пульта сюда не попадает
 * намеренно: подставленный вчерашний номер — это звонок не тому человеку.
 *
 * Читается как чужой ввод: значение мог оставить прежний размер экрана или
 * человек руками в консоли. Не число — то же, что «не сохраняли».
 *
 * @param {string} key имя окна, например 'operatorTel'
 * @returns {{left:number, top:number}|null}
 */
export function readFloatPlace(key) {
    const box = readAll().floatPlace;
    const place = box && typeof box === 'object' ? box[key] : null;
    if (!place || typeof place !== 'object') return null;
    const { left, top } = place;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
}

/**
 * Запомнить место окна. Границы здесь не проверяются: их знает `float.js`,
 * который единственный видит настоящий размер окна и экрана.
 *
 * @param {string} key
 * @param {{left:number, top:number}} place
 */
export function writeFloatPlace(key, place) {
    if (!place || !Number.isFinite(place.left) || !Number.isFinite(place.top)) return;
    const prefs = readAll();
    const box = prefs.floatPlace && typeof prefs.floatPlace === 'object' ? prefs.floatPlace : {};
    box[key] = { left: Math.round(place.left), top: Math.round(place.top) };
    prefs.floatPlace = box;
    writeAll(prefs);
}

/**
 * Свёрнуто ли перемещаемое окно.
 *
 * Отдельно от места намеренно: место есть всегда, а свёрнутость — состояние,
 * и «нет записи» здесь значит «первый заход», а не «ноль».
 *
 * @param {string} key
 * @returns {boolean}
 */
export function readFloatCollapsed(key) {
    const box = readAll().floatCollapsed;
    return Boolean(box && typeof box === 'object' && box[key] === true);
}

/**
 * @param {string} key
 * @param {boolean} collapsed
 */
export function writeFloatCollapsed(key, collapsed) {
    const prefs = readAll();
    const box = prefs.floatCollapsed && typeof prefs.floatCollapsed === 'object' ? prefs.floatCollapsed : {};
    box[key] = Boolean(collapsed);
    prefs.floatCollapsed = box;
    writeAll(prefs);
}

/**
 * Ключи СКРЫТЫХ колонок раздела.
 *
 * @param {string}   section   'leads' | 'employees'
 * @param {string[]} knownKeys весь состав колонок раздела — чужое отсеивается
 * @returns {string[]}
 */
export function readHiddenColumns(section, knownKeys) {
    const box = readAll().hiddenColumns;
    const list = box && typeof box === 'object' ? box[section] : null;
    if (!Array.isArray(list)) return [];
    const known = new Set(knownKeys);
    return list.filter((key) => known.has(key));
}

/** Было ли хоть раз сохранено — раздел по этому признаку выбирает умолчание. */
export function hasHiddenColumns(section) {
    const box = readAll().hiddenColumns;
    return Boolean(box && typeof box === 'object' && Array.isArray(box[section]));
}

/**
 * Запомнить состав скрытых колонок раздела.
 *
 * @param {string}   section 'leads' | 'employees' | 'cpaOffers'
 * @param {string[]} keys    ключи СКРЫТЫХ колонок
 */
export function writeHiddenColumns(section, keys) {
    const prefs = readAll();
    const box = prefs.hiddenColumns && typeof prefs.hiddenColumns === 'object' ? prefs.hiddenColumns : {};
    box[section] = Array.from(keys);
    prefs.hiddenColumns = box;
    writeAll(prefs);
}

// ----- ПОРЯДОК КОЛОНОК ------------------------------------------------------
//
// Отдельно от состава, и это не дробление ради дробления: скрыть колонку и
// переставить её местами — разные действия, и сохраняются они по отдельности.
// Раздел, который порядок не настраивает, читает пустой список и рисует свой.
//
// ХРАНИТСЯ НЕПОЛНЫЙ СПИСОК, И ТАК ЗАДУМАНО. Записывается ровно то, что человек
// расставил; ключи, которых в записи нет (появились новой сборкой), встают
// после сохранённых, в порядке самого раздела. Иначе новая колонка не
// показалась бы вовсе — а «её нет в моей записи» и «я её выключил» это разные
// вещи, и путать их нельзя.

/**
 * Порядок колонок раздела: ключи, расставленные человеком.
 *
 * @param {string}   section
 * @param {string[]} knownKeys весь состав колонок раздела — чужое отсеивается
 * @returns {string[]} без повторов и без неизвестных ключей; пусто — не настроен
 */
export function readColumnOrder(section, knownKeys) {
    const box = readAll().columnOrder;
    const list = box && typeof box === 'object' ? box[section] : null;
    if (!Array.isArray(list)) return [];
    const known = new Set(knownKeys);
    const seen = new Set();
    return list.filter((key) => {
        if (typeof key !== 'string' || !known.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Запомнить порядок колонок раздела.
 *
 * @param {string}   section
 * @param {string[]} keys ключи в том порядке, в каком их поставил человек
 */
export function writeColumnOrder(section, keys) {
    const prefs = readAll();
    const box = prefs.columnOrder && typeof prefs.columnOrder === 'object' ? prefs.columnOrder : {};
    box[section] = Array.from(keys);
    prefs.columnOrder = box;
    writeAll(prefs);
}

/**
 * Состав раздела, разложенный по сохранённому порядку.
 *
 * Общая для разделов, потому что правило одно: сохранённые ключи идут первыми
 * в своём порядке, остальные — следом, в порядке самого раздела.
 *
 * @param {Object[]} columns [{ key, label }, …] в порядке раздела
 * @param {string[]} order   сохранённый порядок
 * @returns {Object[]}
 */
export function applyColumnOrder(columns, order) {
    if (!order.length) return columns.slice();
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const out = [];
    order.forEach((key) => {
        const col = byKey.get(key);
        if (col) { out.push(col); byKey.delete(key); }
    });
    columns.forEach((col) => { if (byKey.has(col.key)) out.push(col); });
    return out;
}
