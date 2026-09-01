// --- Calls/js/modules/callsApp.js: раздел «Звонки» -------------------------
//
// Контракт раздела (бриф, 3.2):
//     export async function mount(container, ctx)
//     export function unmount()
//
// ТРИ ВКЛАДКИ, И ОНИ РАЗНЫЕ ПО ПРИРОДЕ. «Активные» — строка это ОПЕРАТОР,
// картина живая и обновляется сама. «Завершённые» — строка это ЗВОНОК, журнал
// за период, свежие сверху. «События» — строка это НАСТРОЙКА планировщика, и
// живёт она своим модулем (`callsEvents.js`). Общего у всех трёх только шапка и
// полоса вкладок.
//
// ТРЕТЬЯ ГРУЗИТСЯ ПРИ ПЕРВОМ ОТКРЫТИИ, а не при монтировании, и это не
// противоречит правилу двух первых. Журнал грузится сразу потому, что у его
// вкладки СЧЁТЧИК, и он обязан быть верным с первого кадра. У «Событий»
// счётчика нет: строк там всегда три, и число, которое никогда не меняется,
// — украшение, а не счётчик (паспорт Р12). Значит и торопиться не с чем.
//
// СОСТОЯНИЕ ЖИВЁТ В ЭКЗЕМПЛЯРЕ, а не в модуле. ES-модуль — синглтон: при двух
// открытых панелях модульные переменные были бы общими, и два раздела начали бы
// перетирать друг другу отбор и выбранную вкладку.
//
// РАЗДЕЛ ТОЛЬКО ЧИТАЕТ. Кнопки «Позвонить» здесь нет вовсе: звонит оператор из
// своей панели, руководителю набирать некому (паспорт Р1).

import { openModal } from '/ui/modal.js';
import { isAbort } from '/api.js';
import { readHiddenColumns, hasHiddenColumns, writeHiddenColumns } from '/viewPrefs.js';
import { showLoadError, clearLoadError } from '/ui/load-error.js';
import { createSkeleton } from '/ui/skeleton.js';
import {
    fetchActive, fetchMeta, fetchCalls, fetchCallsForExport, fetchChain, fetchRecording
} from './callsStorage.js';
import { createEventsTab } from './callsEvents.js';

const COLUMNS_SECTION = 'calls';

// Три вкладки в том порядке, в каком они стоят в полосе. Список нужен целиком,
// а не парой имён: по нему ходят стрелки и по нему же переключаются панели —
// два разных перечисления одного порядка разошлись бы на четвёртой вкладке.
// Порядок не случаен: первые две — работа, третья — настройка, а настройка не
// идёт первой (паспорт Р12).
const TABS = ['active', 'done', 'events'];

// Порция догрузки — та же, что в «Лидах» (контрольное число паспорта).
const PAGE_SIZE = 30;

// Поиск ждёт, пока человек допечатает. То же значение, что в остальных разделах.
const SEARCH_DEBOUNCE_MS = 300;

// Подсветка изменившейся строки. Два цикла: держим и гасим — ровно две секунды
// суммарно (паспорт Р1, «живая строка»).
const FLASH_MS = 2000;

// ВОСЕМЬ СОСТОЯНИЙ В ЧЕТЫРЕ ЦВЕТА (паспорт Р1). Цвет отвечает на вопрос, который
// руководитель задаёт экрану на самом деле: «кто сейчас может взять звонок».
// Слово рядом отвечает на второй: «а почему нет». Восемь заливок пришлось бы
// заучивать по легенде, и через неделю он всё равно читал бы слова.
const STATE_LABEL = {
    on_line: 'на линии',
    talk: 'разговор',
    wrapup: 'пост-обработка',
    training: 'обучение',
    review: 'разбор ошибок',
    break: 'перерыв',
    lunch: 'обед',
    off: 'неактивен'
};
const STATE_PILL = {
    // Единственное состояние, в котором идёт работа с клиентом.
    talk: 'ui-pill ui-pill--ok',
    // В работе, но не говорит.
    on_line: 'ui-pill',
    wrapup: 'ui-pill',
    // Отсутствует по понятной причине.
    training: 'ui-pill ui-pill--warn',
    review: 'ui-pill ui-pill--warn',
    break: 'ui-pill ui-pill--warn',
    lunch: 'ui-pill ui-pill--warn',
    // Пропал.
    off: 'ui-pill ui-pill--bad'
};

// ИСХОД ПО АТС — шесть значений и один служебный. Исход ставит машина, статус
// воронки — человек; самое интересное в разборе это их расхождения, и потому
// исход красится, а статус нет.
const OUTCOME_LABEL = {
    answered: 'ответили',
    busy: 'занято',
    no_answer: 'не ответили',
    cancelled: 'отменён',
    congestion: 'ошибка',
    unavailable: 'нет регистрации',
    lost: 'связь потеряна'
};
const OUTCOME_PILL = {
    answered: 'ui-pill ui-pill--ok',
    busy: 'ui-pill ui-pill--warn',
    no_answer: 'ui-pill ui-pill--warn',
    cancelled: 'ui-pill ui-pill--mute',
    congestion: 'ui-pill ui-pill--bad',
    unavailable: 'ui-pill ui-pill--bad',
    lost: 'ui-pill ui-pill--bad'
};

// Состав колонок «Завершённых». Три из них не прячутся: без времени, номера и
// записи строка перестаёт быть строкой журнала.
const COLUMNS = [
    { key: 'when', label: 'Когда', fixed: true },
    { key: 'phone', label: 'Телефон лида', fixed: true },
    { key: 'direction', label: 'Направление' },
    { key: 'line', label: 'Линия' },
    { key: 'operator', label: 'Оператор' },
    { key: 'ourNumber', label: 'Наш номер' },
    { key: 'outcome', label: 'Исход по АТС' },
    { key: 'wait', label: 'Ожидание' },
    { key: 'talk', label: 'Разговор' },
    { key: 'funnelStatus', label: 'Статус воронки' },
    { key: 'notes', label: 'Комментарий' },
    { key: 'record', label: 'Запись', fixed: true }
];
const COLUMN_KEYS = COLUMNS.map((c) => c.key);

// Открытые экземпляры раздела — тот же приём, что в «Источниках»: список
// честнее одиночной переменной, он не соврёт, если правило «одна панель на
// раздел» когда-нибудь изменится.
const instances = [];

// ---------------------------------------------------------------- монтирование

export async function mount(container, ctx) {
    const self = createInstance(container, ctx);
    instances.push(self);
    await self.start();
}

export function unmount() {
    while (instances.length) instances.pop().destroy();
}

function createInstance(container, ctx) {
    const $ = (sel) => container.querySelector(sel);
    const $$ = (sel) => Array.from(container.querySelectorAll(sel));

    const state = {
        tab: 'active',
        // Отбор «Завершённых». Период по умолчанию — сегодня; день приходит с
        // сервера, а не из new Date() браузера: часы у руководителя могут стоять
        // в другом поясе, и подпись разошлась бы с таблицей под ней (Ф7).
        filters: { from: null, to: null, employeeId: null, outcome: null,
            direction: null, lineType: null, sourceId: null, withRecord: false, search: '' },
        meta: { operators: [], sources: [], outcomes: [] },
        active: [],
        done: [],
        doneTotal: 0,
        doneLoaded: false,
        // Точка отсчёта следующей порции. Отдаёт её сервер: кто задаёт порядок,
        // тот и говорит, где остановились.
        cursor: null,
        // Период — тоже отбор, и «умолчание ли это» решает сервер: «сегодня» в
        // проекте берётся только с него (К198).
        periodIsDefault: true,
        // Расхождение часов браузера и сервера. Длительность считается от
        // серверного момента, и без поправки она врала бы ровно на эту разницу.
        clockSkewMs: 0,
        expanded: new Set(),
        hiddenColumns: new Set(hasHiddenColumns(COLUMNS_SECTION)
            ? readHiddenColumns(COLUMNS_SECTION, COLUMN_KEYS) : [])
    };

    let alive = true;
    let tick = null;
    let events = null;
    let refreshTimer = null;
    let searchTimer = null;
    let filtersModal = null;
    let columnsModal = null;
    // Вкладка «События» — свой модуль со своим состоянием. Создаётся при первом
    // открытии вкладки: настройку планировщика открывают редко, а два запроса
    // справочников при каждом входе в раздел платились бы всегда.
    let eventsTab = null;

    const self = {
        start,
        destroy() {
            alive = false;
            if (tick) clearInterval(tick);
            if (refreshTimer) clearTimeout(refreshTimer);
            if (searchTimer) clearTimeout(searchTimer);
            if (events) events.close();
            if (filtersModal) filtersModal.close();
            if (columnsModal) columnsModal.close();
            if (eventsTab) eventsTab.destroy();
        }
    };

    async function start() {
        bindEvents();
        // Справочники и ОБЕ вкладки — одним заходом.
        //
        // ЖУРНАЛ ГРУЗИТСЯ СРАЗУ, А НЕ ПРИ ПЕРЕКЛЮЧЕНИИ, и это не «на всякий
        // случай». Счётчик у вкладки обязан быть верным с первого кадра: он
        // приходит с сервера и обещает «столько строк внутри». Ленивая загрузка
        // показывала бы ноль до первого нажатия — то есть говорила бы, что
        // звонков сегодня не было, ровно там, где их 24.
        const [meta, active, done] = await Promise.all([
            fetchMeta(ctx.api).catch(metaFallback),
            fetchActive(ctx.api),
            fetchCalls(ctx.api, state.filters, null)
        ]);
        if (!alive) return;
        state.meta = meta;
        applyActive(active);
        applyDone(done, false);
        renderActive();
        // ⚠ ВКЛАДКУ МОГЛИ ПЕРЕКЛЮЧИТЬ, ПОКА ЕХАЛ ЭТОТ ОТВЕТ, и без этой строки
        // журнал оставался пустым НАВСЕГДА. Обработчики вкладок висят с самого
        // начала — `bindEvents` стоит первой строкой этой же функции, — а строки
        // журнала рисуются при ПЕРВОМ показе вкладки (`switchTab`). Успел
        // человек нажать «Завершённые» раньше ответа — показ уже случился на
        // пустом `state.done`, второго не будет, и он остаётся с «Сегодня ещё
        // не звонили» при счётчике вкладки, показывающем настоящее число.
        //
        // Замер на `47a8db5`: воспроизводится каждый раз, ошибок в консоли нет,
        // тоста нет, **через 70 секунд ничего не меняется** — живой канал
        // журнала не перерисовывает, а другого повода к перерисовке нет.
        //
        // Чиним не запретом нажимать, а перерисовкой того, что открыто: вкладки
        // остаются живыми с первого кадра, как и было задумано.
        if (state.tab === 'done') renderDone(state.done.length < state.doneTotal);
        openLiveChannel();
        // Тик длительностей — раз в секунду, и только пока раздел открыт.
        tick = setInterval(() => { if (state.tab === 'active') tickDurations(); }, 1000);
    }

    function metaFallback() {
        // Справочники — украшение окна отбора, а не условие работы раздела.
        // Не приехали — окно покажет то, что знает, а таблица живёт своей жизнью.
        return { operators: [], sources: [], outcomes: Object.keys(OUTCOME_LABEL) };
    }

    // ------------------------------------------------------------ вкладки

    function bindEvents() {
        TABS.forEach((tab) => {
            $(`[data-role="tab-${tab}"]`).addEventListener('click', () => switchTab(tab));
        });

        // ← → между вкладками — поведение role="tablist". Кольцом: с последней
        // стрелка вправо ведёт на первую, как это делает сама роль.
        $('[data-role="tabs"]').addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const step = e.key === 'ArrowRight' ? 1 : -1;
            const next = TABS[(TABS.indexOf(state.tab) + step + TABS.length) % TABS.length];
            switchTab(next);
            $(`[data-role="tab-${next}"]`).focus();
        });

        $('[data-role="search"]').addEventListener('input', (e) => {
            const value = e.target.value;
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.filters.search = value.trim();
                loadDone();
            }, SEARCH_DEBOUNCE_MS);
        });

        $('[data-role="done-more"]').addEventListener('click', () => loadDone(true));
        $('[data-role="filters-btn"]').addEventListener('click', openFiltersModal);
        $('[data-role="columns-btn"]').addEventListener('click', openColumnsModal);
        $('[data-role="export-btn"]').addEventListener('click', exportCalls);

        $('[data-role="active-empty-action"]').addEventListener('click', () => {
            // Пустое состояние обязано вести туда, где проблема чинится, —
            // график живёт в «Сотрудниках».
            //
            // ТОЛЬКО ХВОСТ АДРЕСА, а не переход по ссылке: location.assign
            // перезагрузил бы страницу целиком и снёс бы вторую открытую панель
            // вместе с её несохранённой работой. Оболочка слушает hashchange и
            // откроет раздел сама.
            window.location.hash = '#/employees';
        });

        // Разворот перевода и кнопка записи — одним слушателем на тело таблицы:
        // строки перерисовываются, и слушатель на каждой кнопке пришлось бы
        // вешать заново после каждой отрисовки.
        $('[data-role="done-body"]').addEventListener('click', (e) => {
            const transfer = e.target.closest('.zv-transfer');
            if (transfer) return toggleChain(transfer);
            const play = e.target.closest('[data-play]');
            if (play) return playRecording(Number(play.dataset.play));
        });
    }

    function switchTab(tab) {
        if (state.tab === tab) return;
        state.tab = tab;

        TABS.forEach((name) => {
            const on = name === tab;
            const btn = $(`[data-role="tab-${name}"]`);
            btn.classList.toggle('ui-tabs__tab--active', on);
            btn.setAttribute('aria-selected', String(on));
            $(`[data-role="pane-${name}"]`).hidden = !on;
        });

        // Действия шапки принадлежат «Завершённым»: на «Активных» фильтровать
        // нечего и выгружать нечего, а «События» — настройка, и выгружать её
        // некуда тем более.
        $('[data-role="done-acts"]').hidden = tab !== 'done';

        // Строки журнала рисуются при первом показе вкладки: данные уже здесь с
        // монтирования, но строить двенадцать колонок в скрытую панель незачем.
        if (tab === 'done') renderDone(state.done.length < state.doneTotal);
        if (tab === 'events') openEventsTab();
    }

    /**
     * Первое открытие вкладки «События»: скелет, загрузка, модуль.
     *
     * СКЕЛЕТ РАЗДЕЛА, А НЕ СВОЙ (паспорт Р12, матрица состояний, № 1). Своя
     * заглушка на три строки выглядела бы точнее, но это ещё один способ
     * показывать загрузку в проекте, где он уже есть.
     */
    async function openEventsTab() {
        if (eventsTab) return;
        const pane = $('[data-role="pane-events"]');
        eventsTab = createEventsTab({ pane, api: ctx.api, scope: container });
        const skeleton = createSkeleton('table', 'События');
        pane.appendChild(skeleton);
        try {
            await eventsTab.load();
        } catch (err) {
            // Полосу «данные не загрузились» ставит оболочка на любом неудавшемся
            // запросе панели — раздел про неё не знает и своей не рисует. Здесь
            // остаётся снять недоделанный модуль, чтобы следующее открытие
            // вкладки попробовало снова, а не показало пустой столбик навсегда.
            if (!isAbort(err)) eventsTab = null;
        } finally {
            skeleton.remove();
        }
    }

    // ------------------------------------------------------------ «Активные»

    function applyActive(data) {
        state.active = data.rows;
        state.clockSkewMs = Date.now() - new Date(data.serverNow).getTime();
        $('[data-role="count-active"]').textContent = String(data.count);
        showPbxState(data.pbx);
    }

    // ТРЕТЬЕ СОСТОЯНИЕ ОТКАЗА: «Нет связи с телефонией» (матрица паспорта, № 3).
    //
    // Полоса положена ТОЛЬКО тогда, когда связь была настроена и пропала. Пока
    // ключей Телфина нет вовсе — а это весь срок до этапа Е, — полосы нет: она
    // висела бы круглосуточно и за неделю стала бы частью фона, а в день, когда
    // связь оборвётся по-настоящему, её никто бы не заметил.
    //
    // ЗАГОЛОВОК ЗДЕСЬ СВОЙ, И РАДИ ЭТОГО ПРАВИЛСЯ СЛОЙ. Умолчание полосы —
    // «Данные не загрузились», а здесь данные как раз загрузились: молчит
    // телефония, и полоса с таким заголовком солгала бы.
    function showPbxState(pbx) {
        if (!pbx || !pbx.configured || pbx.available) {
            clearLoadError(container);
            return;
        }
        const known = pbx.lastKnownAt
            ? `Показано последнее, что мы знали в ${timeLabel(pbx.lastKnownAt)}.`
            : 'Показано то, что записано у нас.';
        showLoadError(container, known, () => scheduleRefresh(), 'Нет связи с телефонией');
    }

    function renderActive(changedIds) {
        const body = $('[data-role="active-body"]');
        const empty = $('[data-role="active-empty"]');
        const wrap = $('[data-role="active-wrap"]');

        if (!state.active.length) {
            body.innerHTML = '';
            wrap.hidden = true;
            empty.hidden = false;
            $('[data-role="active-empty-text"]').textContent =
                `В графике на ${todayLabel()} нет ни одной смены. Проверьте график работы — возможно, месяц ещё не заполнен.`;
            return;
        }

        wrap.hidden = false;
        empty.hidden = true;
        body.innerHTML = '';
        state.active.forEach((row) => body.appendChild(activeRow(row)));
        tickDurations();

        // Подсветка тех строк, у кого состояние только что сменилось.
        if (changedIds && changedIds.size) {
            state.active.forEach((row) => {
                if (!changedIds.has(row.employeeId)) return;
                flash(body.querySelector(`[data-employee="${row.employeeId}"]`));
            });
        }
    }

    function activeRow(row) {
        const tr = document.createElement('tr');
        tr.dataset.employee = String(row.employeeId);

        // Оператор: фамилия и добавочный. Добавочного нет — говорим об этом
        // словами: пустая ячейка читалась бы как «данные не приехали».
        const who = document.createElement('td');
        who.appendChild(span('ui-table__main', row.name));
        who.appendChild(span('ui-table__sub', row.extension ? `доб. ${row.extension}` : 'доб. не задан'));
        tr.appendChild(who);

        tr.appendChild(cell(row.lineType || null));

        // ЯЧЕЙКА СТАТУСА — ЕДИНСТВЕННАЯ С aria-live. На строке целиком диктор
        // читал бы длительность каждую секунду, и разделом нельзя было бы
        // пользоваться.
        const stateCell = document.createElement('td');
        stateCell.setAttribute('aria-live', 'polite');
        stateCell.appendChild(span(STATE_PILL[row.state] || 'ui-pill', STATE_LABEL[row.state] || row.state));
        tr.appendChild(stateCell);

        // Длительность или «был активен в 14:32» — у неактивного длительность
        // ничего не значит, а время последней активности отвечает на вопрос
        // «давно ли он пропал».
        const dur = document.createElement('td');
        if (row.state === 'off') {
            // ПРИГЛУШЕНИЕ СТОИТ НА СОДЕРЖИМОМ, А НЕ НА САМОЙ ЯЧЕЙКЕ (К199).
            //
            // `.ui-table td` объявляет цвет, и по специфичности (0,1,1 против
            // 0,1,0) он молча отменяет класс, повешенный на `<td>`: приглушённое
            // выходило полной чернотой. Замер: шесть ячеек шли rgb(26,36,51)
            // вместо #8894a8.
            //
            // Ошибка в проекте уже случалась и уже разобрана — в самом коде
            // (`Sources/js/modules/sourcesSection.js:336-347`), и там же сказано,
            // что до правки три колонки выглядели правильно СЛУЧАЙНО.
            if (row.lastActiveAt) dur.appendChild(span('ui-table__muted', `был активен в ${timeLabel(row.lastActiveAt)}`));
            else dur.appendChild(dash());
        } else {
            dur.className = 'zv-dur';
            dur.dataset.since = row.stateSince || '';
        }
        tr.appendChild(dur);

        // Три колонки станции. Телефон и направление заполнены, только если
        // сейчас идёт разговор; иначе прочерк.
        const phone = document.createElement('td');
        if (row.callPhone && row.callLeadId) phone.appendChild(leadLink(row.callPhone, row.callLeadId));
        else if (row.callPhone) phone.textContent = row.callPhone;
        else phone.appendChild(dash());
        tr.appendChild(phone);

        tr.appendChild(directionCell(row.direction));

        // Трубка: тихая норма, громкое исключение. Колонка, в которой все ячейки
        // кричат одинаково, не сообщает ничего.
        const handset = document.createElement('td');
        if (row.handset === 'connected') {
            // Тихая норма — и она обязана быть тихой на самом деле: класс идёт
            // на содержимое, иначе цвет `.ui-table td` его перебивает (К199).
            // Колонка, в которой норма кричит вровень с исключением, не
            // сообщает ничего — ради этого различия она и придумана.
            handset.appendChild(span('ui-table__muted', 'подключена'));
        } else {
            handset.appendChild(span('ui-pill ui-pill--bad', 'не подключена'));
        }
        tr.appendChild(handset);

        return tr;
    }

    // Длительность ТИКАЕТ, но отсчитывается от серверного интервала: обновление
    // страницы иначе обнуляло бы цифру, и верить ей было бы незачем.
    function tickDurations() {
        $$('[data-role="active-body"] .zv-dur').forEach((cellEl) => {
            const since = cellEl.dataset.since;
            if (!since) { cellEl.textContent = ''; return; }
            const started = new Date(since).getTime();
            const now = Date.now() - state.clockSkewMs;
            cellEl.textContent = mmss(Math.max(0, Math.round((now - started) / 1000)));
        });
    }

    // ------------------------------------------------------------ живой канал

    // Имена событий — словарь куратора (ответ И180). Держится он в шапке
    // services/eventChannel.js: это единственное место, где они видны все сразу.
    function openLiveChannel() {
        if (typeof EventSource === 'undefined') return;
        try {
            events = new EventSource('/events');
        } catch (err) {
            // Канал — ускорение, а не условие работы: без него раздел живёт на
            // том, что уже загрузил, и это лучше, чем не открыться вовсе.
            return;
        }
        ['operator:state', 'call:started', 'call:ended'].forEach((name) => {
            events.addEventListener(name, () => scheduleRefresh());
        });
    }

    // Несколько событий подряд — одна перезагрузка. Оператор кладёт трубку, и
    // station шлёт три события за секунду; три запроса на них были бы платой ни
    // за что.
    function scheduleRefresh() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(async () => {
            refreshTimer = null;
            if (!alive || state.tab !== 'active') return;
            try {
                const before = new Map(state.active.map((r) => [r.employeeId, r.state]));
                const data = await fetchActive(ctx.api);
                if (!alive) return;
                applyActive(data);
                // ПОДСВЕЧИВАЕТСЯ ТОЛЬКО СМЕНА СОСТОЯНИЯ, А НЕ ПОЯВЛЕНИЕ СТРОКИ
                // (К200). У человека, которого в прошлом составе не было,
                // прежнее состояние — `undefined`, и оно «не равно» любому:
                // просто приехавшая строка светилась наравне с изменившейся.
                //
                // Цена не косметическая. Подсветка значит ровно одно — «здесь
                // только что изменилось состояние». Сигнал с двумя смыслами
                // читать перестают.
                //
                // Появление строки и без того редкое событие: состав вкладки
                // меняется со сменой графика, а не по ходу дня.
                const changed = new Set();
                state.active.forEach((r) => {
                    if (!before.has(r.employeeId)) return;
                    if (before.get(r.employeeId) !== r.state) changed.add(r.employeeId);
                });
                renderActive(changed);
            } catch (err) {
                // ТОСТА ЗДЕСЬ НЕТ, И ЭТО ПРАВИЛО, А НЕ ЭКОНОМИЯ (К201).
                //
                // Обновление запускает событие живого канала, а не человек:
                // никто не нажимал кнопку и никто не ждёт ответа. Тост
                // оставлен за отказом действия, которое человек запросил сам.
                //
                // Про отказ и так сказано — полосой, которую ставит оболочка на
                // отказавшее чтение. Полоса живёт, пока живёт причина; тост
                // уходит через три секунды и уносит объяснение с собой. Показать
                // оба значит показать одно и то же дважды и убрать половину.
                if (!isAbort(err)) console.error('Живое обновление «Активных» не прошло', err);
            }
        }, 250);
    }

    function flash(row) {
        if (!row) return;
        const wash = getComputedStyle(document.documentElement)
            .getPropertyValue('--ui-color-wash-active').trim() || 'transparent';
        // Уменьшенное движение отменяет ГАШЕНИЕ, а не саму подсветку: держится
        // те же две секунды и пропадает разом.
        const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced || typeof row.animate !== 'function') {
            row.style.backgroundColor = wash;
            setTimeout(() => { row.style.backgroundColor = ''; }, FLASH_MS);
            return;
        }
        row.animate(
            [{ backgroundColor: wash }, { backgroundColor: wash, offset: 0.4 }, { backgroundColor: 'transparent' }],
            { duration: FLASH_MS, easing: 'ease-out' }
        );
    }

    // ------------------------------------------------------------ «Завершённые»

    async function loadDone(more) {
        try {
            const data = await fetchCalls(ctx.api, state.filters, more ? state.cursor : null);
            if (!alive) return;
            applyDone(data, Boolean(more));
            renderDone(data.hasMore);
        } catch (err) {
            if (!isAbort(err)) ctx.toast(err.message, 'error');
        }
    }

    // Числа шапки и состав строк ставятся ОДНИМ действием, из одного ответа.
    // Развести их — значит однажды показать счётчик от одного отбора рядом со
    // строками от другого; ровно за это снималась К183.
    function applyDone(data, more) {
        state.doneLoaded = true;
        state.done = more ? state.done.concat(data.rows) : data.rows;
        state.doneTotal = data.total;
        state.cursor = data.cursor || null;
        // Отбор, который сервер на самом деле применил: период он подставляет
        // сам, и знать о нём экран может только отсюда.
        if (data.filters) {
            state.filters.from = data.filters.from;
            state.filters.to = data.filters.to;
            state.periodIsDefault = data.filters.periodIsDefault;
        }
        $('[data-role="count-done"]').textContent = String(data.total);
        $('[data-role="stat-dialed"]').textContent = String(data.counts.dialed);
        $('[data-role="stat-answered"]').textContent = String(data.counts.answered);
        $('[data-role="stat-rate"]').textContent = data.counts.rate === null ? '—' : `${data.counts.rate} %`;
    }

    function renderDone(hasMore) {
        const body = $('[data-role="done-body"]');
        const wrap = $('[data-role="done-wrap"]');
        const foot = $('[data-role="done-foot"]');
        const empty = $('[data-role="done-empty"]');

        applyColumnVisibility();
        renderFilterChips();

        if (!state.done.length) {
            body.innerHTML = '';
            wrap.hidden = true;
            // ПОДВАЛА НЕТ, КОГДА НЕ НАЙДЕНО НИЧЕГО: строку «Показано 0 из 0» под
            // сообщением «Ничего не найдено» читать незачем.
            foot.hidden = true;
            empty.hidden = false;
            fillDoneEmpty();
            return;
        }

        wrap.hidden = false;
        empty.hidden = true;
        body.innerHTML = '';
        state.done.forEach((row) => {
            body.appendChild(doneRow(row));
            if (row.transferred) body.appendChild(chainRow(row));
        });

        foot.hidden = false;
        $('[data-role="done-shown"]').textContent = `Показано ${state.done.length} из ${state.doneTotal}`;
        $('[data-role="done-more"]').hidden = !hasMore;
    }

    // ДВЕ РАЗНЫЕ ПУСТОТЫ И ДВА РАЗНЫХ ТЕКСТА. Один текст на оба случая всегда
    // врёт в одном из них: «ничего не найдено» при пустом дне обвиняет отбор,
    // которого нет, а «сегодня ещё не звонили» при заданном отборе прячет то,
    // что человек сам и отфильтровал.
    function fillDoneEmpty() {
        const filtered = hasAnyFilter();
        $('[data-role="done-empty-title"]').textContent =
            filtered ? 'Ничего не найдено по текущим фильтрам' : 'Сегодня ещё не звонили';
        $('[data-role="done-empty-text"]').textContent = filtered
            ? ''
            : 'Журнал заполняется по ходу дня. Чтобы посмотреть прошлые дни, поменяйте период в фильтрах.';
        const action = $('[data-role="done-empty-action"]');
        action.textContent = filtered ? 'Сбросить фильтры' : 'Открыть фильтры';
        action.onclick = filtered ? resetFilters : openFiltersModal;
    }

    function doneRow(row) {
        const tr = document.createElement('tr');
        tr.dataset.call = String(row.id);

        const when = blank('when');
        when.appendChild(span('ui-table__main', timeLabel(row.startedAt)));
        when.appendChild(span('ui-table__sub', dayLabel(row.startedAt)));
        tr.appendChild(when);

        // Телефон ссылкой в карточку — переход и есть смысл колонки. Попытка
        // уходит подстрокой: своей колонки она не стоит.
        const phone = blank('phone');
        if (row.leadId) phone.appendChild(leadLink(row.clientPhone, row.leadId));
        else phone.appendChild(document.createTextNode(row.clientPhone || ''));
        if (row.attemptNo) phone.appendChild(span('ui-table__sub', `попытка ${row.attemptNo}`));
        tr.appendChild(phone);

        const dir = directionCell(row.direction);
        dir.dataset.col = 'direction';
        tr.appendChild(dir);

        tr.appendChild(cell(row.lineType, 'line'));

        // Оператор и кнопка разворота перевода — кнопка стоит ЗДЕСЬ, там, где
        // вопрос и возникает: «почему одна фамилия, если говорили двое».
        const op = blank('operator');
        if (row.operator) {
            op.appendChild(span('ui-table__main', row.operator));
            if (row.operatorExtension) op.appendChild(span('ui-table__sub', `доб. ${row.operatorExtension}`));
        } else {
            op.appendChild(dash());
        }
        if (row.transferred) op.appendChild(transferButton(row.id));
        tr.appendChild(op);

        tr.appendChild(cell(row.ourNumber, 'ourNumber'));

        const outcome = blank('outcome');
        if (row.outcome) {
            const pill = span(OUTCOME_PILL[row.outcome] || 'ui-pill', OUTCOME_LABEL[row.outcome] || row.outcome);
            // Сырая строка станции — в подсказке: спор «чья ошибка» решается ею,
            // а на экране она была бы шумом.
            if (row.outcomeRaw) pill.title = `АТС: ${row.outcomeRaw}`;
            outcome.appendChild(pill);
        } else {
            outcome.appendChild(dash());
        }
        tr.appendChild(outcome);

        tr.appendChild(numCell(row.waitSeconds, 'wait'));
        // РАЗГОВОРА НЕ БЫЛО — ПРОЧЕРК, А НЕ «0:00». Ноль здесь означал бы
        // «говорили ноль секунд», а разговора не было вовсе.
        tr.appendChild(numCell(row.talkSeconds, 'talk'));

        const status = blank('funnelStatus');
        // ДОВОД «СТАТУС СТАВИЛ ЧЕЛОВЕК, И ЦВЕТОМ ОН НЕ ОЦЕНИВАЕТСЯ» НЕ ОТМЕНЁН,
        // А СУЖЕН (К246, паспорт Р1 редакции 11). Он верен для статусов, которые
        // поставил человек: красить «Недозвон» значило бы оценивать работу
        // оператора, а раздел — не табель. Но «Нет результата» ставит СИСТЕМА —
        // ровно потому, что человек не поставил ничего, — и это единственное
        // место колонки, где красное уместно: оно про незакрытый долг, а не про
        // оценку.
        //
        // Признак — «ждёт решения руководителя», а не «системный» (К260):
        // системных статусов два, и по второму работа кончена. Приходит он от
        // сервера по идентификатору снимка; пустой признак — нейтральная
        // пилюля, и это состояние 17б, а не ошибка.
        if (row.funnelStatus) {
            status.appendChild(span(
                row.funnelStatusAwaitsManager ? 'ui-pill ui-pill--bad' : 'ui-pill ui-pill--mute',
                row.funnelStatus));
        }
        else status.appendChild(dash());
        tr.appendChild(status);

        const notes = cell(row.notes, 'notes');
        if (row.notes) notes.title = row.notes;
        // ПОМЕТКА СТОИТ ПОД КОММЕНТАРИЕМ, а не своей колонкой: она его и
        // объясняет — почему у долгого разговора две строчки текста (паспорт
        // Р12). Своя колонка пустовала бы почти во всех строках.
        if (row.partiallyFilled) notes.appendChild(span('ui-table__sub', 'карточка заполнена частично'));
        tr.appendChild(notes);

        const rec = document.createElement('td');
        rec.className = 'ui-table__acts';
        rec.dataset.col = 'record';
        // КНОПКИ НЕТ ВОВСЕ, ПОКА НЕТ ЗАПИСИ (ответ куратора И178). Неактивная
        // кнопка обещает то, чего нет, тост на неё — тем более.
        if (row.hasRecord) rec.appendChild(playButton(row.id));
        else rec.appendChild(dash());
        tr.appendChild(rec);

        return tr;
    }

    function transferButton(callId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        // Вид кнопки забрал слой (.ui-table__expand, К295); .zv-transfer
        // остался ради отступа сверху и как адрес обработчика ниже.
        btn.className = 'ui-table__expand zv-transfer';
        btn.setAttribute('aria-expanded', String(state.expanded.has(callId)));
        btn.setAttribute('aria-controls', `zv-chain-${callId}`);
        btn.dataset.chain = String(callId);
        btn.innerHTML = '<svg class="ui-ic" aria-hidden="true"><use href="#ui-ic-chevron-down"></use></svg>';
        btn.appendChild(document.createTextNode('перевод'));
        return btn;
    }

    function playButton(callId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-btn ui-btn--ghost ui-btn--icon';
        btn.dataset.play = String(callId);
        btn.setAttribute('aria-label', 'Прослушать запись');
        btn.innerHTML = '<svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-play"></use></svg>';
        return btn;
    }

    function chainRow(row) {
        const tr = document.createElement('tr');
        // Подложку и отступы забрал слой (.ui-table__detail, К295); имя
        // раздела осталось: по нему ищут строку и правят colSpan.
        tr.className = 'ui-table__detail zv-chain';
        tr.id = `zv-chain-${row.id}`;
        tr.hidden = !state.expanded.has(row.id);
        const td = document.createElement('td');
        td.colSpan = COLUMNS.length;
        td.appendChild(document.createElement('ol'));
        tr.appendChild(td);
        return tr;
    }

    async function toggleChain(btn) {
        const callId = Number(btn.dataset.chain);
        const row = container.querySelector(`#zv-chain-${callId}`);
        if (!row) return;
        const open = !state.expanded.has(callId);
        if (open) state.expanded.add(callId); else state.expanded.delete(callId);
        btn.setAttribute('aria-expanded', String(open));
        row.hidden = !open;
        if (!open) return;

        const list = row.querySelector('ol');
        if (list.childElementCount) return;
        try {
            const data = await fetchChain(ctx.api, callId);
            if (!alive) return;
            list.innerHTML = '';
            data.rows.forEach((part, index) => {
                if (index) {
                    const arrow = document.createElement('li');
                    arrow.className = 'zv-arrow';
                    arrow.textContent = '→ перевод →';
                    list.appendChild(arrow);
                }
                const li = document.createElement('li');
                const who = document.createElement('b');
                // ЗВЕНО ПЕРЕВОДА ПАРТНЁРУ НАЗЫВАЕТСЯ ОФФЕРОМ, а не фамилией:
                // сотрудника у него нет вовсе (часть 9, заход 5, паспорт Р1
                // ред. 8). Имя берётся СНИМКОМ из самого звена — оффер могли
                // удалить, а запись о разговоре меняться не должна.
                who.textContent = part.transferOfferName || part.name || 'неизвестно кто';
                li.appendChild(who);
                // Сеть — подстрокой: одноимённые офферы у разных сетей бывают, и
                // имя без сети их не различает.
                if (part.transferOfferName && part.transferNetworkName) {
                    li.appendChild(span('ui-table__sub', part.transferNetworkName));
                }
                // «1:20», а не «01:20»: в цепочке это ДЛИТЕЛЬНОСТЬ УЧАСТКА, и
                // пишется она так же, как ожидание и разговор в колонках рядом.
                // Ведущий ноль остаётся только у длительности состояния на
                // «Активных», где столбец сравнивают глазом сверху вниз.
                li.appendChild(span('zv-dur', mssShort(part.talkSeconds || 0)));
                list.appendChild(li);
            });
        } catch (err) {
            if (!isAbort(err)) ctx.toast(err.message, 'error');
        }
    }

    async function playRecording(callId) {
        try {
            const data = await fetchRecording(ctx.api, callId);
            if (!alive) return;
            if (data && data.url) window.open(data.url, '_blank', 'noopener');
        } catch (err) {
            // Отказ действия, которое человек запросил сам, и он ждёт ответа —
            // это тот случай, когда тост уместен (паспорт Р1, правило тостов).
            if (!isAbort(err)) ctx.toast(err.message, 'error');
        }
    }

    // ------------------------------------------------------------ отбор

    // ПЕРИОД — ТОЖЕ ОТБОР, И САМЫЙ ЧАСТЫЙ (К198).
    //
    // Его здесь не было, и пустой экран при своём периоде говорил «Сегодня ещё
    // не звонили… поменяйте период в фильтрах» — человеку, который период
    // только что и поменял. Экран отсылал его сделать то, что он уже сделал.
    //
    // «Отличается ли период от умолчания» решает сервер: «сегодня» в проекте
    // берётся только с него.
    function hasAnyFilter() {
        const f = state.filters;
        return Boolean(!state.periodIsDefault || f.employeeId || f.outcome || f.direction
            || f.lineType || f.sourceId || f.withRecord || f.search);
    }

    function activeFilterLabels() {
        const f = state.filters;
        const out = [];
        // Раз период считается отбором, он и в чипах стоит наравне с прочими:
        // короткий список без объяснения — ровно то, от чего чипы и спасают.
        if (!state.periodIsDefault) {
            out.push({
                key: 'period',
                label: 'Период',
                value: f.from === f.to ? dayLabelIso(f.from) : dayLabelIso(f.from) + ' — ' + dayLabelIso(f.to)
            });
        }
        if (f.search) out.push({ key: 'search', label: 'Поиск', value: f.search });
        if (f.employeeId) {
            const op = state.meta.operators.find((o) => o.id === f.employeeId);
            out.push({ key: 'employeeId', label: 'Оператор', value: op ? op.name : `#${f.employeeId}` });
        }
        if (f.outcome) out.push({ key: 'outcome', label: 'Исход', value: OUTCOME_LABEL[f.outcome] || f.outcome });
        if (f.direction) out.push({ key: 'direction', label: 'Направление', value: f.direction === 'in' ? 'входящие' : 'исходящие' });
        if (f.lineType) out.push({ key: 'lineType', label: 'Линия', value: f.lineType });
        if (f.sourceId) {
            const src = state.meta.sources.find((s) => s.id === f.sourceId);
            out.push({ key: 'sourceId', label: 'Источник', value: src ? src.title : `#${f.sourceId}` });
        }
        if (f.withRecord) out.push({ key: 'withRecord', label: 'Только', value: 'с записью' });
        return out;
    }

    function renderFilterChips() {
        const box = $('[data-role="filter-chips"]');
        const list = activeFilterLabels();
        box.innerHTML = '';
        box.hidden = !list.length;
        if (!list.length) return;

        list.forEach((item) => {
            const chip = document.createElement('span');
            chip.className = 'ui-fchip';
            chip.appendChild(document.createTextNode(`${item.label}: `));
            const b = document.createElement('b');
            b.textContent = item.value;
            chip.appendChild(b);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ui-fchip__remove';
            remove.setAttribute('aria-label', 'Убрать');
            remove.innerHTML = '<svg class="ui-ic ui-ic--xs" aria-hidden="true"><use href="#ui-ic-close"></use></svg>';
            remove.addEventListener('click', () => dropFilter(item.key));
            chip.appendChild(remove);
            box.appendChild(chip);
        });

        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'ui-fchips__clear';
        clear.textContent = 'Сбросить все';
        clear.addEventListener('click', resetFilters);
        box.appendChild(clear);
    }

    function dropFilter(key) {
        if (key === 'period') { state.filters.from = null; state.filters.to = null; }
        else if (key === 'withRecord') state.filters.withRecord = false;
        else if (key === 'search') { state.filters.search = ''; $('[data-role="search"]').value = ''; }
        else state.filters[key] = null;
        loadDone();
    }

    function resetFilters() {
        // ПЕРИОД СБРАСЫВАЕТСЯ ВМЕСТЕ СО ВСЕМ ОСТАЛЬНЫМ (К198). Раз он считается
        // отбором, кнопка «Сбросить фильтры» обязана вернуть и его — то есть
        // вернуть человека к сегодняшнему дню. Пустой период при этом не значит
        // «вся история»: сервер подставит умолчание, и это тот же сегодня.
        state.filters = { from: null, to: null, employeeId: null, outcome: null,
            direction: null, lineType: null, sourceId: null, withRecord: false, search: '' };
        $('[data-role="search"]').value = '';
        loadDone();
    }

    function openFiltersModal() {
        if (filtersModal) return;
        const body = document.createElement('div');
        body.className = 'ui-form-grid';

        const f = state.filters;
        const from = dateField(body, 'Период с', f.from);
        const to = dateField(body, 'по', f.to);
        const operator = selectField(body, 'Оператор', [{ value: '', label: 'Любой' }]
            .concat(state.meta.operators.map((o) => ({ value: String(o.id), label: o.name }))), f.employeeId);
        const outcome = selectField(body, 'Исход по АТС', [{ value: '', label: 'Любой' }]
            .concat(Object.keys(OUTCOME_LABEL).map((k) => ({ value: k, label: OUTCOME_LABEL[k] }))), f.outcome);
        const direction = selectField(body, 'Направление', [
            { value: '', label: 'Любое' }, { value: 'in', label: 'Входящие' }, { value: 'out', label: 'Исходящие' }
        ], f.direction);
        const line = selectField(body, 'Линия', [
            { value: '', label: 'Любая' }, { value: 'Входящая', label: 'Входящая' }, { value: 'Исходящая', label: 'Исходящая' }
        ], f.lineType);
        const source = selectField(body, 'Источник лида', [{ value: '', label: 'Любой' }]
            .concat(state.meta.sources.map((s) => ({ value: String(s.id), label: s.title }))), f.sourceId);
        const withRecord = choiceField(body, 'Только с записью', f.withRecord);

        filtersModal = openModal({
            title: 'Фильтры',
            sub: 'Отбор применяется к списку и к счётчикам',
            body,
            scope: container.querySelector('.zv-section') || container,
            size: 'wide',
            spread: true,
            actions: [
                {
                    label: 'Сбросить',
                    variant: 'secondary',
                    side: 'start',
                    onClick: () => {
                        operator.value = ''; outcome.value = ''; direction.value = '';
                        line.value = ''; source.value = ''; withRecord.checked = false;
                        return false;
                    }
                },
                { label: 'Отмена', variant: 'ghost' },
                {
                    label: 'Показать',
                    onClick: () => {
                        state.filters.from = from.value || state.filters.from;
                        state.filters.to = to.value || state.filters.to;
                        state.filters.employeeId = operator.value ? Number(operator.value) : null;
                        state.filters.outcome = outcome.value || null;
                        state.filters.direction = direction.value || null;
                        state.filters.lineType = line.value || null;
                        state.filters.sourceId = source.value ? Number(source.value) : null;
                        state.filters.withRecord = withRecord.checked;
                        loadDone();
                    }
                }
            ]
        });
        filtersModal.result.then(() => { filtersModal = null; });
    }

    // ------------------------------------------------------------ колонки

    function applyColumnVisibility() {
        COLUMNS.forEach((col) => {
            const hidden = state.hiddenColumns.has(col.key);
            container.querySelectorAll(`[data-col="${col.key}"]`).forEach((node) => { node.hidden = hidden; });
        });
        // Развёрнутая строка накрывает всю таблицу — её colspan обязан считаться
        // по ВИДИМЫМ колонкам, иначе цепочка вылезает за край.
        const visible = COLUMNS.filter((c) => !state.hiddenColumns.has(c.key)).length;
        container.querySelectorAll('.zv-chain > td').forEach((td) => { td.colSpan = visible; });
    }

    function openColumnsModal() {
        if (columnsModal) return;
        const body = document.createElement('div');
        const boxes = COLUMNS.map((col) => {
            const label = document.createElement('label');
            label.className = 'ui-choice' + (col.fixed ? ' ui-choice--disabled' : '');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = col.fixed || !state.hiddenColumns.has(col.key);
            input.disabled = Boolean(col.fixed);
            input.dataset.col = col.key;
            label.appendChild(input);
            label.appendChild(document.createTextNode(` ${col.label}`));
            body.appendChild(label);
            return input;
        });

        columnsModal = openModal({
            title: 'Настройка колонок',
            sub: 'Когда, телефон и запись видны всегда',
            body,
            scope: container.querySelector('.zv-section') || container,
            spread: true,
            actions: [
                {
                    label: 'Сбросить',
                    variant: 'secondary',
                    side: 'start',
                    // Возвращает НАБОР ПО УМОЛЧАНИЮ — все колонки, — а не снимает
                    // все галки: из пустого списка выбираться пришлось бы вручную.
                    onClick: () => { boxes.forEach((b) => { b.checked = true; }); return false; }
                },
                { label: 'Отмена', variant: 'ghost' },
                {
                    label: 'Применить',
                    onClick: () => {
                        state.hiddenColumns = new Set(boxes.filter((b) => !b.checked).map((b) => b.dataset.col));
                        writeHiddenColumns(COLUMNS_SECTION, Array.from(state.hiddenColumns));
                        applyColumnVisibility();
                        ctx.toast('Настройки колонок сохранены', 'success');
                    }
                }
            ]
        });
        columnsModal.result.then(() => { columnsModal = null; });
    }

    // ------------------------------------------------------------ выгрузка

    async function exportCalls() {
        const btn = $('[data-role="export-btn"]');
        btn.classList.add('is-busy');
        btn.disabled = true;
        try {
            const data = await fetchCallsForExport(ctx.api, state.filters);
            if (!alive) return;
            const { buildWorkbook } = await import('./callsExport.js');
            buildWorkbook(data.rows, state.filters);
        } catch (err) {
            if (isAbort(err)) return;
            // Отказ выгрузки — единственное, ради чего на этой вкладке уместен
            // тост: человек нажал кнопку и ждёт файла.
            ctx.toast(err.message, 'error');
        } finally {
            btn.classList.remove('is-busy');
            btn.disabled = false;
        }
    }

    // ------------------------------------------------------------ мелочи

    function leadLink(text, leadId) {
        const a = document.createElement('a');
        a.className = 'ui-link';
        a.href = `#/leads?record=${leadId}`;
        a.textContent = text || '';
        return a;
    }

    function directionCell(direction) {
        const td = document.createElement('td');
        if (!direction) { td.appendChild(dash()); return td; }
        const box = document.createElement('span');
        box.className = 'zv-dir';
        box.title = direction === 'in' ? 'Входящий' : 'Исходящий';
        box.innerHTML = `<svg class="ui-ic" aria-hidden="true"><use href="#ui-ic-${
            direction === 'in' ? 'arrow-down-left' : 'arrow-up-right'}"></use></svg>`;
        td.appendChild(box);
        return td;
    }

    // ЯЧЕЙКА СО ЗНАЧЕНИЕМ. Пустое значение — прочерк, и это правило колонки:
    // пустая ячейка читается как «данные не приехали», прочерк — как «значения
    // нет».
    function cell(text, col) {
        const td = blank(col);
        if (text === null || text === undefined || text === '') td.appendChild(dash());
        else td.textContent = text;
        return td;
    }

    // ПУСТАЯ ЯЧЕЙКА, В КОТОРУЮ СОДЕРЖИМОЕ СОБИРАЕТСЯ ПО ЧАСТЯМ, — и она обязана
    // быть отдельной функцией.
    //
    // Первая редакция звала для этого `cell(null, col)`, и та честно ставила
    // прочерк «значения нет», после чего сверху дописывалось значение. На экране
    // это давало «— 15:42», «— +7 916…», «— Абрамова А. А.» в пяти колонках из
    // двенадцати. Поймала браузерная проверка: в дереве доступности ячейка
    // читалась как «—+79011001011 попытка 1».
    function blank(col) {
        const td = document.createElement('td');
        if (col) td.dataset.col = col;
        return td;
    }

    function numCell(seconds, col) {
        const td = document.createElement('td');
        td.className = 'ui-table__num zv-dur';
        td.dataset.col = col;
        if (seconds === null || seconds === undefined) td.appendChild(dash());
        else td.textContent = mssShort(seconds);
        return td;
    }

    function span(className, text) {
        const el = document.createElement('span');
        el.className = className;
        el.textContent = text;
        return el;
    }

    function dash() {
        return span('ui-dash', '—');
    }

    function dateField(parent, label, value) {
        const box = document.createElement('div');
        box.className = 'ui-field';
        const lab = document.createElement('label');
        lab.className = 'ui-field__label';
        lab.textContent = label;
        const input = document.createElement('input');
        input.type = 'date';
        input.className = 'ui-field__control';
        input.value = value || '';
        lab.appendChild(input);
        box.appendChild(lab);
        parent.appendChild(box);
        return input;
    }

    function selectField(parent, label, options, value) {
        const box = document.createElement('div');
        box.className = 'ui-field';
        const lab = document.createElement('label');
        lab.className = 'ui-field__label';
        lab.textContent = label;
        const select = document.createElement('select');
        select.className = 'ui-field__control';
        options.forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            select.appendChild(o);
        });
        select.value = value === null || value === undefined ? '' : String(value);
        lab.appendChild(select);
        box.appendChild(lab);
        parent.appendChild(box);
        return select;
    }

    function choiceField(parent, label, checked) {
        const box = document.createElement('div');
        box.className = 'ui-field ui-field--wide';
        const lab = document.createElement('label');
        lab.className = 'ui-choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(checked);
        lab.appendChild(input);
        lab.appendChild(document.createTextNode(` ${label}`));
        box.appendChild(lab);
        parent.appendChild(box);
        return input;
    }

    function todayLabel() {
        const now = new Date(Date.now() - state.clockSkewMs);
        return now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    }

    function timeLabel(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    // «26.08» из «2026-08-26». Строка разбирается сама: new Date('2026-08-26')
    // читается как UTC-полночь и в минусовых поясах отдаёт предыдущий день.
    function dayLabelIso(iso) {
        if (!iso) return '';
        const parts = String(iso).split('-');
        return parts[2] + '.' + parts[1];
    }

    function dayLabel(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
    }

    return self;
}

// мм:сс — длительность состояния оператора: она бывает часами, и часы здесь
// показываются теми же минутами («124:05»), потому что колонка сравнивается
// глазом сверху вниз, а не читается как время суток.
function mmss(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${pad(m)}:${pad(s)}`;
}

// м:сс — ожидание и разговор. Ведущего нуля у минут нет: «0:06» и «5:25» из
// макета.
function mssShort(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${pad(s)}`;
}

function pad(n) {
    return String(n).padStart(2, '0');
}
