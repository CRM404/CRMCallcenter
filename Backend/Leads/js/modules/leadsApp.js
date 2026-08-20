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
import { createLeadModal, fillFunnelStatusSelect } from './leadsModal.js';
import { createUpload } from './leadsUpload.js';
// Путь АБСОЛЮТНЫЙ: физическая структура папок не совпадает с адресами —
// Backend/Shell/ монтируется в корень «/».
import { isAbort } from '/api.js';
import { icon } from '/ui/icons.js';

const PAGE_SIZE = 30;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    funnelStatus: (l) => (l.funnelStatusId
        ? `<span class="ui-pill ui-pill--mute">${escapeHtml(l.statusName)}</span>`
        : null),
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
let shell = null;
let storage = null;
let leadModal = null;
let upload = null;
// Слушатель на документе — снимается при закрытии панели, иначе они копятся
// с каждым открытием раздела.
let onDocKeydown = null;

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
let filters = { q: '', fio: '', phone: '', sourceId: '', employeeId: '', funnelStatusId: '' };
// Сколько всего лидов подходит под текущий фильтр — число с сервера, для
// подвала «Показано N из M».
let total = 0;
let searchTimer = null;
let visibleColumns = { ...COLUMN_DEFAULT };
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

function rowHtml(lead) {
    const name = fullName(lead)
        ? `<span class="ui-table__main">${escapeHtml(fullName(lead))}</span>`
        : '<span class="ui-table__muted">— без ФИО —</span>';
    const employeeCell = lead.employeeId
        ? escapeHtml(lead.employeeName)
        : '<span class="ui-table__muted">не назначен</span><span class="ui-pill ui-pill--warn queue-tag">в очереди</span>';
    const cells = COLUMN_ORDER.map((key) => {
        const body = key === 'employee' ? employeeCell : cellHtml(key, lead);
        return `<td data-col="${key}"${visibleColumns[key] ? '' : ' hidden'}>${body}</td>`;
    }).join('');
    const checked = selectedIds.has(lead.id) ? ' checked' : '';
    return `
        <tr class="${selectedIds.has(lead.id) ? 'ui-table__row--selected' : ''}" data-row-id="${lead.id}">
            <td class="ui-table__sel"><input type="checkbox" data-check-id="${lead.id}" aria-label="Выбрать лида ${lead.id}"${checked}></td>
            <td>${lead.id}</td>
            <td>${name}</td>
            <td class="lead-phone">${escapeHtml(lead.phone)}</td>
            ${cells}
            <td class="ui-table__acts">
                <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-edit="${lead.id}" title="Изменить" aria-label="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-del="${lead.id}" title="Удалить" aria-label="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
            </td>
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
        $('[data-role="empty-state"]').hidden = false;
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
    // Подвал не прячется даже при нуле строк: «Показано 0 из 0» — тоже ответ,
    // а исчезающая строка дёргает таблицу вверх-вниз на каждом уточнении
    // фильтра. Решение дизайн-сессии от 20.08.2026; до К-Ф1 куратора код делал
    // ровно обратное записанному решению.
    foot.hidden = false;
    $('[data-role="shown-count"]').textContent = `Показано ${leads.length} из ${total}`;
    $('[data-role="load-more"]').hidden = !hasMore;
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
    if (filters.fio) out.push({ key: 'fio', label: 'ФИО', value: filters.fio });
    if (filters.phone) out.push({ key: 'phone', label: 'Номер', value: filters.phone });
    if (filters.sourceId) {
        out.push({ key: 'sourceId', label: 'Источник', value: nameById(sources, filters.sourceId, 'rootSource') });
    }
    if (filters.employeeId === 'none') {
        out.push({ key: 'employeeId', label: '', value: 'Без оператора' });
    } else if (filters.employeeId) {
        out.push({ key: 'employeeId', label: 'Сотрудник', value: nameById(employees, filters.employeeId, 'fullName') });
    }
    if (filters.funnelStatusId) {
        out.push({ key: 'funnelStatusId', label: 'Статус', value: nameById(statuses, filters.funnelStatusId, 'statusName') });
    }
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
                    aria-label="Снять фильтр">${icon('close', 'sm')}</button>
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
    set('[data-role="quick-status"]', filters.funnelStatusId);
    set('[data-role="quick-source"]', filters.sourceId);
    set('#fltFio', filters.fio);
    set('#fltPhone', filters.phone);
    set('#fltSource', filters.sourceId);
    set('#fltEmployee', filters.employeeId);
    set('#fltStatus', filters.funnelStatusId);
    const badge = $('[data-role="filter-badge"]');
    if (badge) {
        const activeCount = Object.values(filters).filter(Boolean).length;
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

function updateMassActionsUI() {
    $('[data-role="selected-count"]').textContent = `Выбрано: ${selectedIds.size}`;
    $('[data-role="mass-bar"]').hidden = selectedIds.size === 0;
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

    if (action === 'employee') {
        const { error, line } = selectedLeadsLine();
        if (error) {
            shell.toast(error, 'error');
            $('[data-role="mass-action"]').value = '';
            $('[data-role="mass-employee"]').hidden = true;
            return;
        }
        fillMassEmployeeSelect(line);
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
    if (!action) { shell.toast('Выберите действие', 'error'); return; }
    if (selectedIds.size === 0) { shell.toast('Выберите хотя бы одного лида', 'error'); return; }
    const ids = Array.from(selectedIds);

    const config = MASS_PATCH_ACTIONS[action];
    let select = null;
    if (action !== 'delete') {
        if (!config) return;
        // Выделение могли изменить уже после выбора действия — перепроверяем.
        if (action === 'employee') {
            const { error } = selectedLeadsLine();
            if (error) { shell.toast(error, 'error'); return; }
        }
        select = $(`[data-role="${config.role}"]`);
        if (config.required && !select.value) { shell.toast(config.prompt, 'error'); return; }
    }

    massApplying = true;
    setBusy('[data-role="mass-apply"]', true);
    try {
        if (action === 'delete') {
            await runMassDelete(ids, my);
        } else {
            await runMassPatch(config, select, ids, my);
        }
    } finally {
        massApplying = false;
        setBusy('[data-role="mass-apply"]', false);
    }
}

async function runMassDelete(ids, my) {
    const ok = await shell.confirmDanger({
        title: 'Удаление лидов',
        message: `Будет удалено: ${ids.length}. Действие необратимо.`
    });
    if (!ok || !alive(my)) return;
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
        try {
            await storage.deleteLead(id);
            deleted++;
        } catch (e) {
            // Отмена = панель закрыли посреди пачки: оставшиеся запросы
            // отбиваются мгновенно, и досчитывать их до конца незачем.
            if (isAbort(e)) return;
            failed++;
        }
        if (!alive(my)) return;
    }
    clearSelection();
    await reloadAll();
    if (!alive(my)) return;
    if (deleted > 0) shell.toast(`Удалено лидов: ${deleted}`, 'success');
    if (failed > 0) shell.toast(`Не удалось удалить: ${failed}`, 'error');
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
        + sources.map((s) => `<option value="${s.id}">${escapeHtml(s.rootSource)}</option>`).join('');
    $('#fltEmployee').innerHTML = '<option value="">Все сотрудники</option><option value="none">— без оператора —</option>'
        + employees.map((e) => `<option value="${e.id}">${escapeHtml(e.lastName + ' ' + e.firstName)}</option>`).join('');
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
        + sources.map((src) => `<option value="${src.id}">${escapeHtml(src.rootSource)}</option>`).join('');
}

async function applyFilters() {
    const my = generation;
    filters = {
        q: filters.q,
        fio: $('#fltFio').value.trim(),
        phone: $('#fltPhone').value.trim(),
        sourceId: $('#fltSource').value,
        employeeId: $('#fltEmployee').value,
        funnelStatusId: $('#fltStatus').value
    };
    $('[data-role="filter-modal"]').hidden = true;
    await applyFilterState(my);
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
    shell = ctx;
    storage = createStorage(ctx.api);

    // Состояние — заново при каждом монтировании.
    sources = [];
    employees = [];
    statuses = [];
    paramLists = {};
    scripts = [];
    leads = [];
    filters = { q: '', fio: '', phone: '', sourceId: '', employeeId: '', funnelStatusId: '' };
    total = 0;
    clearTimeout(searchTimer);
    visibleColumns = { ...COLUMN_DEFAULT };
    selectedIds = new Set();
    offset = 0;
    hasMore = true;
    loadingMore = false;
    massApplying = false;

    const isAlive = () => alive(my);

    leadModal = createLeadModal(container, {
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
        storage, toast: ctx.toast, isAlive, isAbort, onImported: reloadAll
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
        const delBtn = e.target.closest('[data-del]');
        if (!delBtn) return;
        const lead = leads.find((x) => x.id === Number(delBtn.dataset.del));
        if (!lead) return;
        // Удаление необратимо — подтверждение накрывает весь экран, а не только
        // свою панель (правило дизайн-сессии, бриф 5.4).
        const ok = await shell.confirmDanger({
            title: 'Удаление лида',
            message: `Лид #${lead.id}${fullName(lead) ? ' («' + fullName(lead) + '»)' : ''} будет удалён без возможности восстановления.`
        });
        if (!ok || !alive(my)) return;
        try {
            await storage.deleteLead(lead.id);
            if (!alive(my)) return;
            shell.toast('Лид удалён', 'success');
            selectedIds.delete(lead.id);
            await reloadAll();
        } catch (err) {
            fail(my, err);
        }
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
    const filterModal = $('[data-role="filter-modal"]');
    $('[data-role="filter-toggle"]').addEventListener('click', () => { filterModal.hidden = false; });
    $('[data-role="filter-close"]').addEventListener('click', () => { filterModal.hidden = true; });
    filterModal.addEventListener('click', (e) => { if (e.target === filterModal) filterModal.hidden = true; });
    $('[data-role="filter-clear"]').addEventListener('click', () => {
        ['#fltFio', '#fltPhone', '#fltSource', '#fltEmployee', '#fltStatus'].forEach((sel) => { $(sel).value = ''; });
    });
    $('[data-role="filter-apply"]').addEventListener('click', applyFilters);

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
            filters = { q: '', fio: '', phone: '', sourceId: '', employeeId: '', funnelStatusId: '' };
            applyFilterState(my);
        }
    });

    // --- настройка колонок ---
    const columnsModal = $('[data-role="columns-modal"]');
    $('[data-role="columns-btn"]').addEventListener('click', () => {
        $$('[data-col-check]').forEach((cb) => { cb.checked = visibleColumns[cb.dataset.colCheck]; });
        columnsModal.hidden = false;
    });
    $('[data-role="columns-close"]').addEventListener('click', () => { columnsModal.hidden = true; });
    columnsModal.addEventListener('click', (e) => { if (e.target === columnsModal) columnsModal.hidden = true; });
    $('[data-role="columns-reset"]').addEventListener('click', () => {
        $$('[data-col-check]').forEach((cb) => { cb.checked = COLUMN_DEFAULT[cb.dataset.colCheck]; });
    });
    $('[data-role="columns-apply"]').addEventListener('click', () => {
        $$('[data-col-check]').forEach((cb) => { visibleColumns[cb.dataset.colCheck] = cb.checked; });
        columnsModal.hidden = true;
        renderTable();
        shell.toast('Настройки колонок сохранены', 'success');
    });

    // Esc закрывает верхнее открытое окно раздела — правило дизайн-сессии, в
    // слое оно уже соблюдено, а эти четыре окна разметочные (сложные формы, не
    // подтверждения), и Esc им нужно дать вручную. Окно подтверждения удаления
    // приходит из слоя и свой Esc обрабатывает само, поэтому при открытом
    // подтверждении мы не вмешиваемся.
    onDocKeydown = (e) => {
        if (e.key !== 'Escape' || !root) return;
        if (document.querySelector('.ui-modal--screen')) return;
        const open = $$('.leads-modal').filter((m) => !m.hidden);
        if (open.length === 0) return;
        open[open.length - 1].hidden = true;
    };
    document.addEventListener('keydown', onDocKeydown);
}

export function unmount() {
    generation += 1;   // всё, что было в полёте, теперь чужое

    // Отложенные запросы подсказок и поиска офферов, слушатель документа —
    // снимаются здесь. Ровно на этом «CPA-сети» падали уже после закрытия
    // панели: таймер срабатывал и шёл в обнулённый storage.
    if (leadModal) leadModal.destroy();
    if (upload) upload.destroy();

    if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown);
    onDocKeydown = null;

    root = null;
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
