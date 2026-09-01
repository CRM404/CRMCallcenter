// --- History/js/modules/historyApp.js: раздел «История изменений» ----------
//
// Контракт раздела (бриф, 3.2):
//     export async function mount(container, ctx)
//     export function unmount()
//
// РАЗДЕЛ ТОЛЬКО ЧИТАЕТ. Ни выделения строк, ни массовых действий, ни колонки
// кнопок: делать со строкой журнала нечего. Откатить изменение отсюда нельзя —
// откат обходил бы всю логику проверок, ровно как прямая правка базы.
//
// СТРОКУ РИСУЕТ ОБЩИЙ МОДУЛЬ (`Shell/history/historyTable.js`), а не этот файл:
// та же строка стоит во вкладках карточек лида и сотрудника. Здесь — отбор,
// счётчики, подвал и пустые состояния: они у раздела и у вкладки разные.

import { openModal } from '/ui/modal.js';
import { isAbort } from '/api.js';
import { registry } from '/shell/app.js';
import { renderRow } from '/history/historyTable.js';
import {
    fetchHistory, fetchHistoryForExport, fetchMeta, fetchBatch, markExport
} from './historyStorage.js';

const SEARCH_DEBOUNCE_MS = 300;

// Виды операции человеческими словами. «Создание» и «удаление» названы отдельно
// потому, что без них создание неотличимо от правки, а удаление выглядит как
// обнуление всех полей разом.
const OP_LABEL = {
    insert: 'Создание',
    update: 'Изменение',
    delete: 'Удаление',
    export: 'Выгрузка журнала'
};

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

/**
 * Указание из адреса передаётся живому разделу. Панель у раздела одна: держать
 * список экземпляров всё равно приходится ради unmount, и брать из него
 * последний — то же самое, что брать единственный.
 */
export function applyParams(params) {
    const self = instances[instances.length - 1];
    if (self) self.applyParams(params);
}

function createInstance(container, ctx) {
    const $ = (sel) => container.querySelector(sel);

    const state = {
        filters: {
            from: null, to: null, page: null, table: null, op: null,
            actorId: null, actorKind: null, actorName: null,
            batchOnly: false, batchId: null, search: '',
            recordTable: null, recordId: null
        },
        // Ярлык партии для чипа: сервер отдаёт сводку, а подпись собирается
        // здесь — «Партия: Импорт 24.08, 15:04».
        batchLabel: null,
        // Ярлык записи для чипа. Пока строки не пришли — техническое имя;
        // после первой порции берётся снимок имени из самой строки.
        recordLabel: null,
        // Пресет периода тулбара. 'custom' — когда даты выбраны в окне.
        period: '7',
        // Порядок списка. Свежие сверху — умолчание паспорта.
        sort: 'desc',
        meta: { tables: [], people: [], services: [], ops: [] },
        rows: [],
        total: 0,
        cursor: null,
        periodIsDefault: true,
        auditStartedAt: null
    };

    let alive = true;
    let searchTimer = null;
    let filtersModal = null;

    const self = {
        start,
        applyParams,
        destroy() {
            alive = false;
            if (searchTimer) clearTimeout(searchTimer);
            if (filtersModal) filtersModal.close();
        }
    };

    async function start() {
        fillPageSelect();
        bindEvents();
        const [meta, data] = await Promise.all([
            fetchMeta(ctx.api).catch(() => state.meta),
            fetchHistory(ctx.api, state.filters, null)
        ]);
        if (!alive) return;
        state.meta = meta;
        apply(data, false);
        render(data.hasMore);
    }

    // РАЗДЕЛЫ БЕРУТСЯ ИЗ РЕЕСТРА ОБОЛОЧКИ, а не переписываются списком: иначе
    // список устареет на первом же новом разделе. «Оператор» дописывается
    // отдельно — его страница в оболочку не входит и подписывается своим
    // ключом (проверено куратором, ответ И194).
    function fillPageSelect() {
        const select = $('[data-role="page"]');
        registry.forEach((section) => {
            const o = document.createElement('option');
            o.value = section.key;
            o.textContent = section.title;
            select.appendChild(o);
        });
        const operator = document.createElement('option');
        operator.value = 'operator';
        operator.textContent = 'Оператор';
        select.appendChild(operator);
    }

    function bindEvents() {
        $('[data-role="search"]').addEventListener('input', (e) => {
            const value = e.target.value;
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                state.filters.search = value.trim();
                load();
            }, SEARCH_DEBOUNCE_MS);
        });

        $('[data-role="period"]').addEventListener('change', (e) => {
            const value = e.target.value;
            // «ПРОИЗВОЛЬНЫЙ ПЕРИОД…» ОТКРЫВАЕТ ОКНО ОТБОРА, а не заводит вторую
            // пару полей в тулбаре: список тулбара и поля окна держат одно
            // состояние, и второй пары там быть не должно.
            if (value === 'custom') { openFiltersModal(); return; }
            // ПРЕСЕТ НЕ ПЕРЕВОДИТСЯ В ДАТЫ ЗДЕСЬ (К204). Прежняя редакция это
            // делала — и брала «сегодня» из `state.filters.to`, который сама же
            // обнуляла строкой выше. Ветка не срабатывала ни разу: в запросе не
            // было ни одной даты, и все три пресета показывали одно и то же.
            // Теперь на сервер уходит число дней, а даты считает он.
            state.period = value;
            state.filters.from = null;
            state.filters.to = null;
            load();
        });

        $('[data-role="page"]').addEventListener('change', (e) => {
            state.filters.page = e.target.value || null;
            load();
        });

        // СОРТИРУЕТСЯ ТОЛЬКО ВРЕМЯ. Признак сортируемого заголовка стоял в
        // разметке с самого начала, а обработчика не было вовсе: нажатие не
        // делало ничего, и порядок не менялся (К207). Признак, который ничего
        // не делает, хуже отсутствия признака.
        const sortHead = $('[data-role="sort-when"]');
        sortHead.addEventListener('click', toggleSort);
        sortHead.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();   // Пробел иначе прокручивает панель
            toggleSort();
        });

        $('[data-role="more"]').addEventListener('click', () => load(true));
        $('[data-role="filters-btn"]').addEventListener('click', openFiltersModal);
        $('[data-role="export-btn"]').addEventListener('click', doExport);
    }

    /**
     * УКАЗАНИЕ ИЗ АДРЕСА: `#/history?recordTable=leads&recordId=42` — показать
     * журнал одной записи.
     *
     * Ставит такие ссылки вкладка «История» в карточке: подвал говорит
     * «Показаны последние 30 из N», и кнопка рядом ведёт сюда. Догрузки в
     * карточке нет намеренно (паспорт Р5, редакция 6) — разбор живёт в разделе,
     * и приводить человека в общий список, где нужную запись ещё надо найти,
     * значило бы не выполнить обещание кнопки.
     *
     * ПЕРИОД РАЗДВИГАЕТСЯ НА ВЕСЬ ЖУРНАЛ. Умолчание — семь дней, а карточка
     * показывала всё; прийти по кнопке и увидеть меньше, чем было видно до
     * нажатия, — худший из возможных переходов. Дальше начала журнала двигать
     * незачем: раньше него записей не существует.
     */
    function applyParams(params) {
        // ДВА РАЗНЫХ УКАЗАНИЯ, И ПУТАТЬ ИХ НЕЛЬЗЯ.
        //
        //   `table` — весь журнал одной таблицы: «кто менял настройки».
        //     Приходит с экрана настроек (решение владельца 112).
        //   `recordTable` + `recordId` — прошлое ОДНОЙ записи: «кто менял вот
        //     этого лида». Приходит из карточки.
        //
        // Первое отвечает на вопрос о хозяйстве целиком, второе — о строке.
        // Отбор по одной настройке на экране настроек был бы ответом не на тот
        // вопрос: человек пришёл посмотреть, кто вообще сюда лазил.
        const whole = String((params && params.table) || '').trim();
        if (whole) {
            state.filters.table = whole;
            widenPeriod();
            load();
            return;
        }

        const table = String((params && params.recordTable) || '').trim();
        const id = String((params && params.recordId) || '').trim();
        if (!table || !id) return;

        state.filters.recordTable = table;
        state.filters.recordId = id;
        state.recordLabel = `${table} #${id}`;

        widenPeriod();
        load();
    }

    /** Период на весь журнал: умолчание — семь дней, а пришедший по ссылке ждёт всё. */
    function widenPeriod() {
        const started = state.auditStartedAt ? String(state.auditStartedAt).slice(0, 10) : null;
        if (!started) return;
        state.period = 'custom';
        state.filters.from = started;
        state.filters.to = null;
        $('[data-role="period"]').value = 'custom';
    }

    // ------------------------------------------------------------ данные

    async function load(more) {
        try {
            const data = await fetchHistory(ctx.api, queryFilters(), more ? state.cursor : null);
            if (!alive) return;
            apply(data, Boolean(more));
            render(data.hasMore);
        } catch (err) {
            // ТОСТОВ У РАЗДЕЛА НЕТ ВОВСЕ (К209, паспорт Р5). Отказ чтения
            // показывает полоса слоя: её вешает оболочка на любой неудавшийся
            // запрос панели, и живёт полоса, пока живёт причина. Тост же гаснет
            // через три секунды — и вместе с ним уходит единственное
            // объяснение пустого списка.
            if (!isAbort(err)) console.error('Журнал изменений: список не загрузился', err);
        }
    }

    function toggleSort() {
        state.sort = state.sort === 'desc' ? 'asc' : 'desc';
        $('[data-role="sort-icon"]')
            .setAttribute('href', state.sort === 'asc' ? '#ui-ic-sort-asc' : '#ui-ic-sort-desc');
        // Порядок сменился — курсор от прежнего порядка недействителен.
        state.cursor = null;
        load();
    }

    // ПЕРИОД УХОДИТ ПРЕСЕТОМ, ДАТЫ СЧИТАЕТ СЕРВЕР. «Сегодня» известно верно
    // только там: часы у руководителя могут стоять в другом поясе, а границу
    // суток задаёт рабочий пояс системы, а не браузер.
    function queryFilters() {
        const f = { ...state.filters, sort: state.sort };
        if (state.period !== 'custom' && !f.from && !f.to) f.days = Number(state.period);
        return f;
    }

    function apply(data, more) {
        state.rows = more ? state.rows.concat(data.rows) : data.rows;
        state.total = data.total;
        state.cursor = data.cursor;
        state.periodIsDefault = data.filters.periodIsDefault;
        state.auditStartedAt = data.auditStartedAt;
        if (!more) {
            state.filters.from = data.filters.from;
            state.filters.to = data.filters.to;
        }
        // Снимок имени — из самой строки: техническое «leads #42» человек
        // читать не обязан, а имя в журнале уже есть.
        //
        // ⚠ ИМЕННО ИЗ СВОЕЙ СТРОКИ, А НЕ ИЗ ПЕРВОЙ (К275). Порядок по времени, и
        // с привязанными записями первой может оказаться строка звонка — тогда
        // пилюля показала бы телефон клиента вместо имени лида.
        if (state.filters.recordId && !more && data.rows.length) {
            const own = data.rows.find((row) => !row.attached && row.recordTitle);
            if (own) state.recordLabel = own.recordTitle;
        }
        $('[data-role="stat-changes"]').textContent = String(data.counts.changes);
        $('[data-role="stat-records"]').textContent = String(data.counts.records);
        $('[data-role="stat-batches"]').textContent = String(data.counts.batches);
    }

    // ------------------------------------------------------------ отрисовка

    function render(hasMore) {
        const body = $('[data-role="history-body"]');
        const wrap = $('[data-role="table-wrap"]');
        const foot = $('[data-role="foot"]');
        const empty = $('[data-role="empty"]');

        renderChips();
        renderStartedNote();

        if (!state.rows.length) {
            body.innerHTML = '';
            wrap.hidden = true;
            foot.hidden = true;
            empty.hidden = false;
            fillEmpty();
            return;
        }

        wrap.hidden = false;
        empty.hidden = true;
        body.innerHTML = '';
        state.rows.forEach((row) => {
            renderRow(row, {
                columns: ['when', 'who', 'page', 'record'],
                onCard: openCard,
                onBatch: filterByBatch,
                loadBatch: (id) => fetchBatch(ctx.api, id)
            }).forEach((tr) => body.appendChild(tr));
        });

        foot.hidden = false;
        $('[data-role="shown"]').textContent = `Показано ${state.rows.length} из ${state.total}`;
        $('[data-role="more"]').hidden = !hasMore;
    }

    // ДАТА ВКЛЮЧЕНИЯ ЖУРНАЛА НАЗЫВАЕТСЯ ОБЯЗАТЕЛЬНО. Без неё отсутствие записей
    // читается как «запись никто не трогал». Минимальная дата в самом журнале не
    // годится: чистили — соврёт, поэтому дата приходит из таблицы настроек.
    function renderStartedNote() {
        const node = $('[data-role="started-note"]');
        if (!state.auditStartedAt) {
            node.textContent = 'Журнал ведётся не с начала времён: изменения, сделанные до его включения, в него не попали.';
            return;
        }
        node.textContent = `Журнал ведётся с ${humanDate(state.auditStartedAt)}. Изменения, сделанные раньше, в него не попали — их отсутствие не значит, что запись не менялась.`;
    }

    // ДВЕ РАЗНЫЕ ПУСТОТЫ И ДВА РАЗНЫХ ТЕКСТА. Один текст на оба случая всегда
    // врёт в одном из них.
    function fillEmpty() {
        const filtered = hasAnyFilter();
        $('[data-role="empty-title"]').textContent = filtered
            ? 'Ничего не найдено'
            : `За ${periodWord()} ничего не меняли`;
        $('[data-role="empty-text"]').textContent = filtered
            ? 'По выбранному отбору изменений нет. Снимите часть условий — возможно, ищете в другом разделе или в другой таблице.'
            : 'За выбранный период записей в журнале нет. Это не сбой: в системе просто не было изменений.';
        // ЗНАЧОК — ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ РАЗЛИЧЕНИЯ (К208). Он стоял в
        // разметке жёстко, и «Ничего не найдено» выходило под значком журнала,
        // то есть под знаком второго случая: пусто не потому, что не нашли, а
        // потому, что менять было нечего.
        $('[data-role="empty-icon"]')
            .setAttribute('href', filtered ? '#ui-ic-search' : '#ui-ic-history');

        const action = $('[data-role="empty-action"]');
        action.textContent = filtered ? 'Сбросить отбор' : 'Показать за 30 дней';
        action.onclick = filtered ? resetFilters : showThirtyDays;
    }

    function periodWord() {
        if (state.period === '1') return 'сегодня';
        if (state.period === '7') return 'неделю';
        if (state.period === '30') return 'месяц';
        return 'выбранный период';
    }

    function showThirtyDays() {
        state.period = '30';
        $('[data-role="period"]').value = '30';
        state.filters.from = null;
        state.filters.to = null;
        load();
    }

    // ------------------------------------------------------------ отбор

    /**
     * Есть ли отбор ПОМИМО периода.
     *
     * ПЕРИОД СЮДА НЕ ВХОДИТ, и это видно по самим текстам паспорта: первое
     * пустое состояние говорит «За выбранный период записей в журнале нет», а
     * его заголовок склоняется по пресету — «За сегодня», «За месяц». Пока
     * период считался отбором, эти слова было не показать вовсе: любой пресет,
     * кроме умолчания, уводил на «Ничего не найдено», а умолчание на рабочем
     * стенде пустым не бывает. Второе состояние про другое — «Снимите часть
     * условий», и снимать там нечего, если условие одно и это период.
     *
     * Нашлось при проверке К204: пока период не доходил до сервера, разницы не
     * было видно вообще.
     */
    function hasAnyFilter() {
        const f = state.filters;
        return Boolean(f.page || f.table || f.op || f.actorId || f.actorKind
            || f.actorName || f.batchOnly || f.batchId || f.recordId || f.search);
    }

    function activeFilterLabels() {
        const f = state.filters;
        const out = [];
        // ⚠ ПИЛЮЛЯ НАЗЫВАЕТ РАСШИРЕНИЕ (К275). Отбор шире одной записи —
        // в нём и привязанные к ней; подпись «Запись» после этого неправда, и
        // человек не понял бы, почему в списке строки не той записи.
        if (f.recordId) {
            out.push({
                key: 'record',
                label: f.recordTable ? 'Запись и связанное' : 'Запись',
                value: state.recordLabel || `#${f.recordId}`
            });
        }
        if (f.batchId) out.push({ key: 'batchId', label: 'Партия', value: state.batchLabel || 'выбранная' });
        if (!state.periodIsDefault) {
            out.push({
                key: 'period',
                label: 'Период',
                value: f.from === f.to ? shortDate(f.from) : `${shortDate(f.from)} — ${shortDate(f.to)}`
            });
        }
        if (f.search) out.push({ key: 'search', label: 'Поиск', value: f.search });
        if (f.page) out.push({ key: 'page', label: 'Раздел', value: pageTitle(f.page) });
        if (f.table) out.push({ key: 'table', label: 'Таблица', value: f.table });
        if (f.op) out.push({ key: 'op', label: 'Вид', value: OP_LABEL[f.op] || f.op });
        if (f.actorId) {
            const person = state.meta.people.find((p) => p.id === f.actorId);
            out.push({ key: 'actorId', label: 'Автор', value: person ? person.name : `#${f.actorId}` });
        }
        if (f.actorKind === 'none') out.push({ key: 'actorKind', label: 'Автор', value: 'не указан' });
        if (f.actorName) out.push({ key: 'actorName', label: 'Автор', value: f.actorName });
        if (f.batchOnly) out.push({ key: 'batchOnly', label: 'Только', value: 'массовые операции' });
        return out;
    }

    function renderChips() {
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
        if (key === 'period') {
            state.period = '7';
            $('[data-role="period"]').value = '7';
            state.filters.from = null;
            state.filters.to = null;
        } else if (key === 'record') {
            state.filters.recordTable = null;
            state.filters.recordId = null;
            state.recordLabel = null;
        } else if (key === 'batchOnly') {
            state.filters.batchOnly = false;
        } else if (key === 'batchId') {
            state.filters.batchId = null;
            state.batchLabel = null;
        } else if (key === 'search') {
            state.filters.search = '';
            $('[data-role="search"]').value = '';
        } else if (key === 'page') {
            state.filters.page = null;
            $('[data-role="page"]').value = '';
        } else {
            state.filters[key] = null;
        }
        load();
    }

    function resetFilters() {
        state.filters = {
            from: null, to: null, page: null, table: null, op: null,
            actorId: null, actorKind: null, actorName: null,
            batchOnly: false, batchId: null, search: '',
            recordTable: null, recordId: null
        };
        state.batchLabel = null;
        state.recordLabel = null;
        state.period = '7';
        $('[data-role="period"]').value = '7';
        $('[data-role="page"]').value = '';
        $('[data-role="search"]').value = '';
        load();
    }

    /**
     * ПАРТИЯ — ЭТО ОТБОР, А НЕ РЕЖИМ. Кнопка в развороте ставит отбор: список
     * превращается в список этой партии, в чипах появляется «Партия: …».
     * Своего «режима партии» раздел не заводит — снимается она так же, как
     * любой другой отбор.
     */
    function filterByBatch(batchId, summary) {
        state.filters.batchId = batchId;
        // ПОДПИСЬ БЕРЁТСЯ ИЗ ТОГО, ЧТО ЕСТЬ. У партии может не быть своей
        // строки — тогда нет и подписи, зато есть время начала из журнала;
        // «Партия: выбранная» не говорит человеку ничего о том, что он открыл.
        const when = summary && summary.startedAt ? shortDateTime(summary.startedAt) : null;
        const title = summary && summary.title ? summary.title : 'массовая операция';
        state.batchLabel = when ? `${title}, ${when}` : title;
        load();
    }

    function openCard(card) {
        // Переход в карточку записи — адресом, а не перезагрузкой: оболочка
        // слушает hashchange и откроет раздел с указанием сама (механизм 7Б).
        window.location.hash = `#/${card.section}?record=${card.id}`;
    }

    // ------------------------------------------------------------ окно отбора

    function openFiltersModal() {
        if (filtersModal) return;
        const body = document.createElement('div');
        body.className = 'ui-form-grid';
        const f = state.filters;

        const from = dateField(body, 'Период с', f.from);
        const to = dateField(body, 'по', f.to);

        const authors = [{ value: '', label: 'Любой' }]
            .concat(state.meta.people.map((p) => ({ value: `id:${p.id}`, label: p.name })))
            .concat(state.meta.services.map((s) => ({ value: `service:${s}`, label: s })))
            .concat([{ value: 'none', label: 'Автор не указан' }]);
        const author = selectField(body, 'Автор', authors, currentAuthorValue());

        const pages = [{ value: '', label: 'Все разделы' }]
            .concat(registry.map((s) => ({ value: s.key, label: s.title })))
            .concat([{ value: 'operator', label: 'Оператор' }]);
        const page = selectField(body, 'Раздел', pages, f.page);

        const tables = [{ value: '', label: 'Все таблицы' }]
            .concat(state.meta.tables.map((t) => ({ value: t, label: t })));
        const table = selectField(body, 'Таблица', tables, f.table);

        const ops = [{ value: '', label: 'Любой' }]
            .concat(Object.keys(OP_LABEL).map((k) => ({ value: k, label: OP_LABEL[k] })));
        const op = selectField(body, 'Вид изменения', ops, f.op);

        const batchOnly = choiceField(body, 'Только массовые операции', f.batchOnly);

        filtersModal = openModal({
            title: 'Фильтры',
            sub: 'Отбор применяется к списку и к счётчикам',
            body,
            scope: container.querySelector('.hi-section') || container,
            size: 'wide',
            spread: true,
            actions: [
                {
                    label: 'Сбросить',
                    variant: 'secondary',
                    side: 'start',
                    onClick: () => {
                        author.value = ''; page.value = ''; table.value = '';
                        op.value = ''; batchOnly.checked = false;
                        return false;
                    }
                },
                { label: 'Отмена', variant: 'ghost' },
                {
                    label: 'Показать',
                    onClick: () => {
                        state.filters.from = from.value || null;
                        state.filters.to = to.value || null;
                        // Даты выбраны руками — тулбар переходит в «произвольный».
                        state.period = from.value || to.value ? 'custom' : state.period;
                        $('[data-role="period"]').value = state.period;
                        applyAuthor(author.value);
                        state.filters.page = page.value || null;
                        $('[data-role="page"]').value = page.value || '';
                        state.filters.table = table.value || null;
                        state.filters.op = op.value || null;
                        state.filters.batchOnly = batchOnly.checked;
                        load();
                    }
                }
            ]
        });
        filtersModal.result.then(() => { filtersModal = null; });
    }

    /**
     * Отказ выгрузки: в отборе больше строк, чем уходит в файл.
     *
     * ОКНО, А НЕ ТОСТ. Это отказ действия, которое человек запросил сам, и
     * ответ на него — число, которое надо прочесть и сравнить со своим отбором.
     * Тост на три секунды для этого не годится.
     */
    function showTooMany(data) {
        const body = document.createElement('div');
        // Абзац без класса: отступы абзаца в теле окна задаёт слой
        // (`.ui-modal__body p`), своего правила раздел не заводит.
        const p = document.createElement('p');
        p.textContent = `Отобрано строк: ${count(data.total)}. Выгрузка отдаёт не больше `
            + `${count(data.limit)} — сузьте период или отбор, и файл соберётся.`;
        body.appendChild(p);

        const modal = openModal({
            title: 'Файл не собран',
            sub: 'В отборе больше строк, чем уходит в файл',
            body,
            scope: container.querySelector('.hi-section') || container,
            actions: [{ label: 'Понятно' }]
        });
        modal.result.catch(() => {});
    }

    function count(n) {
        return Number(n).toLocaleString('ru-RU');
    }

    function currentAuthorValue() {
        const f = state.filters;
        if (f.actorId) return `id:${f.actorId}`;
        if (f.actorName) return `service:${f.actorName}`;
        if (f.actorKind === 'none') return 'none';
        return '';
    }

    // ТРИ ВИДА АВТОРА РАЗБИРАЮТСЯ ПООТДЕЛЬНОСТИ. «Не указан» — это не «нет
    // отбора»: это отбор по тем строкам, где назваться было некому.
    function applyAuthor(value) {
        state.filters.actorId = null;
        state.filters.actorKind = null;
        state.filters.actorName = null;
        if (!value) return;
        if (value === 'none') { state.filters.actorKind = 'none'; return; }
        if (value.startsWith('id:')) { state.filters.actorId = Number(value.slice(3)); return; }
        if (value.startsWith('service:')) { state.filters.actorName = value.slice(8); }
    }

    // ------------------------------------------------------------ выгрузка

    async function doExport() {
        const btn = $('[data-role="export-btn"]');
        btn.classList.add('is-busy');
        btn.disabled = true;
        try {
            const data = await fetchHistoryForExport(ctx.api, queryFilters());
            if (!alive) return;
            // ОТКАЗ ПО ПОТОЛКУ — ОКНОМ С ЧИСЛОМ, а не молча урезанным файлом.
            // Человек должен узнать, сколько он просил и сколько отдаётся: без
            // числа «сузьте отбор» — совет вслепую.
            if (data.tooMany) { showTooMany(data); return; }
            const { buildWorkbook } = await import('./historyExport.js');
            buildWorkbook(data.rows, queryFilters());
            // ОТМЕТКА — ПОСЛЕ ТОГО, КАК ФАЙЛ СОБРАН. Отметиться о выгрузке,
            // которая не состоялась, значит записать в журнал неправду.
            await markExport(ctx.api, data.rows.length, queryFilters());
            // Список перечитывается: отметка о выгрузке — тоже строка журнала,
            // и не показать её сразу значило бы спрятать собственный след.
            load();
        } catch (err) {
            if (isAbort(err)) return;
            ctx.toast(err.message, 'error');
        } finally {
            btn.classList.remove('is-busy');
            btn.disabled = false;
        }
    }

    // ------------------------------------------------------------ мелочи

    function pageTitle(key) {
        const found = registry.find((s) => s.key === key);
        if (found) return found.title;
        return key === 'operator' ? 'Оператор' : key;
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

    return self;
}

// Строка разбирается сама: new Date('2026-08-26') читается как UTC-полночь и в
// минусовых поясах отдаёт предыдущий день.
function shortDate(iso) {
    if (!iso) return '';
    const parts = String(iso).split('-');
    return `${parts[2]}.${parts[1]}`;
}

function shortDateTime(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// «24 августа 2026», без «г.» на конце: точку в конце фразы ставит сам текст,
// и вместе они давали «…2026 г..». Хвост снимается здесь, а не правкой текста:
// текст паспортный, а «г.» — свойство браузерного формата.
function humanDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
        .replace(/\s*г\.?$/, '');
}
