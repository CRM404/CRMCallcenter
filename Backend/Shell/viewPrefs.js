// --- viewPrefs.js: НАСТРОЙКИ ВИДА, общие для разделов ---------------------
//
// Здесь живёт ровно одно: что человек настроил в том, КАК ему показывать
// список. Сегодня это состав видимых колонок «Лидов» и «Сотрудников».
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
 * @param {string}   section 'leads' | 'employees'
 * @param {string[]} keys    ключи СКРЫТЫХ колонок
 */
export function writeHiddenColumns(section, keys) {
    const prefs = readAll();
    const box = prefs.hiddenColumns && typeof prefs.hiddenColumns === 'object' ? prefs.hiddenColumns : {};
    box[section] = Array.from(keys);
    prefs.hiddenColumns = box;
    writeAll(prefs);
}
