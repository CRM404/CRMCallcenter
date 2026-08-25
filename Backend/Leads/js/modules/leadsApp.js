// --- leadsApp.js: раздел «Лиды» — список, фильтры, настройка колонок,
// массовые действия, статистика.
// Композиция и поведение — 1:1 с утверждённым макетом дизайн-сессии
// (https://claude.ai/code/artifact/430feb4c-c115-424e-9f29-2d995e110a7a).
//
// КОНТРАКТ РАЗДЕЛА (тот же, что у «Реквизитов» и «CPA-сетей»):
//
//     export async function mount(container, ctx)
//     export function unmount()
//
// Три правила переноса, из-за которых модуль переписан, а не перенесён:
//
// 1. НЕТ ОБРАЩЕНИЙ К document. Поиск идёт в границах своей панели. Раньше
//    document.querySelector работал, пока раздел был отдельной страницей; в
//    оболочке при двух открытых панелях он взял бы первый попавшийся узел.
//
// 2. НЕТ КОДА НА ВЕРХНЕМ УРОВНЕ. Модуль импортируется один раз, а монтируется
//    много: обработчики, навешенные при импорте, указывали бы на узлы первой
//    панели даже после её закрытия.
//
// 3. СОСТОЯНИЕ СБРАСЫВАЕТСЯ ПРИ КАЖДОМ МОНТИРОВАНИИ — иначе второе открытие
//    раздела показало бы список, фильтры и выделение от первого.

import { createStorage } from './leadsStorage.js';
import { createPickList } from './leadsPickList.js';
import { createOfferTabPicker } from './leadsOffers.js';
import { createGeoAutocomplete } from './leadsGeo.js';
import { createLeadModal, fillFunnelStatusSelect, DOWN_PAYMENT_OPTIONS } from './leadsModal.js';
import { createUpload } from './leadsUpload.js';
// Путь АБСОЛЮТНЫЙ: физическая структура папок не совпадает с адресами —
// Backend/Shell/ монтируется в корень «/».
import { openModal } from '/ui/modal.js';
import { isAbort } from '/api.js';
import { readHiddenColumns, writeHiddenColumns, hasHiddenColumns } from '/viewPrefs.js';
import { icon } from '/ui/icons.js';
// Окно отказа общее на пять разделов (ответ на И118), но зовёт его отсюда не
// сам раздел, а окно архива: единственное место, где лида удаляют, — кнопка
// «Удалить насовсем» внутри него.
import { openLeadArchive, openLeadReturn } from './leadsArchive.js';

const PAGE_SIZE = 30;

// Кавычки экранируются ТОЖЕ. Общего escapeHtml в слое нет, копии живут по
// разделам и расходятся — эта отставала. Значения попадают не только в текст,
// но и в атрибуты (`value="…"`, `title="…"`): справочное значение с кавычкой
// («ЖК "Северный"») обрывало бы атрибут, и остаток названия уезжал бы в
// разметку. Проверять это надо там, где значение собирается СТРОКОЙ в атрибут,
// а не там, где присваивается через .value: во втором случае проверка зелёная
// при любом экранировании.
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(value) {
    if (!value) return '';
    // ISO-таймстамп ('2026-08-13T10:22:00.000Z') или обычная дата — берём
    // только дату, время в этом списке не нужно.
    const datePart = String(value).slice(0, 10);
    const parts = datePart.split('-');
    if (parts.length !== 3) return datePart;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function fullName(lead) {
    return [lead.lastName, lead.firstName, lead.middleName].filter(Boolean).join(' ');
}

// Группировка настройки колонок. Заголовок первой группы — просто «Основное»:
// прежнее «(видно по умолчанию)» врало про «Оффер», который по умолчанию был
// скрыт (замечание дизайн-сессии с прошлой задачи, dialog.md E2).
const COLUMN_GROUPS = [
    { label: 'Основное', columns: [
        { key: 'source', label: 'Источник' },
        { key: 'employee', label: 'Сотрудник' },
        { key: 'funnelStatus', label: 'Статус' },
        { key: 'lineType', label: 'Линия' },
        { key: 'script', label: 'Скрипт' },
        { key: 'offers', label: 'Офферы' }
    ] },
    { label: 'Что ищет', columns: [
        { key: 'propertyType', label: 'Тип объекта' },
        { key: 'propertyClass', label: 'Класс объекта' },
        { key: 'roomCount', label: 'Комнатность' },
        // «Отделка» и «Вид клиента» ниже — К127. Правило раздела: ОТБИРАЕМОЕ
        // ОБЯЗАНО БЫТЬ ПОКАЗЫВАЕМЫМ. Оба поля есть среди фильтров окна, и без
        // колонок человек отбирал бы лидов по признаку, которого не видит в
        // списке. Настраиваемых колонок стало 27, всего в таблице 32.
        { key: 'finish', label: 'Отделка' },
        { key: 'priceFrom', label: 'Цена от' },
        { key: 'priceTo', label: 'Цена до' },
        { key: 'areaFrom', label: 'Площадь от' },
        { key: 'areaTo', label: 'Площадь до' },
        { key: 'deliveryDeadline', label: 'Срок сдачи' }
    ] },
    { label: 'География', columns: [
        { key: 'region', label: 'Область' },
        { key: 'city', label: 'Город' },
        { key: 'district', label: 'Район' },
        { key: 'locality', label: 'Нас. пункт' }
    ] },
    { label: 'Покупка', columns: [
        { key: 'purchaseMethod', label: 'Способ покупки' },
        { key: 'clientType', label: 'Вид клиента' },
        { key: 'mortgageType', label: 'Вид ипотеки' },
        { key: 'downPaymentPercent', label: 'ПВ %' },
        { key: 'purchaseTimeframe', label: 'Срок покупки' }
    ] },
    { label: 'Прочее', columns: [
        { key: 'notes', label: 'Комментарии' },
        { key: 'createdAt', label: 'Создан' },
        { key: 'updatedAt', label: 'Обновлён' }
    ] }
];
const COLUMN_ORDER = COLUMN_GROUPS.flatMap((g) => g.columns.map((c) => c.key));
// «Линия», «Скрипт» и «Офферы» видимы по умолчанию наравне с прежними тремя:
// теперь это обязательные атрибуты лида, админ сверяет их с одного взгляда
// (решение дизайн-сессии, подтверждено куратором — dialog.md E3).
const DEFAULT_VISIBLE = new Set(['source', 'employee', 'funnelStatus', 'lineType', 'script', 'offers']);
const COLUMN_DEFAULT = COLUMN_ORDER.reduce((acc, key) => {
    acc[key] = DEFAULT_VISIBLE.has(key);
    return acc;
}, {});

/**
 * Состав колонок на начало работы: сохранённый — если человек его настраивал,
 * иначе умолчание раздела.
 *
 * Хранится СПИСОК СКРЫТЫХ ключей — тот же формат, что у «Сотрудников» и что
 * ждёт сервер, когда настройки станут персональными. Поэтому «ничего не
 * сохранено» и «сохранено, что не скрыто ничего» — разные состояния, и
 * различает их hasHiddenColumns: иначе человек, показавший ВСЕ колонки,
 * получал бы обратно умолчание при каждом открытии.
 */
function initialVisibleColumns() {
    if (!hasHiddenColumns(COLUMNS_SECTION)) return { ...COLUMN_DEFAULT };
    const hidden = new Set(readHiddenColumns(COLUMNS_SECTION, COLUMN_ORDER));
    return COLUMN_ORDER.reduce((acc, key) => {
        acc[key] = !hidden.has(key);
        return acc;
    }, {});
}

// Имя раздела в общем хранилище настроек вида.
const COLUMNS_SECTION = 'leads';

/**
 * ДВАДЦАТЬ ПОЛЕЙ ОКНА «ФИЛЬТРЫ» (К122). Было пять: ФИО, номер, источник,
 * сотрудник, статус — то есть раздел отвечал только на вопрос «найди вот этого
 * человека». Лид — это набор критериев подбора, и «покажи всех, кто ищет
 * двушку в Москве до 15 млн» — обычный вопрос перед раздачей партии под оффер.
 *
 * Отдельно про ЛИНИЮ: раздача идёт по линии, и массовое действие само
 * отказывает, если в выделении лиды разных линий («Выбраны лиды разных линий —
 * сузьте выбор»). Правило было, а способа его выполнить — нет: однородное
 * выделение собиралось глазами по колонке.
 *
 * Порядок здесь — порядок полей в окне. Он же задаёт порядок чипов активных
 * фильтров, и он же — список, по которому считается кружок на кнопке
 * «Фильтры»: кружок обещает содержимое ОКНА, поэтому строка поиска (q) в этот
 * список не входит.
 *
 * `list`/`field` — откуда взять человеческое имя для чипа: в фильтре лежит id,
 * а на экране должно стоять «Источник: Яндекс.Директ».
 * `param` — ключ справочника param_lists, из которого собирается список.
 */
const FILTER_FIELDS = [
    { key: 'fio', sel: '#fltFio', label: 'ФИО' },
    { key: 'phone', sel: '#fltPhone', label: 'Номер' },
    // field — источник лидов: корневой у всех записей один и тот же после
    // правки данных 25.08.2026, чипом активного отбора он ничего не сообщал бы.
    { key: 'sourceId', sel: '#fltSource', label: 'Источник', list: () => sources, field: 'leadSource' },
    { key: 'employeeId', sel: '#fltEmployee', label: 'Сотрудник', list: () => employees, field: 'fullName' },
    { key: 'funnelStatusId', sel: '#fltStatus', label: 'Статус', list: () => statuses, field: 'statusName' },
    { key: 'lineType', sel: '#fltLine', label: 'Линия' },
    { key: 'propertyType', sel: '#fltPropertyType', label: 'Тип объекта', param: 'objType', all: 'Все типы' },
    { key: 'propertyClass', sel: '#fltPropertyClass', label: 'Класс объекта', param: 'objClass', all: 'Все классы' },
    { key: 'roomCount', sel: '#fltRoomCount', label: 'Комнатность', param: 'rooms', all: 'Все комнатности' },
    { key: 'finish', sel: '#fltFinish', label: 'Отделка', param: 'finish', all: 'Все виды отделки' },
    { key: 'deliveryDeadline', sel: '#fltDeliveryDeadline', label: 'Срок сдачи', param: 'deadline', all: 'Все сроки' },
    { key: 'priceFrom', sel: '#fltPriceFrom', label: 'Цена от' },
    { key: 'priceTo', sel: '#fltPriceTo', label: 'Цена до' },
    { key: 'areaFrom', sel: '#fltAreaFrom', label: 'Площадь от' },
    { key: 'areaTo', sel: '#fltAreaTo', label: 'Площадь до' },
    { key: 'region', sel: '#fltRegion', label: 'Регион' },
    { key: 'locality', sel: '#fltLocality', label: 'Населённый пункт' },
    { key: 'clientType', sel: '#fltClientType', label: 'Вид клиента', param: 'clientType', all: 'Все виды клиентов' },
    { key: 'mortgageType', sel: '#fltMortgageType', label: 'Вид ипотеки', param: 'mortgageType', all: 'Все виды ипотеки' },
    { key: 'downPaymentPercent', sel: '#fltDownPaymentPercent', label: 'ПВ %', values: () => DOWN_PAYMENT_OPTIONS, all: 'Все значения' }
];

/** Пустой отбор. Собирается из списка полей, чтобы новое поле нельзя было
 *  добавить в окно и забыть в сбросе — именно так фильтр и переживает
 *  «Сбросить все», оставаясь действующим и невидимым. */
function emptyFilters() {
    // `archived` — отбор «Показывать»: пусто значит «в работе», и это умолчание
    // раздела. Он стоит в общем наборе фильтров, а не сбоку: иначе сброс
    // фильтров оставил бы состав списка прежним, и человек решил бы, что сброс
    // не сработал.
    return FILTER_FIELDS.reduce((acc, f) => { acc[f.key] = ''; return acc; }, { q: '', archived: '' });
}

const REPEAT_STAGE_FROM = 5;

// Ячейки, которые собираются в готовый HTML (пилюли/чипы), а не в текст.
const RICH_CELLS = {
    // Статус — ПИЛЮЛЯ СЛОЯ, ОДНОГО ЦВЕТА для всех статусов (решение владельца
    // 19.08.2026). Свой класс stage-badge удалён: раздел не объявляет своих
    // пилюль, а этот к тому же нёс внутри номер этапа («0 Новый»), чего нет ни
    // в макете, ни в языке пилюли — она называет состояние, а не нумерует его
    // (Н7, М22).
    //
    // Окраски по номеру этапа здесь БОЛЬШЕ НЕТ и заводить её обратно нельзя.
    // Она красила зелёным всё с этапа 5 и выше, а на реальном справочнике этап 5
    // это «Повторный контакт» — «Не удалось связаться повторно», «Выбрал другой
    // объект», «Отложил покупку»; настоящий успех «Лид переведен «ЯН»» сидит на
    // этапе 4 и оставался серым. Зелёный читался как «хорошо», а означал
    // «этап ≥ 5». Признак «успешный статус» появится полем в справочнике
    // lead_funnel_statuses, а не порогом в коде раздела.
    // У АРХИВНОГО ЛИДА ВМЕСТО ПИЛЮЛИ СТАТУСА — ПИЛЮЛЯ «В архиве», а под ней
    // дата и автор (паспорт Р7). Прежний статус при этом НИКУДА НЕ ДЕЛСЯ: он
    // просто не показан, и потому уезжает в подсказку пилюли — терять значение
    // нельзя, оно понадобится при возврате (правка дизайн-сессии по И110).
    funnelStatus: (l) => {
        if (l.archivedAt) {
            const since = formatDate(l.archivedAt);
            const who = l.archivedActorName ? ` · ${escapeHtml(l.archivedActorName)}` : '';
            const was = l.statusName ? ` title="Прежний статус: ${escapeHtml(l.statusName)}"` : '';
            return `<span class="ui-pill ui-pill--mute"${was}>В архиве</span>`
                + (since ? `<span class="arc-since">с ${since}${who}</span>` : '');
        }
        return l.funnelStatusId
            ? `<span class="ui-pill ui-pill--mute">${escapeHtml(l.statusName)}</span>`
            : null;
    },
    // Линия — обычный текст со значком направления, без рамки-пилюли (М23).
    lineType: (l) => (l.lineType
        ? `<span class="leads-line">${icon(l.lineType === 'Входящая' ? 'arrow-down-left' : 'arrow-up-right', 'sm', 'ui-ic--quiet')}${escapeHtml(l.lineType)}</span>`
        : null),
    // Название основного скрипта + мини-чип «повт.», если задан повторный.
    // Чип синий, когда лид сейчас на этапе 5–6 — то есть оператор видит
    // именно повторный скрипт.
    script: (l) => {
        if (!l.scriptId) return null;
        const onRepeat = l.stageNumber >= REPEAT_STAGE_FROM;
        // Подсвеченный чип означает «оператор сейчас видит именно повторный» —
        // подпись должна говорить то же самое, а не одно и то же в обоих состояниях.
        const chipTitle = onRepeat
            ? `Оператор сейчас видит скрипт для повторных: ${l.repeatScriptTitle || ''}`
            : `Скрипт для повторных: ${l.repeatScriptTitle || ''}`;
        const chip = l.repeatScriptId
            ? `<span class="rep-chip ${onRepeat ? 'on' : ''}" title="${escapeHtml(chipTitle)}">повт.</span>`
            : '';
        return `${escapeHtml(l.scriptTitle || '')}${chip}`;
    },
    // Первый оффер + счётчик остальных, полный список — в подсказке.
    offers: (l) => {
        const offers = l.offers || [];
        if (offers.length === 0) return null;
        const more = offers.length > 1
            ? `<span class="offer-more" title="${escapeHtml(offers.map((o) => o.name).join(', '))}">+${offers.length - 1}</span>`
            : '';
        return `${escapeHtml(offers[0].name)}${more}`;
    }
};

// Ключ колонки -> lead[field] (простой текст).
const COLUMN_CELL = {
    source: (l) => l.sourceName,
    employee: (l) => l.employeeName,
    priceFrom: (l) => l.priceFrom, priceTo: (l) => l.priceTo,
    areaFrom: (l) => l.areaFrom, areaTo: (l) => l.areaTo,
    downPaymentPercent: (l) => l.downPaymentPercent,
    createdAt: (l) => formatDate(l.createdAt), updatedAt: (l) => formatDate(l.updatedAt)
};

function cellHtml(key, lead) {
    if (RICH_CELLS[key]) return RICH_CELLS[key](lead) || '<span class="ui-table__muted">—</span>';
    const getValue = COLUMN_CELL[key] || ((l) => l[key]);
    const value = getValue(lead);
    return value !== null && value !== undefined && value !== '' ? escapeHtml(value) : '<span class="ui-table__muted">—</span>';
}

// Действие -> ключ patch'а и список со значением. Все четыре идут одним
// лёгким bulk-update: полное тело лида для них не требуется, поэтому массово
// править можно и старых лидов без линии/скрипта/офферов (dialog.md B1).
const MASS_PATCH_ACTIONS = {
    employee: { key: 'employeeId', role: 'mass-employee', required: false, done: 'Оператор изменён' },
    status: { key: 'funnelStatusId', role: 'mass-status', required: true, prompt: 'Выберите статус', done: 'Статус изменён' },
    script: { key: 'scriptId', role: 'mass-script', required: true, prompt: 'Выберите скрипт', done: 'Скрипт изменён' },
    repeatScript: { key: 'repeatScriptId', role: 'mass-repeat-script', required: false, done: 'Скрипт для повторных изменён' }
};

// ---------------------------------------------------------------- состояние

let root = null;
// Обёртка раздела (.leads-wrap). Окна открываются в её границах, а не в
// границах контейнера панели: в leads-light.css КАЖДЫЙ селектор ограничен этой
// обёрткой, и окно, вынесенное наружу, осталось бы без раскладки раздела —
// без поля телефона, подсказок адреса, разделов формы и результатов поиска
// офферов. Положение окна от этого не меняется: .ui-modal считается от
// ближайшего позиционированного предка, а это .shell-panel.
let wrap = null;
let shell = null;
let storage = null;
let leadModal = null;
let upload = null;
// Открытые окна раздела, собранные слоем. Нужны, чтобы закрыть их при
// размонтировании: иначе слой остался бы со ссылкой на вырезанный узел и с
// живым слушателем клавиатуры.
let filterModal = null;
let columnsModal = null;

// Номер монтирования. Раздел закрывают и открывают заново, а ответ на запрос,
// ушедший ДО закрытия, приходит после. Отмена запросов обычно срабатывает
// раньше, но полагаться только на неё нельзя: гонку выигрывает то один, то
// другой, и проявится это один раз из ста — данными прошлой панели,
// дорисованными в новую.
let generation = 0;

let sources = [];
let employees = [];
let statuses = [];
let paramLists = {};
let scripts = [];

let leads = [];
let filters = emptyFilters();
// Сколько всего лидов подходит под текущий фильтр — число с сервера, для
// подвала «Показано N из M».
let total = 0;
let searchTimer = null;
let visibleColumns = initialVisibleColumns();
let selectedIds = new Set();
let offset = 0;
let hasMore = true;

// Идёт ли уже догрузка и идёт ли массовое действие. Смещение следующей
// страницы известно только ПОСЛЕ ответа сервера, поэтому два щелчка подряд
// отправляли два запроса с одним и тем же смещением: страница добавлялась в
// список дважды, а смещение уезжало на две страницы вперёд — и пропущенная
// между ними страница становилась недостижимой вовсе.
let loadingMore = false;
let massApplying = false;

// Номер последнего ушедшего запроса списка. Сторожит НЕ размонтирование
// (для него есть generation), а устаревание: смена статуса в тулбаре и набор
// текста в поиске — два разных обработчика, задержка в 300 мс их не разводит,
// и два запроса летят одновременно. Если первый ответит вторым, он перезапишет
// строки и total чужим фильтром: на экране останется прежний список, подвал
// посчитает его по прежнему числу, а чипы будут показывать новый фильтр — и
// само это не исправится до следующего действия человека (К-Ф3 куратора).
let listRequest = 0;

const $ = (sel) => (root ? root.querySelector(sel) : null);
const $$ = (sel) => (root ? Array.from(root.querySelectorAll(sel)) : []);

// Жив ли ТОТ ЖЕ раздел, из которого ушёл запрос. Проверять только «root !==
// null» мало: панель могли закрыть и открыть заново, и тогда ответ старого
// запроса дорисовался бы в новую панель.
function alive(mountId) {
    return root !== null && mountId === generation;
}

function fail(mountId, err) {
    if (!alive(mountId) || isAbort(err)) return;
    shell.toast(err.message, 'error');
}

// Блокировка кнопки на время запроса. Панель могли уже закрыть — тогда узла
// нет, и снимать блокировку не с чего.
function setBusy(selector, busy) {
    const btn = $(selector);
    if (btn) btn.disabled = busy;
}

// ---------------------------------------------------------------- данные

// Справочник офферов сюда НЕ входит: их ≈38 000, раздел ходит только в
// серверный поиск (leadsOffers.js).
async function loadReferenceData() {
    [sources, employees, statuses, paramLists, scripts] = await Promise.all([
        storage.fetchAllSources(), storage.fetchAllEmployees(), storage.fetchFunnelStatuses(),
        storage.fetchParamLists(), storage.fetchActiveScripts()
    ]);
}

async function loadStats(mountId) {
    try {
        const stats = await storage.fetchLeadStats();
        if (!alive(mountId)) return;
        $('[data-role="stat-total"]').textContent = stats.total;
        $('[data-role="stat-queue"]').textContent = stats.queue;
        $('[data-role="stat-today"]').textContent = stats.today;
        // Четвёртое число (И101). Приходит из того же ответа: единственный
        // способ увидеть, что в архиве вообще кто-то есть, не переключаясь туда.
        $('[data-role="stat-archived"]').textContent = stats.archived ?? 0;
        // Подпись шапки — из того же ответа, что и счётчики: день, по которому
        // они посчитаны, и день в подписи обязаны совпадать.
        fillQueueDate(stats.todayDate);
    } catch (e) {
        fail(mountId, e);
    }
}

/**
 * Забирает страницу списка. Возвращает false, если ответ устарел, — вызывающий
 * по этому признаку не рисует: показать устаревшую страницу хуже, чем не
 * показать ничего.
 *
 * Смещение и накопленный список меняются ТОЛЬКО после проверки номера. Пока
 * они менялись до неё, устаревший ответ успевал сдвинуть offset, и следующая
 * догрузка перепрыгивала через страницу.
 */
async function loadLeads({ reset }) {
    const my = (listRequest += 1);
    const from = reset ? 0 : offset;
    // Ответ сервера — { items, total }: total посчитан теми же фильтрами и нужен
    // подвалу. «Есть ли ещё» тоже берётся из него, а не из длины порции:
    // прежняя проверка «пришло ровно PAGE_SIZE» показывала «Показать ещё» и
    // тогда, когда следующая страница пустая.
    const page = await storage.fetchLeads({ ...filters, limit: PAGE_SIZE, offset: from });
    if (my !== listRequest) return false;
    const batch = page.items;
    leads = reset ? batch : leads.concat(batch);
    total = page.total;
    offset = from + batch.length;
    hasMore = leads.length < total;
    return true;
}

async function reloadAll() {
    const my = generation;
    const fresh = await loadLeads({ reset: true });
    if (!alive(my) || !fresh) return;
    renderAll();
    await loadStats(my);
}

// ---------------------------------------------------------------- таблица

function applyColumnVisibility() {
    COLUMN_ORDER.forEach((key) => {
        $$(`[data-col="${key}"]`).forEach((cell) => {
            cell.hidden = !visibleColumns[key];
        });
    });
}

// Ячейка «Номер». У лида, чей номер не приведён к единому виду, рядом с
// номером стоит знак (часть 4, паспорт Р10). Он обязателен, а не желателен:
// решением владельца 65 неразобранный лид попадает в раздачу, включая
// безнадёжных, и между оператором и набором номера, которого нет, не стоит
// больше ничего. Цвет значка берётся из слоя (.ui-ic--warn) — своих цветов
// значкам раздел не пишет.
const PHONE_WARNINGS = {
    hopeless: 'Номер помечен безнадёжным — дозвониться, скорее всего, не выйдет',
    unresolved: 'Номер не приведён к единому виду — наберите как есть'
};

function phoneCell(lead) {
    const number = escapeHtml(lead.phone);
    // phoneNormalized === false, а не «не true»: у лида, заведённого до части 4
    // и ещё не прошедшего миграцию, поле приходит пустым, и знак там соврал бы.
    if (lead.phoneNormalized !== false) return `<span class="lead-phone">${number}</span>`;
    const title = lead.phoneFixVerdict === 'hopeless' ? PHONE_WARNINGS.hopeless : PHONE_WARNINGS.unresolved;
    return `<span class="lead-phone">${number}<svg class="ui-ic ui-ic--sm ui-ic--warn" role="img"` +
        ` aria-label="${escapeHtml(title)}"><title>${escapeHtml(title)}</title>` +
        '<use href="#ui-ic-warn"></use></svg></span>';
}

/**
 * КРАСНОГО ЗНАЧКА В СТРОКЕ ЛИДА НЕТ (паспорт Р7). Вместо него «Отправить в
 * архив» знаком archive, без цвета: действие обратимо, а красный обещал бы
 * необратимость. Единственный красный на весь пункт — «Удалить насовсем» в
 * окне, и там он объяснён.
 *
 * У архивной строки действие одно — «Вернуть из архива». Ни смены оператора,
 * ни смены статуса: любое из них было бы обещанием работы, которой не будет.
 */
function rowActions(lead, archived) {
    if (archived) {
        return `<button type="button" class="ui-btn ui-btn--row" data-unarchive="${lead.id}"`
            + ' title="Вернуть из архива">Вернуть из архива</button>';
    }
    return `
        <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-edit="${lead.id}" title="Изменить" aria-label="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
        <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-archive="${lead.id}" title="Отправить в архив: лид выйдет из раздачи, история останется" aria-label="Отправить в архив"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-archive"></use></svg></button>`;
}

function rowHtml(lead) {
    const name = fullName(lead)
        ? `<span class="ui-table__main">${escapeHtml(fullName(lead))}</span>`
        : '<span class="ui-table__muted">— без ФИО —</span>';
    const archived = Boolean(lead.archivedAt);
    // У АРХИВНОГО В КОЛОНКЕ «Сотрудник» ПРОЧЕРК, а не «в очереди»: он не
    // участвует в раздаче, и плашка «в очереди» обещала бы работу, которой не
    // будет.
    const employeeCell = archived
        ? '<span class="ui-table__muted">—</span>'
        : (lead.employeeId
            ? escapeHtml(lead.employeeName)
            : '<span class="ui-table__muted">не назначен</span><span class="ui-pill ui-pill--warn queue-tag">в очереди</span>');
    const cells = COLUMN_ORDER.map((key) => {
        const body = key === 'employee' ? employeeCell : cellHtml(key, lead);
        return `<td data-col="${key}"${visibleColumns[key] ? '' : ' hidden'}>${body}</td>`;
    }).join('');
    const checked = selectedIds.has(lead.id) ? ' checked' : '';
    // ЧЕКБОКСА У АРХИВНОЙ СТРОКИ НЕТ (ответ И111): массовое действие к ней не
    // применится, а пустой чекбокс обещал бы, что применится.
    const selCell = archived
        ? ''
        : `<input type="checkbox" data-check-id="${lead.id}" aria-label="Выбрать лида ${lead.id}"${checked}>`;
    return `
        <tr class="${selectedIds.has(lead.id) ? 'ui-table__row--selected' : ''}" data-row-id="${lead.id}">
            <td class="ui-table__sel">${selCell}</td>
            <td>${lead.id}</td>
            <td>${name}</td>
            <td>${phoneCell(lead)}</td>
            ${cells}
            <td class="ui-table__acts">${rowActions(lead, archived)}</td>
        </tr>`;
}

function renderTable() {
    applyColumnVisibility();
    renderFooter();
    renderFilterChips();

    if (!leads.length) {
        $('[data-role="leads-body"]').innerHTML = '';
        // Обёртку таблицы прячем целиком: она забирает всю оставшуюся высоту
        // панели, и над сообщением «ничего не найдено» висела бы пустая рамка
        // в треть экрана.
        $('[data-role="table-wrap"]').hidden = true;
        showEmptyState();
        updateMassActionsUI();
        return;
    }
    $('[data-role="table-wrap"]').hidden = false;
    $('[data-role="empty-state"]').hidden = true;
    $('[data-role="leads-body"]').innerHTML = leads.map(rowHtml).join('');
    // Догрузка добавляет невыделенные строки — значит «выделено всё» могло
    // перестать быть правдой, и чекбокс шапки обязан это показать.
    updateMassActionsUI();
}

function renderAll() {
    renderTable();
}

// ---------------------------------------------------------------- подвал и фильтры

// «Показано 30 из 46» — сколько строк на экране из скольких подходящих под
// фильтр. Кнопка догрузки живёт в том же подвале и прячется, когда показано
// всё: кнопка, которая ничего не добавит, читается как поломка.
function renderFooter() {
    const foot = $('[data-role="table-foot"]');
    if (!foot) return;
    // При нуле строк подвал СКРЫТ — вместе с обёрткой таблицы, на их месте
    // встаёт плашка пустого состояния. Одно поведение на три раздела.
    //
    // История правки, чтобы её не переигрывали в третий раз: приёмка части 2
    // записала обратное («счётчик стоит на месте всегда»), куратор нашёл
    // расхождение решения с кодом (К-Ф1), я привёл код к решению — и тогда
    // дизайн-сессия перепроверила замер и отменила своё решение: довод
    // «таблица прыгает» не работает, потому что при нуле строк и так меняется
    // всё сразу, а «Показано 0 из 0» под «Ничего не найдено» говорит то же
    // самое второй раз.
    foot.hidden = total === 0;
    $('[data-role="shown-count"]').textContent = `Показано ${leads.length} из ${total}`;
    $('[data-role="load-more"]').hidden = !hasMore;
}

/**
 * Пустое состояние отвечает на вопрос «почему я ничего не вижу», и ответов два:
 * лидов нет вовсе — или ни один не подошёл под отбор. Прежде текст был один на
 * оба случая и винил фильтры даже там, где их никто не ставил: человек шёл
 * искать и сбрасывать несуществующее (К39).
 */
function showEmptyState() {
    // «Показывать: все» — единственный отбор, который список НЕ укорачивает, а
    // расширяет. Считать его фильтром здесь значит на пустой базе звать
    // «снять лишний фильтр» вместо честного «лидов пока нет».
    const filtered = activeFilterLabels().some((f) => f.key !== 'archived');
    const iconBox = $('[data-role="empty-icon"]');

    // ПУСТОЙ АРХИВ — СВОЁ СОСТОЯНИЕ, а не «ничего не найдено по фильтрам»
    // (паспорт Р7). Общий текст звал бы снять лишний фильтр, хотя снимать
    // нечего: в архив просто ещё ничего не клали.
    //
    // Значок обычный, приглушённый: пустой архив — не хорошая и не плохая
    // новость. Зелёный .ui-empty--good здесь не применяется, и его в слое пока
    // нет вовсе — он объявлен пунктом Р10 и ждёт того, кто соберёт экран первым.
    if (filters.archived === 'only') {
        iconBox.innerHTML = icon('archive', 'lg', 'ui-empty__icon');
        iconBox.hidden = false;
        $('[data-role="empty-title"]').textContent = 'В архиве пусто';
        $('[data-role="empty-text"]').textContent =
            'Ни один лид не отправлен в архив. Отправить можно из списка — '
            + 'кнопкой в строке или пачкой.';
        $('[data-role="empty-state"]').hidden = false;
        return;
    }
    iconBox.hidden = true;
    iconBox.innerHTML = '';

    $('[data-role="empty-title"]').textContent = filtered
        ? 'Ничего не найдено по текущим фильтрам'
        : 'Лидов пока нет';
    $('[data-role="empty-text"]').textContent = filtered
        ? 'Лиды в разделе есть — просто ни один не подходит под отбор. Снимите лишний фильтр в строке выше.'
        : 'Добавьте первого или загрузите базу файлом — обе кнопки в шапке раздела.';
    $('[data-role="empty-state"]').hidden = false;
}

// Подписи активных фильтров: человек видит не «sourceId=4», а
// «Источник: Яндекс.Директ».
function activeFilterLabels() {
    const out = [];
    const nameById = (list, id, field) => {
        const found = list.find((x) => String(x.id) === String(id));
        return found ? found[field] : id;
    };
    if (filters.q) out.push({ key: 'q', label: 'Поиск', value: filters.q });
    // «Показывать» — тоже отбор, и молчать о нём нельзя: человек, переключивший
    // список на архив, иначе не видит ни одного признака, что список урезан, и
    // «Сбросить все» ему этого не предложит (К192). У умолчания «В работе» чипа
    // нет намеренно — чип обещает, что список укорочен, а умолчание показывает
    // то, ради чего раздел существует.
    if (filters.archived) {
        out.push({
            key: 'archived',
            label: 'Показывать',
            value: filters.archived === 'only' ? 'в архиве' : 'все'
        });
    }
    // Чипы — по тому же списку, что и само окно: поле, добавленное в окно и
    // забытое здесь, отбирал бы молча, и короткий список объяснить было бы
    // нечем.
    FILTER_FIELDS.forEach((f) => {
        const value = filters[f.key];
        if (!value) return;
        // «Без оператора» — без приставки: «Сотрудник: Без оператора» читается
        // как имя сотрудника.
        if (f.key === 'employeeId' && value === 'none') {
            out.push({ key: f.key, label: '', value: 'Без оператора' });
            return;
        }
        out.push({
            key: f.key,
            label: f.label,
            value: f.list ? nameById(f.list(), value, f.field) : value
        });
    });
    return out;
}

function renderFilterChips() {
    const box = $('[data-role="filter-chips"]');
    if (!box) return;
    const active = activeFilterLabels();
    box.hidden = active.length === 0;
    const chips = active.map((f) => `
        <span class="ui-fchip">${f.label ? `${escapeHtml(f.label)}: ` : ''}<b>${escapeHtml(String(f.value))}</b>
            <button type="button" class="ui-fchip__remove" data-drop-filter="${f.key}"
                    aria-label="Снять фильтр">${icon('close', 'xs')}</button>
        </span>`).join('');
    box.innerHTML = active.length
        ? `${chips}<button type="button" class="ui-fchips__clear" data-role="clear-filters">Сбросить все</button>`
        : '';
}

// Одно состояние на тулбар и окно «Фильтры»: что бы ни поменяли, поля обоих
// приводятся к нему. Без этого окно показывало бы старое значение поверх
// нового и «сбрасывало» бы фильтр при следующем применении.
function syncFilterControls() {
    const set = (sel, value) => { const node = $(sel); if (node) node.value = value; };
    set('[data-role="search"]', filters.q);
    set('[data-role="quick-archived"]', filters.archived);
    set('[data-role="quick-status"]', filters.funnelStatusId);
    set('[data-role="quick-source"]', filters.sourceId);
    FILTER_FIELDS.forEach((f) => set(f.sel, filters[f.key]));
    const badge = $('[data-role="filter-badge"]');
    if (badge) {
        // Считаются только поля ОКНА (К-Ф4). Поиск живёт в тулбаре, и кружок
        // над кнопкой «Фильтры» обещал бы его содержимым окна: набрал текст в
        // поиске — загорелась единица, открыл окно — пустые поля.
        // Поиск при этом не теряется: он виден в своём поле и назван чипом в
        // строке активных фильтров.
        const activeCount = FILTER_FIELDS.filter((f) => filters[f.key]).length;
        badge.hidden = activeCount === 0;
        badge.textContent = activeCount;
    }
}

async function applyFilterState(mountId) {
    syncFilterControls();
    clearSelection();
    try {
        const fresh = await loadLeads({ reset: true });
        if (!alive(mountId) || !fresh) return;
        renderTable();
    } catch (e) {
        fail(mountId, e);
    }
}

// ---------------------------------------------------------------- массовые действия
// Двухшаговый выбор (действие -> контекстный список), не один <select> с
// захардкоженными парами «действие+значение» — вариантов слишком много
// (~59 статусов, N сотрудников), report_designer.md, п.5.

/**
 * Причина, по которой действие не пойдёт, — строкой в полосе (К46).
 * Исчезает вместе с причиной: при смене выделения, смене действия и после
 * удачного применения. Тост для этого не годился — он уходит через несколько
 * секунд, а выделение и полоса остаются, и объяснения на экране больше нет.
 */
function showMassWarn(text) {
    const node = $('[data-role="mass-warn"]');
    if (!node) return;
    node.textContent = text;
    node.hidden = false;
}

function hideMassWarn() {
    const node = $('[data-role="mass-warn"]');
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
}

function updateMassActionsUI() {
    $('[data-role="selected-count"]').textContent = `Выбрано: ${selectedIds.size}`;
    $('[data-role="mass-bar"]').hidden = selectedIds.size === 0;
    // ВЫДЕЛЕНИЯ НЕ ОСТАЛОСЬ — значит и действия не осталось (К126). Кнопка
    // «Сбросить выделение» сбрасывала действие правильно, а снятие ПОСЛЕДНЕЙ
    // ГАЛКИ — самый обычный способ передумать — нет: полоса пряталась, действие
    // и открытый список операторов в ней оставались, и следующее выделение
    // возвращало полосу в прежнем виде. Выделили входящую линию, выбрали
    // «Сменить оператора», сняли галку, выделили исходящую — и оператор чужой
    // линии назначается в два щелчка мимо проверки, потому что линия у нового
    // выделения одна и она молчит.
    if (selectedIds.size === 0) resetMassAction();
    // Выделение изменилось — прежняя причина могла перестать быть правдой.
    hideMassWarn();
    $('[data-role="head-checkbox"]').checked = leads.length > 0 && leads.every((l) => selectedIds.has(l.id));
}

function clearSelection() {
    selectedIds.clear();
    $$('[data-check-id]').forEach((cb) => { cb.checked = false; });
    $$('tr[data-row-id]').forEach((tr) => tr.classList.remove('ui-table__row--selected'));
    resetMassAction();
    updateMassActionsUI();
}

// Вместе с выделением сбрасывается и выбранное действие. Иначе так: выбрали
// лидов входящей линии, действие «Сменить оператора», применили. Полоса
// спряталась, но в ней остались и действие, и список операторов ВХОДЯЩЕЙ линии.
// Выделяем лидов исходящей — полоса открывается в прежнем виде, проверка линии
// молчит (линия у новых лидов одна), и «Применить» назначает оператора чужой
// линии. Раздача по линии — главное правило раздела, и обойти его выходило в
// два щелчка.
function resetMassAction() {
    const action = $('[data-role="mass-action"]');
    if (action) action.value = '';
    Object.values(MASS_PATCH_ACTIONS).forEach(({ role }) => {
        const select = $(`[data-role="${role}"]`);
        if (!select) return;
        select.hidden = true;
        select.value = '';
    });
}

// Назначить можно только оператора линии лида — значит и список для массового
// действия зависит от выбранных лидов, а не от всех сотрудников сразу.
// Возвращает { error } либо { line }.
function selectedLeadsLine() {
    const lines = new Set(
        Array.from(selectedIds)
            .map((id) => leads.find((l) => l.id === id))
            .filter(Boolean)
            .map((l) => l.lineType || null)
    );
    if (lines.size > 1) return { error: 'Выбраны лиды разных линий — сузьте выбор' };
    const line = lines.values().next().value;
    // Все выбранные без линии: формально линия одна и та же, но подходящих
    // операторов нет. Показывать пустой список нельзя — пользователь не
    // поймёт, сломано это или так задумано (dialog.md B5).
    if (!line) return { error: 'У выбранных лидов не указана линия — сначала заполните её' };
    return { line };
}

function fillMassEmployeeSelect(line) {
    $('[data-role="mass-employee"]').innerHTML = '<option value="">— не назначен —</option>'
        + employees
            .filter((e) => e.lineType === line && e.status === 'active')
            .map((e) => `<option value="${e.id}">${escapeHtml(e.lastName + ' ' + e.firstName)}</option>`)
            .join('');
}

function handleMassActionChange() {
    const action = $('[data-role="mass-action"]').value;
    hideMassWarn();

    if (action === 'employee') {
        const { error, line } = selectedLeadsLine();
        if (error) {
            showMassWarn(error);
            $('[data-role="mass-action"]').value = '';
            $('[data-role="mass-employee"]').hidden = true;
            return;
        }
        fillMassEmployeeSelect(line);
        // Третий случай, которого раньше не было вовсе: линия одна, но
        // активных операторов у неё нет. Список приезжал с единственным
        // пунктом «— не назначен —», и «Применить» снимал оператора со всех
        // выделенных — действие законное, но человек шёл не за ним (К46).
        //
        // Текст про «уже неактивных» здесь стоял по ошибке (К94): он из полосы
        // «Сотрудников», где меняют статус самих сотрудников. Тут никто ничего
        // не «изменяет» — на линии просто некому отдать лидов.
        if ($('[data-role="mass-employee"]').options.length <= 1) {
            showMassWarn('На этой линии нет активных операторов: назначить лид некому');
        }
    }

    $('[data-role="mass-employee"]').hidden = action !== 'employee';
    $('[data-role="mass-status"]').hidden = action !== 'status';
    $('[data-role="mass-script"]').hidden = action !== 'script';
    $('[data-role="mass-repeat-script"]').hidden = action !== 'repeatScript';
}

async function handleMassApply() {
    // Второй щелчок, пока идёт первый, отправлял действие ещё раз: для правки
    // это лишний запрос, а для удаления — второй проход по тем же лидам, где
    // сервер на каждого отвечает «не найден», и человек получает «Не удалось
    // удалить: N» сразу после успешного удаления.
    if (massApplying) return;

    const my = generation;
    const action = $('[data-role="mass-action"]').value;
    if (!action) { showMassWarn('Выберите действие'); return; }
    if (selectedIds.size === 0) { showMassWarn('Выберите хотя бы одного лида'); return; }
    const ids = Array.from(selectedIds);

    // «Отправить в архив» идёт своим путём: это не правка поля, а отдельный
    // маршрут, который сам заводит партию журнала одним запросом.
    if (action === 'archive') {
        massApplying = true;
        setBusy('[data-role="mass-apply"]', true);
        try {
            await runMassArchive(ids, my);
        } finally {
            massApplying = false;
            setBusy('[data-role="mass-apply"]', false);
        }
        return;
    }

    const config = MASS_PATCH_ACTIONS[action];
    if (!config) return;
    // Выделение могли изменить уже после выбора действия — перепроверяем.
    if (action === 'employee') {
        const { error } = selectedLeadsLine();
        if (error) { showMassWarn(error); return; }
    }
    const select = $(`[data-role="${config.role}"]`);
    if (config.required && !select.value) { showMassWarn(config.prompt); return; }

    massApplying = true;
    setBusy('[data-role="mass-apply"]', true);
    try {
        await runMassPatch(config, select, ids, my);
    } finally {
        massApplying = false;
        setBusy('[data-role="mass-apply"]', false);
    }
}

/**
 * Отправка в архив ПАЧКОЙ — одним запросом, а не чередой.
 *
 * Здесь были handleMassDelete и runMassDelete: отдельная кнопка «Удалить» и
 * проход по списку с запросом на каждого лида. Оба убраны паспортом Р7 —
 * массового физического удаления нет вовсе. Необратимое действие над тысячей
 * записей одним нажатием не должно существовать, и подтверждение не помогает:
 * его нажимают не глядя ровно потому, что нажимали уже сто раз.
 *
 * Счётчик «Удалено N из M» в полосе тоже ушёл вместе с ними, и он больше не
 * нужен: сервер отвечает одним числом, ждать нечего.
 */
async function runMassArchive(ids, my) {
    try {
        const res = await storage.bulkArchiveLeads(ids);
        if (!alive(my)) return;
        clearSelection();
        await reloadAll();
        if (!alive(my)) return;
        // Пропущенных называем вслух: человек выделил пятнадцать, а в архив
        // ушло двенадцать — молчание об этом читается как «всё сделано».
        const tail = res.skipped > 0 ? `, пропущено: ${res.skipped} — уже в архиве` : '';
        shell.toast(`В архив отправлено лидов: ${res.archived}${tail}`, 'success');
    } catch (e) {
        fail(my, e);
    }
}

async function runMassPatch(config, select, ids, my) {
    try {
        const { updated } = await storage.bulkUpdateLeads(ids, { [config.key]: select.value || null });
        if (!alive(my)) return;
        clearSelection();
        await reloadAll();
        if (!alive(my)) return;
        shell.toast(`${config.done} у ${updated} лид(ов)`, 'success');
    } catch (e) {
        fail(my, e);
    }
}

// ---------------------------------------------------------------- фильтры

function fillFilterSelects() {
    $('#fltSource').innerHTML = '<option value="">Все источники</option>'
        + sources.map((s) => `<option value="${s.id}">${escapeHtml(s.leadSource || s.rootSource)}</option>`).join('');
    $('#fltEmployee').innerHTML = '<option value="">Все сотрудники</option><option value="none">— без оператора —</option>'
        + employees.map((e) => `<option value="${e.id}">${escapeHtml(e.lastName + ' ' + e.firstName)}</option>`).join('');

    // Списки критериев подбора — из тех же справочников param_lists, что и
    // одноимённые поля карточки: отбор обязан предлагать ровно те значения,
    // которые в карточку можно поставить. Первым пунктом — «Все …».
    FILTER_FIELDS.forEach((f) => {
        if (!f.param && !f.values) return;
        const node = $(f.sel);
        if (!node) return;
        const values = f.values ? f.values() : (paramLists[f.param] || []);
        node.innerHTML = `<option value="">${escapeHtml(f.all)}</option>`
            + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    });

    fillFunnelStatusSelect($('#fltStatus'), statuses, false);
    $('#fltStatus').insertAdjacentHTML('afterbegin', '<option value="">Все статусы</option>');
    // insertAdjacentHTML не переизбирает select — без явного сброса он бы
    // остался на первом реальном статусе, выбранном браузером автоматически
    // ДО вставки плейсхолдера.
    $('#fltStatus').value = '';

    // Те же два списка в тулбаре. Наполняются из тех же справочников — иначе
    // «Все статусы» в строке и в окне однажды разойдутся по составу.
    const quickStatus = $('[data-role="quick-status"]');
    fillFunnelStatusSelect(quickStatus, statuses, false);
    quickStatus.insertAdjacentHTML('afterbegin', '<option value="">Все статусы</option>');
    quickStatus.value = '';

    $('[data-role="quick-source"]').innerHTML = '<option value="">Все источники</option>'
        + sources.map((src) => `<option value="${src.id}">${escapeHtml(src.leadSource || src.rootSource)}</option>`).join('');
}

async function applyFilters() {
    const my = generation;
    // Строка поиска — НЕ поле этого окна и «Применить» её не трогает.
    const next = { q: filters.q };
    FILTER_FIELDS.forEach((f) => {
        const node = $(f.sel);
        next[f.key] = node ? String(node.value).trim() : '';
    });
    filters = next;
    await applyFilterState(my);
}

/** «Сбросить» очищает поля ОКНА, а не всё подряд: строка поиска остаётся. */
function clearFilterFields() {
    FILTER_FIELDS.forEach((f) => {
        const node = $(f.sel);
        if (node) node.value = '';
    });
}

// ---------------------------------------------------------------- колонки

function renderColumnsModalBody() {
    $('[data-role="columns-body"]').innerHTML = COLUMN_GROUPS.map((group) => `
        <div class="col-group">
            <div class="col-group-label">${escapeHtml(group.label)}</div>
            <div class="column-checkbox-list">
                ${group.columns.map((c) => `<label class="column-checkbox-item"><input type="checkbox" data-col-check="${c.key}">${escapeHtml(c.label)}</label>`).join('')}
            </div>
        </div>
    `).join('');
}

// ---------------------------------------------------------------- окна раздела
//
// ОКНА СОБИРАЕТ СЛОЙ (К123, К124). Раньше все четыре были объявлены разметкой
// и показывались снятием hidden: вид у них был правильный, а поведения окна не
// было — фокус при открытии оставался на кнопке-открывашке, Tab на первом же
// шаге уводил в панель под затемнением, а после закрытия фокус уходил в BODY.
//
// Поля при этом никуда не переезжают: блок полей живёт в разметке раздела и на
// время открытия ПЕРЕСТАВЛЯЕТСЯ в коробку окна, а при закрытии возвращается на
// место. Так модули раздела продолжают находить свои сорок с лишним полей по
// id, как и до правки, и всё это время поля остаются внутри .leads-wrap — под
// правилами раскладки раздела.

/** Вернуть блок полей на место в разделе и снова спрятать. */
function parkFields(node) {
    if (!node || !wrap) return;
    node.hidden = true;
    wrap.appendChild(node);
}

function openFilterModal() {
    if (filterModal) return;
    const node = $('[data-role="filter-fields"]');
    if (!node) return;
    syncFilterControls();
    node.hidden = false;

    filterModal = openModal({
        title: 'Фильтры',
        // Подпись называет состав окна, а не «по тем же полям, что и колонки по
        // умолчанию»: полей двадцать, и пять из них отбирают «кто», а пятнадцать
        // — «что ищет».
        sub: 'Пять групп полей: кто, что ищет, диапазоны, география, покупка',
        body: node,
        scope: wrap,
        size: 'wide',
        spread: true,
        actions: [
            {
                label: 'Сбросить',
                variant: 'secondary',
                side: 'start',
                // false — окно остаётся открытым: «Сбросить» чистит поля, а не
                // прощается.
                onClick: () => { clearFilterFields(); return false; }
            },
            // «Отмена» закрывает окно, ничего не применив, и возвращает поля к
            // действующему отбору: набранное, но не применённое, не должно
            // притворяться действующим фильтром при следующем открытии (К56).
            { label: 'Отмена', variant: 'ghost', onClick: () => { syncFilterControls(); } },
            { label: 'Применить', onClick: () => applyFilters() }
        ]
    });
    filterModal.result.then(() => { parkFields(node); filterModal = null; });

    // Фокус — в первое поле. Слой по умолчанию берёт первый фокусируемый
    // элемент коробки, а это крестик закрытия: он выше по разметке.
    const first = $('#fltFio');
    if (first) first.focus();
}

function openColumnsModal() {
    if (columnsModal) return;
    const node = $('[data-role="columns-fields"]');
    if (!node) return;
    $$('[data-col-check]').forEach((cb) => { cb.checked = visibleColumns[cb.dataset.colCheck]; });
    node.hidden = false;

    columnsModal = openModal({
        title: 'Настройка колонок',
        sub: 'ID/ФИО/Номер/Действия — всегда видны',
        body: node,
        scope: wrap,
        spread: true,
        actions: [
            {
                label: 'Сбросить',
                variant: 'secondary',
                side: 'start',
                // Возвращает НАБОР ПО УМОЛЧАНИЮ, а не снимает все галки: из
                // списка о четырёх служебных колонках выбираться пришлось бы
                // вручную.
                onClick: () => {
                    $$('[data-col-check]').forEach((cb) => { cb.checked = COLUMN_DEFAULT[cb.dataset.colCheck]; });
                    return false;
                }
            },
            { label: 'Отмена', variant: 'ghost' },
            { label: 'Применить', onClick: applyColumns }
        ]
    });
    columnsModal.result.then(() => { parkFields(node); columnsModal = null; });

    const first = node.querySelector('[data-col-check]');
    if (first) first.focus();
}

function applyColumns() {
    $$('[data-col-check]').forEach((cb) => { visibleColumns[cb.dataset.colCheck] = cb.checked; });
    // Настройка переживает и панель, и вкладку — общее хранилище вида (К53).
    // Раньше «сохранено» означало «до закрытия панели», и тост об этом умалчивал.
    writeHiddenColumns(COLUMNS_SECTION, COLUMN_ORDER.filter((key) => !visibleColumns[key]));
    renderTable();
    shell.toast('Настройки колонок сохранены', 'success');
}

// ---------------------------------------------------------------- монтирование

// Подпись шапки раздела: «очередь на 19 августа». Раньше здесь стоял абзац на
// две строки, который отодвигал таблицу вниз при каждом открытии (М24).
//
// ДЕНЬ ПРИХОДИТ С СЕРВЕРА (stats.todayDate, YYYY-MM-DD в поясе приложения), а не
// из new Date() браузера. Очередь и счётчик «за сегодня» считает сервер в поясе
// Europe/Moscow; часы браузера у оператора могут стоять в другом поясе, и тогда
// подпись расходилась бы с таблицей под ней (Ф7). Правило проекта: «сегодня»
// фронт берёт только с сервера.
function fillQueueDate(todayDate) {
    const node = $('[data-role="queue-date"]');
    if (!node || !todayDate) return;
    // Разбираем строку сами: new Date('2026-08-19') читается как UTC-полночь и
    // в минусовых поясах отдаёт предыдущий день.
    const [year, month, day] = todayDate.split('-').map(Number);
    const shown = new Date(year, month - 1, day)
        .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    node.textContent = `очередь на ${shown}`;
}

export async function mount(container, ctx) {
    const my = ++generation;
    root = container;
    wrap = container.querySelector('.leads-wrap') || container;
    shell = ctx;
    storage = createStorage(ctx.api);

    // Состояние — заново при каждом монтировании.
    sources = [];
    employees = [];
    statuses = [];
    paramLists = {};
    scripts = [];
    leads = [];
    filters = emptyFilters();
    total = 0;
    clearTimeout(searchTimer);
    visibleColumns = initialVisibleColumns();
    selectedIds = new Set();
    offset = 0;
    hasMore = true;
    loadingMore = false;
    massApplying = false;

    const isAlive = () => alive(my);

    leadModal = createLeadModal(container, {
        wrap,
        confirm: ctx.confirm,
        storage,
        toast: ctx.toast,
        isAlive,
        isAbort,
        createPickList,
        createOfferTabPicker: (opts) => createOfferTabPicker({ ...opts, storage, toast: ctx.toast, isAlive, isAbort }),
        createGeo: () => createGeoAutocomplete(container, { storage, toast: ctx.toast, isAlive, isAbort }),
        onSaved: reloadAll
    });
    upload = createUpload(container, {
        wrap, storage, toast: ctx.toast, isAlive, isAbort, onImported: reloadAll
    });

    try {
        await loadReferenceData();
        if (!isAlive()) return;

        fillFilterSelects();
        renderColumnsModalBody();
        leadModal.init({ sources, employees, statuses, paramLists, scripts });
        upload.init({ sources, employees, statuses, scripts });
        // Обработчики — ПОСЛЕ справочников, а не до. Кнопка «Добавить лида»
        // открывает окно, которое читает списки статусов и офферов; нажатая до
        // загрузки, она роняла бы раздел на пустом мультивыборе. На быстрой
        // сети щель между вставкой разметки и ответом сервера меньше
        // человеческой реакции, на медленной — нет.
        bindHandlers();
        fillFunnelStatusSelect($('[data-role="mass-status"]'), statuses, false);
        // Список сотрудников для массового действия заполняется не здесь, а в
        // момент выбора действия: он зависит от линии выбранных лидов.
        const scriptOptions = scripts.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join('');
        $('[data-role="mass-script"]').innerHTML = '<option value="">— выберите скрипт —</option>' + scriptOptions;
        $('[data-role="mass-repeat-script"]').innerHTML = '<option value="">— снять скрипт —</option>' + scriptOptions;

        await reloadAll();
    } catch (e) {
        fail(my, e);
    }
}

function bindHandlers() {
    const my = generation;

    // Действия строк — делегированием на теле таблицы, а не подпиской на каждую
    // кнопку после каждой перерисовки: список перерисовывается на любой фильтр
    // и на каждую догрузку.
    $('[data-role="leads-body"]').addEventListener('click', async (e) => {
        const editBtn = e.target.closest('[data-edit]');
        if (editBtn) {
            const lead = leads.find((x) => x.id === Number(editBtn.dataset.edit));
            if (lead) await leadModal.open(lead);
            return;
        }
        const archiveBtn = e.target.closest('[data-archive]');
        if (archiveBtn) {
            const target = leads.find((x) => x.id === Number(archiveBtn.dataset.archive));
            if (target) {
                openLeadArchive({
                    scope: wrap,
                    lead: target,
                    storage,
                    toast: shell.toast,
                    onDone: async () => { selectedIds.delete(target.id); await reloadAll(); }
                });
            }
            return;
        }
        const unarchiveBtn = e.target.closest('[data-unarchive]');
        if (unarchiveBtn) {
            const target = leads.find((x) => x.id === Number(unarchiveBtn.dataset.unarchive));
            if (target) {
                openLeadReturn({
                    scope: wrap,
                    lead: target,
                    storage,
                    toast: shell.toast,
                    onDone: async () => { await reloadAll(); }
                });
            }
            return;
        }
        // Здесь была ветка красной кнопки удаления из строки. Кнопки больше
        // нет (паспорт Р7): удаление живёт внутри окна «Отправить в архив» и
        // только там, где оно вообще возможно. Отдельного подтверждения ему не
        // нужно — окно уже назвало последствия и уже спросило.
    });

    // Выделение строки: правим только саму строку, а не перерисовываем таблицу
    // целиком — иначе на каждый щелчок теряется положение прокрутки.
    $('[data-role="leads-body"]').addEventListener('change', (e) => {
        const cb = e.target.closest('[data-check-id]');
        if (!cb) return;
        const id = Number(cb.dataset.checkId);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        const row = cb.closest('tr');
        if (row) row.classList.toggle('ui-table__row--selected', cb.checked);
        updateMassActionsUI();
    });

    $('[data-role="head-checkbox"]').addEventListener('change', (e) => {
        const on = e.target.checked;
        leads.forEach((l) => { if (on) selectedIds.add(l.id); else selectedIds.delete(l.id); });
        $$('[data-check-id]').forEach((cb) => { cb.checked = on; });
        $$('tr[data-row-id]').forEach((tr) => tr.classList.toggle('ui-table__row--selected', on));
        updateMassActionsUI();
    });

    $('[data-role="load-more"]').addEventListener('click', async () => {
        if (loadingMore) return;
        loadingMore = true;
        setBusy('[data-role="load-more"]', true);
        try {
            const fresh = await loadLeads({ reset: false });
            if (!alive(my) || !fresh) return;
            renderTable();
        } catch (e) {
            fail(my, e);
        } finally {
            loadingMore = false;
            setBusy('[data-role="load-more"]', false);
        }
    });

    $('[data-role="add-lead"]').addEventListener('click', () => leadModal.open(null));

    // --- массовые действия ---
    $('[data-role="mass-clear"]').addEventListener('click', clearSelection);
    $('[data-role="mass-action"]').addEventListener('change', handleMassActionChange);
    $('[data-role="mass-apply"]').addEventListener('click', handleMassApply);

    // --- фильтры ---
    $('[data-role="filter-toggle"]').addEventListener('click', openFilterModal);

    // --- тулбар: поиск и два списка ---
    //
    // Поиск с задержкой 300 мс: запрос на каждую букву — это по запросу на
    // символ в общую базу, а человек печатает быстрее, чем сервер отвечает.
    $('[data-role="search"]').addEventListener('input', (e) => {
        const value = e.target.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            if (!alive(my)) return;
            filters = { ...filters, q: value };
            applyFilterState(my);
        }, 300);
    });
    $('[data-role="quick-archived"]').addEventListener('change', (e) => {
        filters = { ...filters, archived: e.target.value };
        applyFilterState(my);
    });
    $('[data-role="quick-status"]').addEventListener('change', (e) => {
        filters = { ...filters, funnelStatusId: e.target.value };
        applyFilterState(my);
    });
    $('[data-role="quick-source"]').addEventListener('change', (e) => {
        filters = { ...filters, sourceId: e.target.value };
        applyFilterState(my);
    });

    // --- строка активных фильтров ---
    //
    // Обработчик на контейнере, а не на чипах: чипы перерисовываются при каждом
    // изменении фильтра, и слушатели на них пришлось бы вешать заново.
    $('[data-role="filter-chips"]').addEventListener('click', (e) => {
        const drop = e.target.closest('[data-drop-filter]');
        if (drop) {
            filters = { ...filters, [drop.dataset.dropFilter]: '' };
            applyFilterState(my);
            return;
        }
        if (e.target.closest('[data-role="clear-filters"]')) {
            filters = emptyFilters();
            applyFilterState(my);
        }
    });

    // --- настройка колонок ---
    $('[data-role="columns-btn"]').addEventListener('click', openColumnsModal);

    // СВОЕГО ОБРАБОТЧИКА Esc У РАЗДЕЛА БОЛЬШЕ НЕТ. Он ставил hidden напрямую,
    // мимо всякой проверки, — и карточка с тремя десятками заполненных полей
    // закрывалась молча именно той дверью, которую нажимают не глядя (К123).
    // Esc, щелчок по затемнению и крестик теперь даёт слой, и все три идут
    // через один и тот же вопрос.
}

export function unmount() {
    generation += 1;   // всё, что было в полёте, теперь чужое

    // Отложенные запросы подсказок и поиска офферов, слушатель документа —
    // снимаются здесь. Ровно на этом «CPA-сети» падали уже после закрытия
    // панели: таймер срабатывал и шёл в обнулённый storage.
    if (leadModal) leadModal.destroy();
    if (upload) upload.destroy();

    // Окна слоя закрываются явно: узлы уйдут вместе с контейнером, но слой
    // остался бы со ссылкой на них в своей стопке и с живым слушателем
    // клавиатуры на документе.
    if (filterModal) filterModal.close(false);
    if (columnsModal) columnsModal.close(false);
    filterModal = null;
    columnsModal = null;

    root = null;
    wrap = null;
    shell = null;
    storage = null;
    leadModal = null;
    upload = null;
    sources = [];
    employees = [];
    statuses = [];
    paramLists = {};
    scripts = [];
    leads = [];
    selectedIds = new Set();
}
