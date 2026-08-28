// --- cpaApp.js: раздел «CPA-сети» в оболочке ---
//
// Контракт раздела:
//     export async function mount(container, ctx)
//     export function unmount()
//
// РАЗДЕЛ ПЕРЕПИСАН НА МАСТЕР-ДЕТАЛЬ (сверка перед мержем, страница 6). Восемнадцать
// корректировок из двадцати семи закрываются одной работой, и вот что изменилось
// против прежнего файла:
//
// 1. Состояние живёт В ЭКЗЕМПЛЯРЕ, а не в модуле. ES-модуль — синглтон: при двух
//    открытых панелях модульные переменные были бы общими, и разделы перетирали
//    бы друг другу выбранную сеть, отбор и открытый оффер.
// 2. Никаких глобальных id — только data-role в границах контейнера (К83). Их
//    было 62, и пять совпадали с «Источниками».
// 3. Сети — список слева, а не полоса вкладок над таблицей (К73). У сети есть
//    статус, число офферов и условия выплаты; во вкладку это не помещается.
// 4. Оба окна раздела собираются вызовом openModal (К74, К78): разметочное окно
//    выглядело как окно, но не приносило ни Esc, ни ловушки фокуса, ни вопроса
//    о несохранённом. «Настройка списков» стала третьим окном вместо режима
//    внутри окна оффера (К146).
// 5. Числовые проверки стоят и на клиенте, и на сервере, тексты совпадают
//    дословно (К85, К86, К87).
//
// Имя файла оставлено прежним намеренно: на него ссылается реестр разделов
// (Shell/shell/app.js) и наборы проверок, а переименование ради соглашения об
// именах — это правка общего файла ради нуля пользы.

import { openModal, confirm } from '/ui/modal.js';
import { isAbort } from '/api.js';
// Окно отказа — общее на пять разделов (ответ на И118): устройство у него
// одно, и пять копий разошлись бы на первой же правке текста.
import { openDeleteBlocked, isDeleteBlocked } from '/deleteBlocked.js';
import { createStorage } from './cpaStorage.js';

const SEARCH_DEBOUNCE_MS = 300;
const GEO_SUGGEST_DEBOUNCE_MS = 300;

// Статусы оффера. Ключ живёт в базе, подпись — на экране, и путать их нельзя:
// по ключу идёт отбор, подпись только читается. Сообщение об ошибке при этом
// называет ПОДПИСИ (К86): человек не видел ни разу ни active, ни draft.
const OFFER_STATUSES = [
    ['active', 'Активен', 'Активные', 'ui-pill--ok'],
    ['paused', 'На паузе', 'На паузе', 'ui-pill--warn'],
    ['disabled', 'Отключён', 'Отключённые', 'ui-pill--mute'],
    ['draft', 'Черновик', 'Черновики', 'ui-pill--bad']
];
const STATUS_LABEL = Object.fromEntries(OFFER_STATUSES.map(([key, label]) => [key, label]));
const STATUS_PILL = Object.fromEntries(OFFER_STATUSES.map(([key, , , pill]) => [key, pill]));

const NETWORK_STATUSES = ['Активна', 'Приостановлена', 'Отключена'];
const NETWORK_PILL = {
    'Активна': 'ui-pill--ok',
    'Приостановлена': 'ui-pill--warn',
    'Отключена': 'ui-pill--mute'
};

// Тринадцать управляемых справочников. PARAM_META описывает только КАК значение
// применяется к полю формы; сами значения приходят с сервера.
//
// target: null — список, поля которого в форме оффера НЕТ. «ЛПР» и «Срок сдачи»
// нужны карточке лида, но управляются здесь: окно одно на проект, и без него
// владелец не смог бы править эти два списка.
const PARAM_META = [
    { key: 'category', label: 'Категория', target: 'category', type: 'select' },
    { key: 'actionType', label: 'Тип действия', target: 'actionType', type: 'select' },
    { key: 'leadCheck', label: 'Наличие проверки лидов', target: 'leadCheck', type: 'select' },
    { key: 'objType', label: 'Тип объекта', target: 'objTypes', type: 'choice' },
    { key: 'objClass', label: 'Класс объекта', target: null, type: 'segments' },
    { key: 'finish', label: 'Отделка', target: 'finishes', type: 'choice' },
    { key: 'rooms', label: 'Комнатность', target: null, type: 'segments' },
    { key: 'clientType', label: 'Тип клиента', target: 'clientTypes', type: 'choice' },
    { key: 'purchaseTerm', label: 'Срок покупки', target: 'purchaseTerm', type: 'select' },
    { key: 'deadline', label: 'Срок сдачи (карточка лида)', target: null, type: 'select' },
    { key: 'paymentMethod', label: 'Способ покупки', target: 'paymentMethods', type: 'choice' },
    { key: 'mortgageType', label: 'Виды ипотеки', target: 'mortgageTypes', type: 'choice' },
    { key: 'decisionMaker', label: 'ЛПР (карточка лида)', target: null, type: 'select' }
];

// Имя поля географии → уровень адреса DaData. «district» — это «район» в
// интерфейсе, но у DaData такой уровень называется area.
const GEO_FIELD_BOUND = { region: 'region', city: 'city', district: 'area', locality: 'settlement' };

const instances = [];

export async function mount(container, ctx) {
    purgeDetached();

    const state = {
        container,
        ctx,
        panel: container.closest('.shell-panel'),
        storage: createStorage(ctx.api),
        networks: [],
        offers: [],
        organization: null,
        paramLists: {},
        networkId: null,
        status: 'all',
        search: '',
        searchTimer: null,
        geoTimer: null,
        geoRequestId: 0,
        // Признак «данные не доехали» (К147). Без него раздел после отказа
        // сервера утверждал, что сетей нет, — и человек шёл заводить сеть,
        // которая уже заведена.
        loadFailed: false,
        destroyed: false
    };
    instances.push(state);

    bindEvents(state);
    await reloadAll(state);
}

export function unmount() {
    const state = instances.pop();
    if (state) destroyInstance(state);
    purgeDetached();
}

/**
 * Слушатели висят на узлах контейнера — оболочка очищает его сразу после
 * unmount. Таймеры нужно снимать руками: они переживут удаление узлов и
 * разбудят мёртвый раздел через треть секунды после закрытия панели.
 */
function destroyInstance(state) {
    state.destroyed = true;
    clearTimeout(state.searchTimer);
    clearTimeout(state.geoTimer);
}

function purgeDetached() {
    for (let i = instances.length - 1; i >= 0; i--) {
        if (!document.contains(instances[i].container)) {
            destroyInstance(instances[i]);
            instances.splice(i, 1);
        }
    }
}

const $ = (state, role) => state.container.querySelector(`[data-role="${role}"]`);

/**
 * Экранирование для вставки в разметку. Кавычки — ОБЯЗАТЕЛЬНО: значения
 * подставляются не только в текст, но и в атрибуты (value="…", title="…"), и
 * имя вида ЖК «Северный» с двойной кавычкой обрывало бы атрибут. Общего
 * escapeHtml в слое по-прежнему нет, копии живут по разделам.
 */
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Числительные согласуются везде, где есть число. */
function plural(n, one, few, many) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 14) return many;
    const ones = n % 10;
    if (ones === 1) return one;
    if (ones >= 2 && ones <= 4) return few;
    return many;
}

const pluralOffers = (n) => plural(n, 'оффер', 'оффера', 'офферов');
const pluralLeads = (n) => plural(n, 'лида', 'лидов', 'лидов');
const pluralSources = (n) => plural(n, 'источник', 'источника', 'источников');

function formatDate(value) {
    if (!value) return '';
    const parts = String(value).split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function formatMoney(value) {
    return Number(value).toLocaleString('ru-RU');
}

/**
 * Период — «с 01.08.2026, бессрочно», а не «01.08.2026 – бессрочно» (К152).
 * Тире между датой и словом читается как вторая граница диапазона, а второй
 * границы тут нет.
 */
function formatPeriod(offer) {
    if (!offer.dateStart && !offer.dateEnd) return null;
    if (!offer.dateStart) return `по ${formatDate(offer.dateEnd)}`;
    if (!offer.dateEnd) return `с ${formatDate(offer.dateStart)}, бессрочно`;
    return `${formatDate(offer.dateStart)} – ${formatDate(offer.dateEnd)}`;
}

const DASH = '<span class="ui-dash">—</span>';

// ---------------------------------------------------------------- данные

/**
 * Один заход за всем сразу — и ОДИН тост на неудачу (К147). До правки каждое
 * упавшее чтение показывало свой тост, и человек получал стопку из четырёх
 * одинаковых «Не удалось связаться с сервером». Тост один на приложение.
 */
async function reloadAll(state) {
    const failures = [];
    const safe = async (label, run, fallback) => {
        try {
            return await run();
        } catch (err) {
            if (isAbort(err)) throw err;
            failures.push(err.message || label);
            return fallback;
        }
    };

    try {
        const [organization, paramLists, networks, offers] = await Promise.all([
            safe('организация', () => state.storage.fetchOrganization(), null),
            safe('справочники', () => state.storage.fetchParamLists(), {}),
            safe('сети', () => state.storage.fetchCpaNetworks(), null),
            safe('офферы', () => state.storage.fetchRealEstateOffers(), null)
        ]);
        if (state.destroyed) return;

        state.organization = organization;
        state.paramLists = paramLists || {};
        // null означает «не смогли прочитать», пустой массив — «прочитали, и там
        // пусто». Разница в том, что показывать под полосой «Данные не
        // загрузились»: пустое состояние или ничего.
        state.loadFailed = networks === null || offers === null;
        state.networks = networks || [];
        state.offers = offers || [];

        if (!state.networks.some((n) => n.id === state.networkId)) {
            state.networkId = state.networks.length ? state.networks[0].id : null;
        }
        if (failures.length) state.ctx.toast(failures[0], 'error');
        renderAll(state);
    } catch (err) {
        // Отмена — не ошибка: панель закрыли, пока данные ехали.
        if (!isAbort(err) && !state.destroyed) state.ctx.toast(err.message, 'error');
    }
}

/** Ошибка одиночного запроса. */
function fail(state, err) {
    if (isAbort(err) || state.destroyed) return;
    state.ctx.toast(err.message, 'error');
}

// ---------------------------------------------------------------- отрисовка

function networkOffers(state) {
    if (state.networkId === null) return [];
    return state.offers.filter((o) => o.networkId === state.networkId);
}

/** Строки после поиска, но ДО отбора по статусу — из них считаются вкладки. */
function searchedOffers(state) {
    const list = networkOffers(state);
    if (!state.search) return list;
    const needle = state.search.toLowerCase();
    return list.filter((o) => String(o.name).toLowerCase().includes(needle));
}

function visibleOffers(state) {
    const list = searchedOffers(state);
    if (state.status === 'all') return list;
    return list.filter((o) => o.status === state.status);
}

function renderAll(state) {
    renderNetworks(state);
    renderDetailHead(state);
    renderTabs(state);
    renderRows(state);
}

function renderNetworks(state) {
    const list = $(state, 'network-list');
    list.innerHTML = state.networks.map((network) => {
        const active = network.id === state.networkId;
        const count = network.offersCount || 0;
        // Подпись собирается из трёх чисел и НЕ слипается (К80): разделитель —
        // « · » с пробелами по обе стороны, отсутствующее значение показывается
        // прочерком. «комиссия — %» лучше, чем «комиссия %».
        const sub = [
            `${count} ${pluralOffers(count)}`,
            `комиссия ${network.commissionPercent === null || network.commissionPercent === undefined ? '—' : network.commissionPercent} %`,
            `выплата в ${network.payoutCurrency || '—'}`
        ].join(' · ');
        // aria-current — не украшение (К141 в «Источниках», то же правило здесь):
        // список сетей это ОТБОР, и состояние не может нести только цвет.
        return `
            <button type="button" class="cpa-network${active ? ' cpa-network--active' : ''}"
                    data-network="${network.id}"${active ? ' aria-current="true"' : ''}>
                <span class="cpa-network__name">
                    <span title="${escapeHtml(network.name)}">${escapeHtml(network.name)}</span>
                    <span class="ui-pill ${NETWORK_PILL[network.status] || 'ui-pill--mute'}">${escapeHtml(network.status)}</span>
                </span>
                <span class="cpa-network__sub">${escapeHtml(sub)}</span>
            </button>`;
    }).join('');

    const total = state.offers.length;
    $(state, 'network-note').textContent = state.networks.length
        ? `Офферов всего: ${total}. Оффер создаётся внутри сети.`
        : 'Пока нет ни одной сети.';

    // Отключённая кнопка объясняет себя (К91). Прежняя просто гасла.
    const addBtn = $(state, 'add-offer');
    addBtn.disabled = state.networkId === null;
    addBtn.title = state.networkId === null ? 'Сначала добавьте сеть в «Управление сетями»' : '';
}

function renderDetailHead(state) {
    const head = $(state, 'detail-head');
    const network = state.networks.find((n) => n.id === state.networkId);
    if (!network) {
        head.hidden = true;
        return;
    }
    head.hidden = false;
    $(state, 'detail-title').textContent = network.name;

    const offers = networkOffers(state);
    // Пустая ставка НЕ считается нулём: Number(null) даёт 0, и сеть без единой
    // заданной ставки показывала бы «средняя ставка 0 ₽» вместо честного
    // «ставка не задана». Отсеиваем до приведения к числу.
    const rates = offers
        .filter((o) => o.rate !== null && o.rate !== undefined && String(o.rate).trim() !== '')
        .map((o) => Number(o.rate))
        .filter((n) => Number.isFinite(n));
    const average = rates.length
        ? `средняя ставка ${formatMoney(Math.round(rates.reduce((sum, n) => sum + n, 0) / rates.length))} ₽`
        : 'ставка не задана';
    $(state, 'detail-sub').textContent = `${offers.length} ${pluralOffers(offers.length)} · ${average}`;
}

function renderTabs(state) {
    const list = searchedOffers(state);
    const counts = { all: list.length };
    OFFER_STATUSES.forEach(([key]) => {
        counts[key] = list.filter((o) => o.status === key).length;
    });

    // Порядок вкладок — жизненный цикл: работает → приостановлен → выключен →
    // ещё не запущен. Черновик последний не потому, что он неважен, а потому,
    // что он не участвует в передаче лидов.
    const tabs = [['all', 'Все']].concat(OFFER_STATUSES.map(([key, , plural]) => [key, plural]));
    $(state, 'status-tabs').innerHTML = tabs.map(([key, label]) => `
        <button type="button" class="ui-tabs__tab${key === state.status ? ' ui-tabs__tab--active' : ''}${counts[key] === 0 && key !== 'all' ? ' ui-tabs__tab--quiet' : ''}"
                data-status="${escapeHtml(key)}">
            ${escapeHtml(label)} <span class="ui-tabs__count">${counts[key]}</span>
        </button>`).join('');
}

function renderRows(state) {
    const rows = visibleOffers(state);
    const body = $(state, 'rows');
    const wrap = $(state, 'table-wrap');
    const foot = $(state, 'foot');

    if (!rows.length) {
        body.innerHTML = '';
        wrap.hidden = true;
        foot.hidden = true;
        showEmpty(state);
        return;
    }

    $(state, 'empty').hidden = true;
    wrap.hidden = false;
    foot.hidden = false;

    body.innerHTML = rows.map((offer) => {
        const period = formatPeriod(offer);
        const leads = offer.leadsCount || 0;
        return `
            <tr data-id="${offer.id}">
                <td>
                    <div class="cpa-offer-name">${escapeHtml(offer.name)}</div>
                    <div class="cpa-offer-cat">${offer.category ? escapeHtml(offer.category) : DASH}</div>
                </td>
                <td>${offer.actionType ? escapeHtml(offer.actionType) : DASH}</td>
                <td class="ui-table__num">${offer.rate === null || offer.rate === undefined ? DASH : `${formatMoney(offer.rate)} ₽`}</td>
                <td>${period ? escapeHtml(period) : DASH}</td>
                <td class="ui-table__num">${leads ? leads : '<span class="ui-table__muted">0</span>'}</td>
                <td><span class="ui-pill ${STATUS_PILL[offer.status] || 'ui-pill--mute'}">${escapeHtml(STATUS_LABEL[offer.status] || offer.status)}</span></td>
                <td class="ui-table__acts">
                    <span class="cpa-cell-actions">
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-edit="${offer.id}" title="Настроить" aria-label="Настроить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-copy="${offer.id}" title="Скопировать" aria-label="Скопировать"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-copy"></use></svg></button>
                        <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-del="${offer.id}" title="Удалить" aria-label="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                    </span>
                </td>
            </tr>`;
    }).join('');

    // M — сколько строк подошло под текущий отбор. Раздел показывает все
    // подошедшие сразу, поэтому числа равны, и подвал отвечает на вопрос
    // «всё ли я вижу из того, что подошло».
    $(state, 'foot-shown').textContent = `Показано ${rows.length} из ${rows.length}`;
}

/**
 * Пустое состояние: причина и следующий шаг, и признак у каждого случая свой
 * (К79). Прежнее одно на три случая говорило про «поиск и фильтр статуса»
 * разом и не давало ни одной кнопки — сбрасывать надо разное.
 */
function showEmpty(state) {
    const empty = $(state, 'empty');
    const title = $(state, 'empty-title');
    const text = $(state, 'empty-text');
    const action = $(state, 'empty-action');

    // Данные не доехали — говорить «записей нет» нельзя (К147). Полоса «Данные
    // не загрузились» уже висит сверху и объясняет причину честно.
    if (state.loadFailed) {
        empty.hidden = true;
        return;
    }

    empty.hidden = false;
    action.hidden = true;
    action.dataset.act = '';

    if (!state.networks.length) {
        title.textContent = 'Сетей пока нет';
        text.textContent = 'Добавьте первую сеть в окне «Управление сетями» — офферы заводятся внутри неё.';
        action.hidden = false;
        action.textContent = 'Управление сетями';
        action.dataset.act = 'networks';
        return;
    }
    // Отбор виноват только тогда, когда есть из чего отбирать: у пустой сети
    // формально активен и поиск, и статус, но правдивый ответ — «офферов нет».
    const hasAny = networkOffers(state).length > 0;
    if (state.search && hasAny) {
        title.textContent = 'Ничего не найдено по запросу';
        text.textContent = 'Проверьте написание или сбросьте поиск — офферы в этой сети есть, просто не по этому запросу.';
        action.hidden = false;
        action.textContent = 'Сбросить поиск';
        action.dataset.act = 'clear-search';
        return;
    }
    if (state.status !== 'all' && hasAny) {
        title.textContent = 'Нет офферов с таким статусом';
        text.textContent = 'В этой сети есть офферы, но ни один не подходит под текущий отбор.';
        action.hidden = false;
        action.textContent = 'Показать все';
        action.dataset.act = 'clear-status';
        return;
    }
    title.textContent = 'В этой сети пока нет офферов';
    text.textContent = 'Добавьте первый оффер — он появится в списке этой сети.';
    action.hidden = false;
    action.textContent = 'Добавить оффер';
    action.dataset.act = 'add-offer';
}

// ---------------------------------------------------------------- события

function bindEvents(state) {
    const { container } = state;

    container.addEventListener('click', async (event) => {
        const target = event.target;

        const networkBtn = target.closest('[data-network]');
        if (networkBtn && container.contains(networkBtn)) {
            state.networkId = Number(networkBtn.dataset.network);
            // Смена сети НЕ сбрасывает отбор по статусу и поиск: человек,
            // который смотрит черновики в одной сети, обычно хочет увидеть
            // черновики и в соседней.
            renderAll(state);
            return;
        }

        const tab = target.closest('[data-status]');
        if (tab) {
            state.status = tab.dataset.status;
            renderTabs(state);
            renderRows(state);
            return;
        }

        const edit = target.closest('[data-edit]');
        if (edit) {
            const offer = state.offers.find((o) => o.id === Number(edit.dataset.edit));
            if (offer) await openOfferModal(state, offer);
            return;
        }
        const copy = target.closest('[data-copy]');
        if (copy) {
            const offer = state.offers.find((o) => o.id === Number(copy.dataset.copy));
            if (offer) await openOfferModal(state, offer, { asCopy: true });
            return;
        }
        const del = target.closest('[data-del]');
        if (del) {
            const offer = state.offers.find((o) => o.id === Number(del.dataset.del));
            if (offer) await removeOffer(state, offer);
            return;
        }

        if (target.closest('[data-role="add-offer"]')) {
            await openOfferModal(state, null);
            return;
        }
        if (target.closest('[data-role="manage-networks"]')) {
            openNetworksModal(state);
            return;
        }
        if (target.closest('[data-role="add-network"]')) {
            openNetworksModal(state, { openForm: true });
            return;
        }
        if (target.closest('[data-role="edit-network"]')) {
            openNetworksModal(state, { editId: state.networkId });
            return;
        }
        if (target.closest('[data-role="params-lists"]')) {
            await openParamsModal(state);
            return;
        }

        const emptyAction = target.closest('[data-role="empty-action"]');
        if (emptyAction) {
            const act = emptyAction.dataset.act;
            if (act === 'networks') openNetworksModal(state);
            else if (act === 'add-offer') await openOfferModal(state, null);
            else if (act === 'clear-search') {
                state.search = '';
                $(state, 'search').value = '';
                renderAll(state);
            } else if (act === 'clear-status') {
                state.status = 'all';
                renderAll(state);
            }
        }
    });

    const searchField = $(state, 'search');
    const scheduleSearch = (value) => {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => {
            if (state.destroyed) return;
            state.search = value;
            renderTabs(state);
            renderRows(state);
        }, SEARCH_DEBOUNCE_MS);
    };
    searchField.addEventListener('input', (event) => scheduleSearch(event.target.value.trim()));
    // У type="search" есть свой крестик и Esc: браузер чистит поле, а события
    // input при этом может и не быть.
    searchField.addEventListener('search', (event) => scheduleSearch(event.target.value.trim()));
}

// ---------------------------------------------------------------- окно оффера

function fieldBlock({ label, name, control, hint, wide = true, required = false }) {
    return `
        <div class="ui-field${wide ? ' ui-field--wide' : ''}" data-field-box="${name}">
            <label class="ui-field__label${required ? ' ui-field__label--required' : ''}"${control.startsWith('<select') || control.startsWith('<input') || control.startsWith('<textarea') ? ` for="cpa-${name}"` : ''}>${escapeHtml(label)}</label>
            ${control}
            ${hint ? `<span class="ui-field__hint">${escapeHtml(hint)}</span>` : ''}
            <span class="ui-field__error"></span>
        </div>`;
}

function selectControl(name, values, selected) {
    const options = (values || []).map((v) =>
        `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
    return `<select class="ui-field__control" id="cpa-${name}" data-field="${name}">${options}</select>`;
}

function inputControl(name, type, value, placeholder) {
    return `<input class="ui-field__control" id="cpa-${name}" data-field="${name}" type="${type}"
                   value="${escapeHtml(value === null || value === undefined ? '' : value)}"
                   placeholder="${escapeHtml(placeholder || '')}">`;
}

/**
 * Множественный выбор — .ui-choice ИЗ СЛОЯ (К82). Свой .chip-opt раздел объявлял
 * с тех пор, когда был отдельной страницей; тот же вид уже работает в
 * «Источниках», и второй его копии в проекте быть не должно.
 */
function choiceControl(name, values, selected) {
    const chosen = selected || [];
    const items = (values || []).map((value) => {
        const on = chosen.includes(value);
        return `<label class="ui-choice${on ? ' ui-choice--on' : ''}">
                    <input type="checkbox" value="${escapeHtml(value)}"${on ? ' checked' : ''}>${escapeHtml(value)}
                </label>`;
    }).join('');
    return `<div class="ui-choices" data-field="${name}">${items || '<span class="ui-field__hint">Список пуст — заполните его в «Настройке списков».</span>'}</div>`;
}

function sectionHead(icon, title, sub) {
    return `
        <div class="cpa-form-sec">
            <span class="cpa-form-sec__icon"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-${icon}"></use></svg></span>
            <div>
                <h3>${escapeHtml(title)}</h3>
                <span>${escapeHtml(sub)}</span>
            </div>
        </div>`;
}

// Обязательные и числовые поля окна — в порядке формы. Отсюда берутся и подписи
// для тоста, и порядок, в котором ищется первое незаполненное.
const REQUIRED_OFFER_FIELDS = [['name', 'Название']];

// Числовые проверки стоят наравне с обязательными (К85): ставка, hold, взнос,
// приоритет и лимит — то, по чему считаются деньги и очередь передачи, и
// неправильное значение здесь дороже пустого названия. Тексты дословно те же,
// что на сервере.
const NUMBER_RULES = [
    ['rate', 'Ставка должна быть числом не меньше нуля', (n) => n >= 0],
    ['holdDays', 'Hold должен быть целым числом дней', (n) => Number.isInteger(n) && n >= 0],
    ['downPaymentPercent', 'Первоначальный взнос должен быть числом от 0 до 100', (n) => n >= 0 && n <= 100],
    ['priority', 'Приоритет — число от 1 до 5', (n) => Number.isInteger(n) && n >= 1 && n <= 5],
    ['leadLimit', 'Лимит лидов должен быть целым числом больше нуля', (n) => Number.isInteger(n) && n > 0]
];

async function openOfferModal(state, offer, opts = {}) {
    const asCopy = !!opts.asCopy;
    const preset = opts.preset || null;

    // Справочники перечитываются при каждом открытии окна: вкладка могла
    // провисеть открытой, пока их менял кто-то другой.
    try {
        const lists = await state.storage.fetchParamLists();
        if (state.destroyed) return;
        state.paramLists = lists;
    } catch (err) {
        fail(state, err);
    }

    const network = state.networks.find((n) => n.id === state.networkId);
    if (!network) {
        // Тот же текст, что на сервере (К87).
        state.ctx.toast('Заполните обязательное поле: Сеть', 'error');
        return;
    }

    const value = preset || offer || {};
    const lists = state.paramLists || {};
    const body = document.createElement('div');
    body.innerHTML = `
        <div class="ui-form-grid">
            ${fieldBlock({ label: 'Название', name: 'name', required: true,
                control: inputControl('name', 'text', asCopy && !preset ? `${value.name || ''} (копия)` : (value.name || ''), 'Название оффера') })}
            ${fieldBlock({ label: 'Категория', name: 'category', wide: false,
                control: selectControl('category', lists.category, value.category) })}
            ${fieldBlock({ label: 'Статус', name: 'status', wide: false,
                control: `<select class="ui-field__control" id="cpa-status" data-field="status">${OFFER_STATUSES.map(([key, label]) => {
                    const current = asCopy ? 'draft' : (value.status || 'draft');
                    return `<option value="${key}"${key === current ? ' selected' : ''}>${label}</option>`;
                }).join('')}</select>` })}
            ${fieldBlock({ label: 'Период действия', name: 'period', hint: 'Пусто в конце периода значит «бессрочно».',
                control: `<div class="cpa-range">
                    ${inputControl('dateStart', 'date', value.dateStart, '')}
                    <span>—</span>
                    ${inputControl('dateEnd', 'date', value.dateEnd, '')}
                </div>` })}
        </div>

        ${sectionHead('target', 'Настройки оффера', 'условия выплаты и критерии лида')}
        <div class="ui-form-grid">
            <div class="ui-field ui-field--wide">
                <div class="cpa-compact-row">
                    ${['actionType', 'rate', 'holdDays', 'leadCheck'].map((name) => {
                        const labels = { actionType: 'Тип действия', rate: 'Ставка, ₽', holdDays: 'Hold, дней', leadCheck: 'Наличие проверки лидов' };
                        const control = name === 'actionType' ? selectControl('actionType', lists.actionType, value.actionType)
                            : name === 'leadCheck' ? selectControl('leadCheck', lists.leadCheck, value.leadCheck)
                            : inputControl(name, 'number', value[name], name === 'rate' ? '1200' : '14');
                        return `<div class="ui-field cpa-compact-field" data-field-box="${name}">
                                    <label class="ui-field__label" for="cpa-${name}">${labels[name]}</label>
                                    ${control}
                                    <span class="ui-field__error"></span>
                                </div>`;
                    }).join('')}
                </div>
            </div>
            ${fieldBlock({ label: 'Критерии целевого лида', name: 'targetCriteria',
                control: `<textarea class="ui-field__control" id="cpa-targetCriteria" data-field="targetCriteria" placeholder="Например: подтверждённый номер, бюджет от…">${escapeHtml(value.targetCriteria || '')}</textarea>` })}
            ${fieldBlock({ label: 'Критерии нецелевого лида', name: 'nonTargetCriteria',
                control: `<textarea class="ui-field__control" id="cpa-nonTargetCriteria" data-field="nonTargetCriteria" placeholder="Например: дубликат, невалидный номер…">${escapeHtml(value.nonTargetCriteria || '')}</textarea>` })}
        </div>

        ${sectionHead('layers', 'Фильтр объектов', 'какие объекты подходят под оффер')}
        <div class="ui-form-grid">
            ${fieldBlock({ label: 'Тип объекта', name: 'objTypes', hint: 'Можно выбрать несколько. Ничего не выбрано — подходит любой.',
                control: choiceControl('objTypes', lists.objType, value.objTypes) })}
            ${fieldBlock({ label: 'Отделка', name: 'finishes', hint: 'Можно выбрать несколько. Ничего не выбрано — подходит любая.',
                control: choiceControl('finishes', lists.finish, value.finishes) })}
            ${fieldBlock({ label: 'Застройщик', name: 'developer', wide: false,
                control: inputControl('developer', 'text', value.developer, 'Например: ПИК, Самолет') })}
            ${fieldBlock({ label: 'Срок сдачи', name: 'deadline', wide: false,
                control: inputControl('deadline', 'text', value.deadline, 'до 4 кв. 2027 / сдан') })}
            ${fieldBlock({ label: 'Цена и площадь по сегментам', name: 'segments',
                hint: 'Класс объекта и комнатность задаются внутри сегмента: у разных диапазонов цены они разные.',
                control: `<div class="cpa-repeat-rows" data-role="segments"></div>
                    <button type="button" class="ui-btn ui-btn--ghost ui-btn--add" data-role="add-segment">
                        <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg>Добавить сегмент
                    </button>` })}
            ${fieldBlock({ label: 'География объекта', name: 'objGeo',
                hint: 'Регион, город, район, населённый пункт. Пустой уровень значит «любой»; подсказка приходит для того уровня, в котором печатают.',
                control: `<div class="cpa-repeat-rows" data-role="obj-geo"></div>
                    <button type="button" class="ui-btn ui-btn--ghost ui-btn--add" data-role="add-obj-geo">
                        <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg>Добавить географию
                    </button>` })}
        </div>

        ${sectionHead('user', 'Требования к клиенту', 'какой покупатель подходит под оффер')}
        <div class="ui-form-grid">
            ${fieldBlock({ label: 'Тип клиента', name: 'clientTypes', hint: 'Можно выбрать несколько. Ничего не выбрано — подходит любой.',
                control: choiceControl('clientTypes', lists.clientType, value.clientTypes) })}
            ${fieldBlock({ label: 'Иной заёмщик', name: 'otherBorrower',
                hint: 'Поле появляется, когда среди типов клиента выбран «Пенсионер».',
                control: `<div data-role="other-borrower-box">
                    <label class="ui-choice${value.otherBorrower ? ' ui-choice--on' : ''}">
                        <input type="checkbox" data-field="otherBorrower"${value.otherBorrower ? ' checked' : ''}>Заёмщик может быть другим человеком
                    </label>
                </div>` })}
            ${fieldBlock({ label: 'Срок покупки', name: 'purchaseTerm', wide: false,
                control: selectControl('purchaseTerm', lists.purchaseTerm, value.purchaseTerm) })}
            ${fieldBlock({ label: 'Первоначальный взнос, %', name: 'downPaymentPercent', wide: false,
                control: inputControl('downPaymentPercent', 'number', value.downPaymentPercent, '20') })}
            ${fieldBlock({ label: 'Способ покупки', name: 'paymentMethods',
                hint: 'Можно выбрать несколько. «Виды ипотеки» появятся, если среди выбранного есть ипотека.',
                control: choiceControl('paymentMethods', lists.paymentMethod, value.paymentMethods) })}
            ${fieldBlock({ label: 'Виды ипотеки', name: 'mortgageTypes', hint: 'Можно выбрать несколько.',
                control: choiceControl('mortgageTypes', lists.mortgageType, value.mortgageTypes) })}
            ${fieldBlock({ label: 'География клиента', name: 'clientGeo',
                hint: 'Тот же принцип, что у объекта, но про самого покупателя.',
                control: `<div class="cpa-repeat-rows" data-role="client-geo"></div>
                    <button type="button" class="ui-btn ui-btn--ghost ui-btn--add" data-role="add-client-geo">
                        <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg>Добавить географию
                    </button>` })}
        </div>

        ${sectionHead('shield', 'Настройки обработки', 'приоритет и лимиты передачи лида')}
        <div class="ui-form-grid">
            ${/* ЗВЁЗДОЧКА ПРИЕХАЛА ВМЕСТЕ С ОБЯЗАТЕЛЬНОСТЬЮ (наряд части 9,
                  раздел 3: «приоритет получает звёздочку и отказ сохранения при
                  пустом»). Отказ без метки означал бы поле, которое молча не
                  сохраняется, — то же самое, что обещание без исполнения, только
                  в обратную сторону. */''}
            ${fieldBlock({ label: 'Приоритет', name: 'priority', wide: false, required: true,
                hint: 'Число от 1 до 5, где 1 — высший. Решает, по какому офферу переводят лида.',
                control: inputControl('priority', 'number', value.priority, '1') })}
            ${fieldBlock({ label: 'Лимит лидов', name: 'leadLimit', wide: false, hint: 'На весь срок оффера; пусто — без лимита.',
                control: inputControl('leadLimit', 'number', value.leadLimit, '300') })}
        </div>`;

    const field = (name) => body.querySelector(`[data-field="${name}"]`);
    const fieldBox = (name) => body.querySelector(`[data-field-box="${name}"]`);

    // Повторяющиеся строки живут в замыкании окна, а не в модуле: два окна
    // одного раздела одновременно не бывают, но состояние формы принадлежит
    // форме.
    let segments = (value.segments || []).map((s) => ({ ...s }));
    let objGeo = (value.objGeo || []).map((r) => ({ ...r }));
    let clientGeo = (value.clientGeo || []).map((r) => ({ ...r }));

    const chosen = (name) => Array.from(body.querySelectorAll(`[data-field="${name}"] input:checked`)).map((c) => c.value);

    function renderSegments() {
        const box = body.querySelector('[data-role="segments"]');
        box.innerHTML = segments.map((s, index) => `
            <div class="cpa-repeat-row cpa-segment-row" data-index="${index}">
                <select class="ui-field__control" data-seg="objectClass" aria-label="Класс объекта">
                    <option value="">Класс объекта</option>
                    ${(lists.objClass || []).map((v) => `<option value="${escapeHtml(v)}"${s.objectClass === v ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                </select>
                <select class="ui-field__control" data-seg="roomCount" aria-label="Комнатность">
                    <option value="">Комнатность</option>
                    ${(lists.rooms || []).map((v) => `<option value="${escapeHtml(v)}"${s.roomCount === v ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                </select>
                <div class="cpa-range">
                    <input class="ui-field__control" type="number" data-seg="priceMin" placeholder="цена от" value="${escapeHtml(s.priceMin ?? '')}" aria-label="Цена от">
                    <span>—</span>
                    <input class="ui-field__control" type="number" data-seg="priceMax" placeholder="цена до" value="${escapeHtml(s.priceMax ?? '')}" aria-label="Цена до">
                </div>
                <div class="cpa-range">
                    <input class="ui-field__control" type="number" data-seg="areaMin" placeholder="S от" value="${escapeHtml(s.areaMin ?? '')}" aria-label="Площадь от">
                    <span>—</span>
                    <input class="ui-field__control" type="number" data-seg="areaMax" placeholder="S до" value="${escapeHtml(s.areaMax ?? '')}" aria-label="Площадь до">
                </div>
                <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-remove-segment="${index}" title="Удалить сегмент" aria-label="Удалить сегмент"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
            </div>`).join('')
            || '<div class="ui-empty ui-empty--inline"><span class="ui-empty__text">Сегментов пока нет — по умолчанию действует общий фильтр по типу выше.</span></div>';
    }

    function renderGeo(role, store) {
        const box = body.querySelector(`[data-role="${role}"]`);
        box.innerHTML = store.map((row, index) => `
            <div class="cpa-repeat-row cpa-geo-row" data-index="${index}">
                ${[['region', 'Регион'], ['city', 'Город'], ['district', 'Район'], ['locality', 'Нас. пункт']].map(([name, label]) => `
                    <div class="cpa-geo-field">
                        <input class="ui-field__control" data-geo="${name}" placeholder="${label}" value="${escapeHtml(row[name] || '')}" aria-label="${label}">
                    </div>`).join('')}
                <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-remove-geo="${index}" title="Удалить строку" aria-label="Удалить строку"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
            </div>`).join('')
            || '<div class="ui-empty ui-empty--inline"><span class="ui-empty__text">География не задана — оффер считается доступным по всей стране.</span></div>';
        attachGeoSuggest(state, box, store);
    }

    // Поля повторяющихся строк не пишут значения в store по мере ввода — только
    // при сохранении. Без этой подстраховки перед каждым добавлением и
    // удалением уже введённое, но не сохранённое стиралось бы новым рендером.
    function syncSegments() {
        const rows = Array.from(body.querySelectorAll('[data-role="segments"] .cpa-segment-row'));
        segments = rows.map((row) => ({
            objectClass: row.querySelector('[data-seg="objectClass"]').value,
            roomCount: row.querySelector('[data-seg="roomCount"]').value,
            priceMin: row.querySelector('[data-seg="priceMin"]').value,
            priceMax: row.querySelector('[data-seg="priceMax"]').value,
            areaMin: row.querySelector('[data-seg="areaMin"]').value,
            areaMax: row.querySelector('[data-seg="areaMax"]').value
        }));
    }

    function syncGeo(role, store) {
        const rows = Array.from(body.querySelectorAll(`[data-role="${role}"] .cpa-geo-row`));
        rows.forEach((row, index) => {
            if (!store[index]) return;
            Object.keys(GEO_FIELD_BOUND).forEach((name) => {
                store[index][name] = row.querySelector(`[data-geo="${name}"]`).value;
            });
        });
    }

    // Три каскада, и каждый объявлен подсказкой заранее: поле, появляющееся без
    // предупреждения, читается как сбой.
    function syncCascades() {
        const retiree = chosen('clientTypes').includes('Пенсионер');
        fieldBox('otherBorrower').hidden = !retiree;
        if (!retiree) {
            const checkbox = field('otherBorrower');
            checkbox.checked = false;
            checkbox.closest('.ui-choice').classList.remove('ui-choice--on');
        }
        const mortgage = chosen('paymentMethods').some((v) => v.toLowerCase().includes('ипотек'));
        fieldBox('mortgageTypes').hidden = !mortgage;
    }

    body.addEventListener('change', (event) => {
        const choice = event.target.closest('.ui-choice input');
        if (choice) {
            choice.closest('.ui-choice').classList.toggle('ui-choice--on', choice.checked);
            syncCascades();
        }
    });

    body.addEventListener('click', (event) => {
        if (event.target.closest('[data-role="add-segment"]')) {
            syncSegments();
            segments.push({ objectClass: '', roomCount: '', priceMin: '', priceMax: '', areaMin: '', areaMax: '' });
            renderSegments();
            return;
        }
        const removeSegment = event.target.closest('[data-remove-segment]');
        if (removeSegment) {
            syncSegments();
            segments.splice(Number(removeSegment.dataset.removeSegment), 1);
            renderSegments();
            return;
        }
        const addGeo = event.target.closest('[data-role="add-obj-geo"]') || event.target.closest('[data-role="add-client-geo"]');
        if (addGeo) {
            const isObject = addGeo.dataset.role === 'add-obj-geo';
            const store = isObject ? objGeo : clientGeo;
            const role = isObject ? 'obj-geo' : 'client-geo';
            syncGeo(role, store);
            store.push({ region: '', city: '', district: '', locality: '' });
            renderGeo(role, store);
            return;
        }
        const removeGeo = event.target.closest('[data-remove-geo]');
        if (removeGeo) {
            const box = removeGeo.closest('[data-role]');
            const isObject = box.dataset.role === 'obj-geo';
            const store = isObject ? objGeo : clientGeo;
            syncGeo(box.dataset.role, store);
            store.splice(Number(removeGeo.dataset.removeGeo), 1);
            renderGeo(box.dataset.role, store);
        }
    });

    renderSegments();
    renderGeo('obj-geo', objGeo);
    renderGeo('client-geo', clientGeo);
    syncCascades();

    function gather() {
        syncSegments();
        syncGeo('obj-geo', objGeo);
        syncGeo('client-geo', clientGeo);
        const retiree = chosen('clientTypes').includes('Пенсионер');
        return {
            networkId: state.networkId,
            name: field('name').value.trim(),
            category: field('category').value,
            status: field('status').value,
            dateStart: field('dateStart').value,
            dateEnd: field('dateEnd').value,
            actionType: field('actionType').value,
            rate: field('rate').value,
            holdDays: field('holdDays').value,
            leadCheck: field('leadCheck').value,
            targetCriteria: field('targetCriteria').value,
            nonTargetCriteria: field('nonTargetCriteria').value,
            objTypes: chosen('objTypes'),
            finishes: chosen('finishes'),
            developer: field('developer').value,
            deadline: field('deadline').value,
            clientTypes: chosen('clientTypes'),
            otherBorrower: retiree ? field('otherBorrower').checked : null,
            purchaseTerm: field('purchaseTerm').value,
            downPaymentPercent: field('downPaymentPercent').value,
            paymentMethods: chosen('paymentMethods'),
            mortgageTypes: chosen('mortgageTypes'),
            priority: field('priority').value,
            leadLimit: field('leadLimit').value,
            segments,
            objGeo,
            clientGeo
        };
    }

    function markError(name, message) {
        const box = fieldBox(name);
        if (!box) return;
        box.classList.add('ui-field--error');
        const note = box.querySelector('.ui-field__error');
        if (note) note.textContent = message;
    }

    /**
     * Незаполненные и неправильные поля называются РАЗОМ и подсвечиваются
     * (К85). В форме на тридцать полей тост с одним именем поля не показывает,
     * где оно: окно прокручивается к первому и ставит туда фокус.
     */
    function validate() {
        body.querySelectorAll('.ui-field--error').forEach((box) => box.classList.remove('ui-field--error'));
        const problems = [];

        REQUIRED_OFFER_FIELDS.forEach(([name, label]) => {
            if (!field(name).value.trim()) problems.push([name, `Заполните обязательное поле: ${label}`]);
        });
        NUMBER_RULES.forEach(([name, message, ok]) => {
            const raw = field(name).value.trim();
            if (raw === '') return;
            const number = Number(raw);
            if (!Number.isFinite(number) || !ok(number)) problems.push([name, message]);
        });
        const start = field('dateStart').value;
        const end = field('dateEnd').value;
        if (start && end && end < start) problems.push(['period', 'Конец периода не может быть раньше начала']);

        if (!problems.length) return true;

        problems.forEach(([name, message]) => markError(name, message));
        state.ctx.toast(problems[0][1], 'error');
        const firstBox = fieldBox(problems[0][0]);
        if (firstBox) {
            firstBox.scrollIntoView({ block: 'center' });
            const control = firstBox.querySelector('.ui-field__control');
            if (control) control.focus();
        }
        return false;
    }

    const snapshot = JSON.stringify(gather());

    /**
     * Вопрос перед закрытием — ОДИН на все три двери (Esc, затемнение, крестик).
     * Прежнее окно раздела закрывалось молча и теряло всё набранное (К74).
     * Без изменений закрывается молча: спрашивать не о чем.
     */
    async function confirmDiscard() {
        if (JSON.stringify(gather()) === snapshot) return true;
        return confirm({
            title: 'Закрыть без сохранения?',
            message: 'Введённые данные оффера не сохранятся.',
            confirmLabel: 'Закрыть без сохранения',
            screen: true
        });
    }

    const editing = offer && !asCopy;
    const actions = [];
    // «Скопировать оффер» — только у уже заведённого: копировать пустую форму
    // нечего (К151).
    if (editing) {
        actions.push({
            label: 'Скопировать оффер', variant: 'ghost', side: 'start',
            onClick: async () => {
                const data = gather();
                modal.close(false);
                await openOfferModal(state, offer, {
                    asCopy: true,
                    preset: { ...data, name: `${data.name} (копия)`, status: 'draft' }
                });
                return true;
            }
        });
    }
    actions.push({ label: 'Отмена', variant: 'ghost', onClick: () => confirmDiscard() });
    actions.push({
        label: 'Сохранить',
        onClick: async () => {
            if (!validate()) return false;
            const payload = gather();
            try {
                if (editing) {
                    await state.storage.updateRealEstateOffer(offer.id, payload);
                    state.ctx.toast('Изменения сохранены', 'success');
                } else {
                    await state.storage.createRealEstateOffer(payload);
                    state.ctx.toast(asCopy ? 'Копия оффера создана' : 'Оффер добавлен', 'success');
                }
            } catch (err) {
                // Ошибка сервера оставляет окно открытым: закрыть его — значит
                // потерять тридцать заполненных полей.
                if (!isAbort(err)) state.ctx.toast(err.message, 'error');
                return false;
            }
            await reloadAll(state);
            return true;
        }
    });

    const modal = openModal({
        title: asCopy ? 'Копия оффера' : (offer ? 'Настройка оффера' : 'Новый оффер'),
        // Под заголовком — имя сети: при открытом окне это единственное место,
        // где написано, в какой сети заводится или правится оффер. Список сетей
        // в этот момент накрыт затемнением.
        sub: network.name,
        body,
        scope: state.panel,
        size: 'wide',
        spread: true,
        // Щелчок по затемнению форму НЕ закрывает: она длинная, промах мимо неё
        // стоил бы всего ввода. Esc и крестик остаются и спрашивают.
        scrimClose: false,
        confirmClose: confirmDiscard,
        actions
    });

    // Фокус — в первое поле формы, а не на крестик (К78). Слой по умолчанию
    // берёт первый фокусируемый элемент коробки, а это крестик закрытия.
    field('name').focus();
    return modal;
}

// ---------------------------------------------------------------- подсказки адреса

function attachGeoSuggest(state, box, store) {
    box.querySelectorAll('.cpa-geo-field input').forEach((input) => {
        const name = Object.keys(GEO_FIELD_BOUND).find((key) => input.dataset.geo === key);
        const bound = GEO_FIELD_BOUND[name];

        input.addEventListener('input', () => {
            const query = input.value.trim();
            const holder = input.closest('.cpa-geo-field');
            const index = Number(input.closest('.cpa-geo-row').dataset.index);

            // Ручной ввод расходится с уже сохранённым fias-id этого уровня —
            // сбрасываем сужение, иначе следующий поиск в этой строке молча
            // уйдёт в контекст региона, которого человек уже не видит в поле.
            if (name === 'region') { store[index].regionFiasId = undefined; store[index].areaFiasId = undefined; }
            if (name === 'district') { store[index].areaFiasId = undefined; }

            closeGeoSuggest(box);
            clearTimeout(state.geoTimer);
            if (!query) return;

            const requestId = ++state.geoRequestId;
            state.geoTimer = setTimeout(async () => {
                // Таймер переживает закрытие панели: без проверки он сработает,
                // когда раздела уже нет.
                if (state.destroyed) return;
                let suggestions;
                try {
                    const regionFiasId = name !== 'region' ? store[index].regionFiasId : undefined;
                    const result = await state.storage.fetchGeoSuggest(query, { bound, regionFiasId });
                    if (state.destroyed) return;
                    suggestions = (result && result.suggestions) || [];
                } catch (err) {
                    if (state.destroyed || isAbort(err)) return;
                    state.ctx.toast('Подсказки адреса недоступны — сервис не отвечает. Введите вручную.', 'error');
                    return;
                }
                if (requestId !== state.geoRequestId) return;
                if (input.value.trim() !== query) return;

                const items = suggestions.slice(0, 5).map((s) => s.data);
                const list = document.createElement('div');
                list.className = 'cpa-geo-suggest';
                list.innerHTML = items.length
                    ? items.map((data, i) => `<div class="cpa-geo-suggest__item" data-index="${i}"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-pin"></use></svg><span>${highlight(geoDisplay(bound, data), query)}</span></div>`).join('')
                    : '<div class="cpa-geo-suggest__item"><span>Ничего не найдено</span></div>';
                holder.appendChild(list);

                list.querySelectorAll('.cpa-geo-suggest__item[data-index]').forEach((item) => {
                    item.addEventListener('mousedown', (event) => {
                        event.preventDefault();
                        const data = items[Number(item.dataset.index)];
                        if (!data) return;
                        store[index][name] = geoParts(data)[bound];
                        if (name === 'region') { store[index].regionFiasId = data.region_fias_id; store[index].areaFiasId = undefined; }
                        if (name === 'district') { store[index].areaFiasId = data.area_fias_id; }
                        input.value = store[index][name];
                        closeGeoSuggest(box);
                    });
                });
            }, GEO_SUGGEST_DEBOUNCE_MS);
        });
        input.addEventListener('blur', () => setTimeout(() => closeGeoSuggest(box), 120));
    });
}

function closeGeoSuggest(box) {
    box.querySelectorAll('.cpa-geo-suggest').forEach((el) => el.remove());
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// DaData отдаёт «<имя> <тип-аббревиатура>» или наоборот в зависимости от уровня
// — вместо угадывания порядка берём готовое _with_type и точечно заменяем
// аббревиатуру на полное слово, сохраняя позицию.
function fullTypeText(withType, typeAbbr, typeFull) {
    if (!withType) return '';
    if (!typeAbbr || !typeFull || typeAbbr === typeFull) return withType;
    return withType.replace(new RegExp(`(^|\\s)${escapeRegExp(typeAbbr)}(?=\\s|$)`), (m, p1) => `${p1}${typeFull}`);
}

function geoParts(data) {
    return {
        region: fullTypeText(data.region_with_type, data.region_type, data.region_type_full),
        city: data.city || '',
        area: fullTypeText(data.area_with_type, data.area_type, data.area_type_full),
        settlement: fullTypeText(data.settlement_with_type, data.settlement_type, data.settlement_type_full)
    };
}

function geoDisplay(bound, data) {
    return fullTypeText(data[`${bound}_with_type`], data[`${bound}_type`], data[`${bound}_type_full`]);
}

function highlight(text, query) {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, at)) + '<b>' + escapeHtml(text.slice(at, at + query.length)) + '</b>' + escapeHtml(text.slice(at + query.length));
}

// ---------------------------------------------------------------- удаление оффера

/**
 * Подтверждение называет последствия для ЧУЖИХ записей, а не только для своих:
 * лиды, с которых оффер снимается, остаются, но связь с оффером исчезает.
 * При нуле лидов фраза не показывается — «снят с 0 лидов» это шум.
 */
async function removeOffer(state, offer) {
    const leads = offer.leadsCount || 0;
    const tail = leads ? ` Он снят с ${leads} ${pluralLeads(leads)} — сами лиды останутся.` : '';
    const ok = await state.ctx.confirmDanger({
        title: 'Удалить оффер?',
        message: `Оффер «${offer.name}» будет удалён вместе со своими сегментами и географией.${tail}`,
        confirmLabel: 'Удалить'
    });
    if (!ok || state.destroyed) return;
    try {
        await state.storage.deleteRealEstateOffer(offer.id);
        state.ctx.toast('Оффер удалён', 'success');
        await reloadAll(state);
    } catch (err) {
        // Связь объекта с лидами теперь запрещающая (часть 5, класс Б): нельзя
        // удалить объект, который кому-то подобран. Голый тост назвал бы это
        // одной фразой; окно называет числами и говорит, что сделать.
        if (isDeleteBlocked(err)) {
            openDeleteBlocked({
                scope: state.panel,
                sub: `Объект «${offer.name}»`,
                lead: 'К объекту привязано то, что удалением потерялось бы навсегда:',
                tail: 'Отвяжите или удалите это по отдельности — тогда объект удалится.',
                blockers: err.blockers
            });
            return;
        }
        fail(state, err);
    }
}

// ---------------------------------------------------------------- окно «Настройка списков»

/**
 * Отдельное окно, а не режим внутри окна оффера (К146). Переключатель в шапке
 * менял содержимое целиком, оставляя прежний заголовок и убирая «Сохранить», —
 * понять, что закроется по «Готово», было неоткуда. Заодно снимается и нужда в
 * тумблере, которого в слое нет.
 */
async function openParamsModal(state) {
    try {
        const lists = await state.storage.fetchParamLists();
        if (state.destroyed) return;
        state.paramLists = lists;
    } catch (err) {
        fail(state, err);
    }

    const body = document.createElement('div');
    const intro = document.createElement('p');
    intro.className = 'ui-field__hint';
    intro.textContent = 'Значения списков ниже используются в полях формы оффера и в карточке клиента на странице оператора. Добавляйте и удаляйте варианты — изменения применяются сразу.';
    body.appendChild(intro);

    const cards = document.createElement('div');
    body.appendChild(cards);

    const renderCards = () => {
        cards.innerHTML = PARAM_META.map((meta) => {
            const values = state.paramLists[meta.key] || [];
            return `
                <div class="cpa-param-card" data-key="${meta.key}">
                    <button type="button" class="cpa-param-card__head" data-toggle="${meta.key}" aria-expanded="false">
                        <span>${escapeHtml(meta.label)}</span>
                        <span class="ui-tabs__count">${values.length}</span>
                        <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-chevron-down"></use></svg>
                    </button>
                    <div class="cpa-param-card__body" data-body="${meta.key}" hidden>
                        <div class="cpa-param-tags" data-tags="${meta.key}"></div>
                        <div class="cpa-param-add">
                            <div class="ui-field">
                                <input class="ui-field__control" data-add="${meta.key}" placeholder="Новое значение…" aria-label="Новое значение списка «${escapeHtml(meta.label)}»">
                            </div>
                            <button type="button" class="ui-btn ui-btn--secondary" data-add-btn="${meta.key}">Добавить</button>
                        </div>
                    </div>
                </div>`;
        }).join('');
        PARAM_META.forEach((meta) => renderTags(meta.key));
    };

    function renderTags(key) {
        const box = cards.querySelector(`[data-tags="${key}"]`);
        const values = state.paramLists[key] || [];
        // Тег — элемент слоя (.ui-tag), свой .param-tag раздел больше не
        // объявляет (К83).
        box.innerHTML = values.map((value, index) => `
            <span class="ui-tag ui-tag--removable">${escapeHtml(value)}
                <button type="button" class="ui-tag__remove" data-remove="${index}" data-key="${key}" aria-label="Удалить значение «${escapeHtml(value)}»">
                    <svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg>
                </button>
            </span>`).join('') || '<span class="ui-field__hint">Список пуст.</span>';
        const count = cards.querySelector(`[data-toggle="${key}"] .ui-tabs__count`);
        if (count) count.textContent = values.length;
    }

    async function addValue(key) {
        const input = cards.querySelector(`[data-add="${key}"]`);
        const value = input.value.trim();
        if (!value) {
            state.ctx.toast('Укажите значение', 'error');
            input.focus();
            return;
        }
        const values = state.paramLists[key] || [];
        if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
            state.ctx.toast('Такое значение уже есть в списке', 'error');
            input.focus();
            return;
        }
        try {
            await state.storage.addParamValue(key, value);
        } catch (err) {
            fail(state, err);
            return;
        }
        if (state.destroyed) return;
        state.paramLists[key] = values.concat(value);
        input.value = '';
        renderTags(key);
        input.focus();
    }

    async function removeValue(key, index) {
        const values = state.paramLists[key] || [];
        const value = values[index];
        try {
            await state.storage.deleteParamValue(key, value);
        } catch (err) {
            fail(state, err);
            return;
        }
        if (state.destroyed) return;
        state.paramLists[key] = values.filter((_, i) => i !== index);
        renderTags(key);
    }

    body.addEventListener('click', async (event) => {
        const toggle = event.target.closest('[data-toggle]');
        if (toggle) {
            const box = cards.querySelector(`[data-body="${toggle.dataset.toggle}"]`);
            box.hidden = !box.hidden;
            toggle.setAttribute('aria-expanded', String(!box.hidden));
            return;
        }
        const addBtn = event.target.closest('[data-add-btn]');
        if (addBtn) {
            await addValue(addBtn.dataset.addBtn);
            return;
        }
        const remove = event.target.closest('[data-remove]');
        if (remove) await removeValue(remove.dataset.key, Number(remove.dataset.remove));
    });

    body.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter') return;
        const input = event.target.closest('[data-add]');
        if (!input) return;
        event.preventDefault();
        await addValue(input.dataset.add);
    });

    renderCards();

    // «Готово», а не «Сохранить»: каждое добавление и удаление уходит на сервер
    // отдельным запросом, сохранять нечего.
    openModal({
        title: 'Настройка списков значений',
        sub: 'Тринадцать справочников, из которых собираются поля оффера и карточки лида',
        body,
        scope: state.panel,
        size: 'wide',
        actions: [{ label: 'Готово', value: false }]
    });
}

// ---------------------------------------------------------------- окно «Управление сетями»

function openNetworksModal(state, { openForm: startWithForm = false, editId = null } = {}) {
    const body = document.createElement('div');

    const locked = document.createElement('p');
    locked.className = 'ui-field__hint';
    locked.textContent = 'Сначала заполните организацию в разделе «Реквизиты» — CPA-сеть привязывается к юрлицу.';
    locked.hidden = state.organization !== null;
    body.appendChild(locked);

    const list = document.createElement('div');
    list.className = 'cpa-net-list';
    body.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ui-btn ui-btn--ghost';
    addBtn.style.marginTop = 'var(--ui-space-4)';
    addBtn.innerHTML = '<svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg>Добавить сеть';
    addBtn.hidden = state.organization === null;
    body.appendChild(addBtn);

    const form = document.createElement('div');
    form.className = 'cpa-inline-form';
    form.hidden = true;
    form.innerHTML = `
        <div class="ui-form-grid">
            <div class="ui-field ui-field--wide" data-field-box="name">
                <label class="ui-field__label ui-field__label--required">Название</label>
                <input class="ui-field__control" data-field="name" placeholder="Например, «AdCombo»">
                <span class="ui-field__error"></span>
            </div>
            <div class="ui-field ui-field--wide" data-field-box="organization">
                <label class="ui-field__label ui-field__label--required">Юрлицо</label>
                <select class="ui-field__control" data-field="organization"></select>
                <span class="ui-field__error"></span>
            </div>
            <div class="ui-field">
                <label class="ui-field__label">Статус</label>
                <select class="ui-field__control" data-field="status">
                    ${NETWORK_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('')}
                </select>
            </div>
            <div class="ui-field">
                <label class="ui-field__label">Дата подключения</label>
                <input class="ui-field__control" type="date" data-field="connectedAt">
            </div>
            <div class="ui-field">
                <label class="ui-field__label">Валюта выплаты</label>
                <input class="ui-field__control" data-field="payoutCurrency" placeholder="RUB">
            </div>
            <div class="ui-field" data-field-box="commissionPercent">
                <label class="ui-field__label">Комиссия, %</label>
                <input class="ui-field__control" type="number" step="any" data-field="commissionPercent" placeholder="15">
                <span class="ui-field__error"></span>
            </div>
        </div>
        <div class="cpa-inline-form__actions">
            <button type="button" class="ui-btn ui-btn--ghost" data-act="cancel">Отмена</button>
            <button type="button" class="ui-btn" data-act="save">Сохранить</button>
        </div>`;
    body.appendChild(form);

    let editingId = null;
    const formField = (name) => form.querySelector(`[data-field="${name}"]`);

    const renderList = () => {
        list.innerHTML = state.networks.map((network) => {
            const sources = network.sourcesCount || 0;
            const offers = network.offersCount || 0;
            const blocked = sources > 0;
            return `
                <div class="cpa-net-row">
                    <span class="ui-pill ${NETWORK_PILL[network.status] || 'ui-pill--mute'}">${escapeHtml(network.status)}</span>
                    <span class="cpa-net-row__name">${escapeHtml(network.name)}</span>
                    <span class="cpa-net-row__meta">${escapeHtml(network.organizationName || '—')} · комиссия ${network.commissionPercent ?? '—'} % · ${escapeHtml(network.payoutCurrency || '—')}</span>
                    <span class="cpa-net-row__meta">Офферов: ${offers}</span>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row" data-nedit="${network.id}" title="Изменить" aria-label="Изменить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg></button>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--row ui-btn--danger" data-ndel="${network.id}"${blocked ? ' disabled' : ''}
                            title="${blocked ? `Нельзя удалить — на сеть ссылаются источники (${sources})` : 'Удалить'}" aria-label="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                </div>`;
        }).join('') || '<p class="ui-field__hint">Сетей пока нет — добавьте первую.</p>';
    };
    renderList();

    const openFormFor = (network) => {
        editingId = network ? network.id : null;
        formField('name').value = network ? network.name : '';
        formField('organization').innerHTML = state.organization
            ? `<option value="${state.organization.id}">${escapeHtml(state.organization.name)}</option>`
            : '';
        formField('status').value = network ? network.status : 'Активна';
        formField('connectedAt').value = network ? (network.connectedAt || '') : '';
        formField('payoutCurrency').value = network ? (network.payoutCurrency || '') : '';
        formField('commissionPercent').value = network && network.commissionPercent !== null && network.commissionPercent !== undefined
            ? network.commissionPercent : '';
        form.querySelectorAll('.ui-field--error').forEach((box) => box.classList.remove('ui-field--error'));
        form.hidden = false;
        formField('name').focus();
    };

    addBtn.addEventListener('click', () => openFormFor(null));

    list.addEventListener('click', async (event) => {
        const edit = event.target.closest('[data-nedit]');
        if (edit) {
            openFormFor(state.networks.find((n) => n.id === Number(edit.dataset.nedit)));
            return;
        }
        const del = event.target.closest('[data-ndel]');
        if (!del || del.disabled) return;
        const network = state.networks.find((n) => n.id === Number(del.dataset.ndel));
        const offers = network.offersCount || 0;
        // Фраза о последствиях появляется только тогда, когда последствия есть.
        const tail = offers ? ` Вместе с ней удалятся её офферы (${offers}) — восстановить их будет нельзя.` : '';
        const ok = await state.ctx.confirmDanger({
            title: 'Удалить сеть?',
            message: `Сеть «${network.name}» будет удалена.${tail}`,
            confirmLabel: 'Удалить'
        });
        if (!ok || state.destroyed) return;
        try {
            await state.storage.deleteCpaNetwork(network.id);
            state.ctx.toast('Сеть удалена', 'success');
            await reloadAll(state);
            renderList();
        } catch (err) {
            if (isDeleteBlocked(err)) {
                openDeleteBlocked({
                    scope: state.panel,
                    sub: `CPA-сеть «${network.name}»`,
                    lead: 'К сети привязано то, что удалением потерялось бы навсегда:',
                    tail: 'Отвяжите или удалите это по отдельности — тогда сеть удалится.',
                    blockers: err.blockers
                });
                return;
            }
            fail(state, err);
        }
    });

    form.addEventListener('click', async (event) => {
        if (event.target.closest('[data-act="cancel"]')) {
            // Отмена сворачивает форму, а не закрывает окно: список остаётся.
            form.hidden = true;
            editingId = null;
            return;
        }
        if (!event.target.closest('[data-act="save"]')) return;

        form.querySelectorAll('.ui-field--error').forEach((box) => box.classList.remove('ui-field--error'));
        const markFormError = (name, message) => {
            const box = form.querySelector(`[data-field-box="${name}"]`);
            if (!box) return;
            box.classList.add('ui-field--error');
            const note = box.querySelector('.ui-field__error');
            if (note) note.textContent = message;
        };

        const name = formField('name').value.trim();
        const commission = formField('commissionPercent').value.trim();
        const problems = [];
        if (!name) problems.push(['name', 'Заполните обязательное поле: Название']);
        if (!state.organization) problems.push(['organization', 'Заполните обязательное поле: Юрлицо']);
        if (commission !== '') {
            const number = Number(commission);
            if (!Number.isFinite(number) || number < 0 || number > 100) {
                problems.push(['commissionPercent', 'Комиссия должна быть числом от 0 до 100']);
            }
        }
        if (problems.length) {
            problems.forEach(([field, message]) => markFormError(field, message));
            state.ctx.toast(problems[0][1], 'error');
            return;
        }

        const payload = {
            name,
            organizationId: state.organization ? state.organization.id : null,
            status: formField('status').value,
            connectedAt: formField('connectedAt').value,
            payoutCurrency: formField('payoutCurrency').value,
            commissionPercent: commission
        };
        try {
            if (editingId) {
                await state.storage.updateCpaNetwork(editingId, payload);
                state.ctx.toast('Изменения сохранены', 'success');
            } else {
                await state.storage.createCpaNetwork(payload);
                state.ctx.toast('Сеть добавлена', 'success');
            }
            form.hidden = true;
            editingId = null;
            await reloadAll(state);
            renderList();
        } catch (err) {
            fail(state, err);
        }
    });

    openModal({
        title: 'Управление сетями',
        sub: 'Название, юрлицо, условия подключения',
        body,
        scope: state.panel,
        actions: [{ label: 'Готово', value: false }]
    });

    if (editId !== null) {
        const network = state.networks.find((n) => n.id === editId);
        if (network) openFormFor(network);
    } else if (startWithForm && state.organization) {
        openFormFor(null);
    }
}
