// --- routes/audit.js: чтение журнала изменений (часть 8) -------------------
//
// ЖУРНАЛ ПИШЕТСЯ ТРИГГЕРАМИ С ЧАСТИ 3 и до этой части читался только запросами
// к базе. Здесь появляется единственный способ прочитать его человеком —
// раздел «История изменений» и две вкладки в карточках.
//
// ЧИТАЕТ И ОДНО ПИШЕТ. Изменяющий здесь ровно один маршрут — отметка о выгрузке
// (`POST /export`), и он не меняет данные, а признаётся в том, что данные
// покинули систему пачкой. Разбор — у самого маршрута.
//
// ПАРТИЯ — ОДНА СТРОКА СПИСКА, А НЕ ПЯТЬ ТЫСЯЧ (паспорт Р5). Свёртка живёт
// здесь, а не на экране: экран не должен уметь превращать пять тысяч строк в
// одну — он должен получать одну.

const express = require('express');
const { pool } = require('../db');
const { normalizeForSearch } = require('../services/phoneFormat');
const { zonedParts } = require('../services/appTime');
const appSettings = require('../services/appSettings');
const auditContext = require('../services/auditContext');

const router = express.Router();

// Порция догрузки. Паспорт Р5: «Показано 30 из 342».
//
// ⚠ РАЗМЕР — ЗАКРЫТЫЙ СПИСОК, а не число от браузера. Довод тот же, что у
// `PERIOD_PRESETS` ниже: принимать произвольное число значит принимать и
// представление браузера о том, сколько сервер обязан отдать за раз.
//
// ВТОРОЕ ЗНАЧЕНИЕ ЗАВЕДЕНО РАДИ ВКЛАДКИ КАРТОЧКИ (К275). С привязанными
// записями тридцати строк ей не хватает: у лида с десятками звонков
// собственные правки лида вытеснило бы из видимых, и вкладка показала бы
// ОБРАТНОЕ тому, ради чего заведена, — тридцать звонков вместо прошлого лида.
const PAGE_SIZES = [30, 100];
const PAGE_SIZE = PAGE_SIZES[0];

// ПОТОЛОК ВЫГРУЗКИ — ОДИН НА ПРОЕКТ (ответ куратора И207, сведено в 7Б).
// Библиотека одна, браузер один, файл собирается одинаково; два разных числа
// были бы будущим вопросом «а почему там можно больше».
const EXPORT_LIMIT = 50000;

// Виды операции журнала. `export` — седьмая строка не от триггера, см. POST ниже.
const OPS = ['insert', 'update', 'delete', 'export'];

// ПЕРИОД ПО УМОЛЧАНИЮ — СЕМЬ ДНЕЙ, а не «сегодня» (решение куратора, ответ 10
// по Р5). Журнал открывают, чтобы разобраться в том, что УЖЕ случилось, а «уже
// случилось» редко значит «сегодня». Этим он и отличается от «Звонков», где
// умолчание — как раз сегодня.
const DEFAULT_PERIOD_DAYS = 7;

// ПРЕСЕТЫ ПЕРИОДА ТУЛБАРА ПЕРЕВОДЯТСЯ В ДАТЫ ЗДЕСЬ, А НЕ В БРАУЗЕРЕ (К204).
//
// Первая редакция считала даты на экране, а «сегодня» брала из ответа сервера —
// из того самого поля, которое обработчик списка обнулял строкой выше. Ветка
// была мертва целиком: ни один пресет до сервера не доходил, и «Сегодня»
// показывало ровно то же, что «За 30 дней».
//
// Считать там, где «сегодня» известно, не только надёжнее — это единственное
// место, где оно известно верно: часы у руководителя могут стоять в другом
// поясе. Список закрытый: принимать от браузера произвольное число дней значит
// принимать и его представление о том, где кончается сегодня.
const PERIOD_PRESETS = [1, 7, 30];

// РАЗДЕЛЫ, У КОТОРЫХ ЕСТЬ КАРТОЧКА (ответ куратора И209). Ссылка ведёт в
// карточку записи, а карточка есть у двоих; остальные разделы правят записи,
// которые открываются иначе или не открываются вовсе. Вести «в раздел вообще»
// значит обещать переход и не дать его — тогда лучше текст без ссылки.
const CARD_SECTIONS = { leads: 'leads', employees: 'employees' };

// ⚠ ЧТО НЕ ПОКАЗЫВАТЬ В КАРТОЧКЕ, ХОТЯ ОНО ПРИВЯЗАНО (решение куратора).
// Исключение стоит ЗДЕСЬ, а не в `audit_rules`, и это разные вещи: в правилах
// записано, ЧТО ЗАПИСЫВАТЬ, а здесь — ЧТО ПОКАЗЫВАТЬ. Ключи туннеля привязаны к
// сотруднику служебно; в его истории это шум, и шум про доступы.
const CARD_SCOPE_SKIP = ['tunnel_key_tokens'];

// Имя таблицы и колонки уходит в SQL ИДЕНТИФИКАТОРОМ, а не параметром, и
// проверяется по образцу до подстановки. Значения приходят из своей же схемы,
// но «пришло из базы» не то же самое, что «можно склеить»: правила правят
// руками, и опечатка в них не должна становиться выражением.
const IDENT_RE = /^[a-z_][a-z_0-9]*$/;

// ---------------------------------------------------------------- список

router.get('/', async (req, res) => {
    try {
        const filters = await readFilters(req.query);
        const built = await buildWhere(filters);
        if (built.impossible) return res.json(emptyAnswer(filters));

        const { where, params } = built;
        const whereSql = where.join(' AND ');

        // СВЁРТКА ПАРТИЙ. В разделе одна партия — одна строка; внутри вкладки
        // карточки и внутри отбора по партии сворачивать нечего и нельзя:
        // человек просил показать именно записи.
        const collapse = !filters.batchId && !filters.recordId;

        const counts = await countAll(whereSql, params, collapse);

        // ПОТОЛОК ВЫГРУЗКИ ПРОВЕРЯЕТСЯ ДО СБОРКИ, А НЕ ПОСЛЕ (К205, пункт В4.6).
        //
        // Отказ отдаётся обычным ответом, а не кодом ошибки, и это не мелочь:
        // оболочка вешает полосу «Данные не загрузились» на ЛЮБОЙ неудавшийся
        // запрос панели. Отказ по потолку — не отказ чтения: список на экране
        // цел, не собрался только файл. Сказать про это полосой значило бы
        // соврать про сам список.
        if (filters.forExport && counts.total > EXPORT_LIMIT) {
            return res.json({
                ...emptyAnswer(filters),
                tooMany: true,
                total: counts.total,
                limit: EXPORT_LIMIT
            });
        }

        const list = await selectPage(whereSql, params, filters, collapse);

        const rows = list.map((r) => toRow(r, filters));
        await attachCards(rows);

        res.json({
            rows,
            total: counts.total,
            counts: {
                changes: counts.total,
                records: counts.records,
                batches: counts.batches
            },
            cursor: rows.length
                ? { at: list[list.length - 1].sort_at_key, id: Number(list[list.length - 1].sort_id) }
                : null,
            // Выгрузка берёт всю выборку одним куском, и догружать ей нечего.
            hasMore: !filters.forExport && rows.length === filters.limit,
            filters: {
                from: filters.from,
                to: filters.to,
                periodIsDefault: filters.periodIsDefault,
                sort: filters.sort
            },
            auditStartedAt: filters.auditStartedAt
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить журнал изменений' });
    }
});

// ---------------------------------------------------------------- справочники окна отбора

router.get('/meta', async (req, res) => {
    try {
        const [tables, actors, startedAt] = await Promise.all([
            // ТАБЛИЦЫ — ТЕ, ЧТО В ЖУРНАЛЕ ЕСТЬ, а не все, что есть в базе.
            // Отбор по таблице, которую никто ни разу не менял, — это заведомо
            // пустой список; предлагать его значит предлагать тупик.
            pool.query('SELECT DISTINCT table_name FROM audit_log ORDER BY table_name'),
            // АВТОРЫ ТРЁХ ВИДОВ, и они собираются по-разному. Люди — из самой
            // базы сотрудников: человек, ни разу ничего не менявший, в отборе
            // всё равно нужен («почему у него пусто» — законный вопрос).
            // Служебные — только те, что в журнале действительно встречались:
            // их список не задан нигде, он складывается по ходу работы.
            Promise.all([
                pool.query('SELECT id, last_name, first_name, middle_name FROM employees ORDER BY last_name, first_name'),
                pool.query("SELECT DISTINCT actor_name FROM audit_log WHERE actor_kind = 'service' AND actor_name IS NOT NULL ORDER BY actor_name")
            ]),
            appSettings.get(pool, 'audit_started_at', null)
        ]);

        res.json({
            tables: tables.rows.map((r) => r.table_name),
            people: actors[0].rows.map((r) => ({ id: r.id, name: shortName(r) })),
            services: actors[1].rows.map((r) => r.actor_name),
            ops: OPS,
            auditStartedAt: startedAt
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить справочники журнала' });
    }
});

// ---------------------------------------------------------------- сводка партии

router.get('/batch/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '');
        if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: 'Неверный номер партии' });

        // СВОДКА СОБИРАЕТСЯ ИЗ ЖУРНАЛА, А СТРОКА ПАРТИИ ЕЁ УТОЧНЯЕТ (К212).
        //
        // Порядок был обратным: не нашли строку в `audit_batches` — 404, и
        // разворот упирался в «Сводку партии получить не удалось». А строки
        // этой может не быть: в живой базе такова каждая третья партия — следы
        // старого кода, заводившего партию не полностью. Записи в журнале от
        // этого никуда не делись, и человек про них спрашивает.
        //
        // Журнал знает почти всё сам: сколько строк, сколько записей, какие
        // таблицы, какие поля, когда началась. Из строки партии нужны ровно две
        // вещи, которых в журнале нет, — вид операции и имя файла.
        //
        // СВОДКА, А НЕ ЗАПИСИ. Пять тысяч строк внутрь разворота не помещаются
        // никогда: разворот отвечает на «что это было», а сами записи
        // открываются отбором.
        const summary = await pool.query(
            `SELECT count(*)::int AS rows,
                    count(DISTINCT (table_name || '#' || COALESCE(record_id, '')))::int AS records,
                    array_agg(DISTINCT table_name) AS tables,
                    min(changed_at) AS started_at
               FROM audit_log WHERE batch_id = $1`,
            [id]
        );

        // Пусто в САМОМ ЖУРНАЛЕ — вот это и есть «партии не существует».
        if (!summary.rows[0].rows) return res.status(404).json({ error: 'Партия не найдена' });

        const batch = await pool.query(
            `SELECT b.id, b.kind, b.title, b.file_name, b.started_at, b.actor_kind, b.actor_name, b.page
               FROM audit_batches b WHERE b.id = $1`,
            [id]
        );

        // Какие поля задела партия. Массив изменений разворачивается в поля —
        // «какие поля правили» первый вопрос при разборе неудачной загрузки.
        const fields = await pool.query(
            `SELECT DISTINCT ch ->> 'field' AS field
               FROM audit_log l, jsonb_array_elements(l.changes) ch
              WHERE l.batch_id = $1
              ORDER BY field
              LIMIT 40`,
            [id]
        );

        const row = batch.rows[0] || null;
        res.json({
            id,
            kind: row ? row.kind : null,
            title: row ? row.title : null,
            fileName: row ? row.file_name : null,
            // Время начала — из строки партии, а нет её — из первой строки
            // журнала этой партии: она и есть момент, когда партия пошла.
            startedAt: row ? row.started_at : summary.rows[0].started_at,
            actor: row ? { kind: row.actor_kind, name: row.actor_name } : { kind: 'service', name: null },
            page: row ? row.page : null,
            rows: summary.rows[0].rows,
            records: summary.rows[0].records,
            tables: summary.rows[0].tables || [],
            fields: fields.rows.map((r) => r.field).filter(Boolean)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить сводку партии' });
    }
});

// ---------------------------------------------------------------- след вернувшегося лида
//
// Плашка «Лид позвонил сам» (паспорт Р7, решения владельца 74 и 75) берёт из
// журнала три вещи: когда лид ушёл в архив, каким был его прежний статус и
// когда пришёл входящий. ОТДЕЛЬНОГО ПОЛЯ И ОТДЕЛЬНОЙ ТАБЛИЦЫ ПОД ЭТО НЕ
// ЗАВОДИТСЯ — журнал уже хранит и статус читаемым именем, и время. Иначе рядом
// с журналом завелось бы второе хранилище того же самого.
//
// ПОКАЗЫВАТЬ ПЛАШКУ СЕГОДНЯ НЕЧЕМ: входящих звонков не бывает до этапа Е, и
// `missed_at` заполнять некому. Запрос делается сейчас (ответ куратора И195),
// потому что он часть этого пункта, а написать его в чужую сессию дороже.
router.get('/lead-return/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Неверный номер лида' });

        const lead = await pool.query('SELECT id, archived_at, missed_at FROM leads WHERE id = $1', [id]);
        if (!lead.rows.length) return res.status(404).json({ error: 'Лид не найден' });

        // Последний уход в архив и последняя смена статуса ДО него. Запрос
        // узкий: одна запись и несколько последних её строк.
        const trail = await pool.query(
            `SELECT l.changed_at, l.changes
               FROM audit_log l
              WHERE l.table_name = 'leads' AND l.record_id = $1
              ORDER BY l.changed_at DESC, l.id DESC
              LIMIT 50`,
            [String(id)]
        );

        let archivedAt = null;
        let previousStatus = null;
        for (const row of trail.rows) {
            const changes = Array.isArray(row.changes) ? row.changes : [];
            const archived = changes.find((c) => c.field === 'archived_at');
            if (archived && archived.after && !archivedAt) archivedAt = row.changed_at;
            // ПРЕЖНИЙ СТАТУС — ТОТ, ЧТО БЫЛ ДО УХОДА В АРХИВ, и берётся он из
            // расшифровки, а не из идентификатора: человеку нужно имя.
            const status = changes.find((c) => c.field === 'funnel_status_id');
            if (status && archivedAt && !previousStatus) {
                previousStatus = status.beforeTitle || status.before || null;
            }
        }

        res.json({
            leadId: id,
            archivedAt: archivedAt || lead.rows[0].archived_at || null,
            previousStatus,
            // Момент входящего звонка — признак лида, заведённый частью 7А.
            missedAt: lead.rows[0].missed_at || null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось прочитать след лида' });
    }
});

// ---------------------------------------------------------------- отметка о выгрузке
//
// ФАКТ ВЫГРУЗКИ ПИШЕТСЯ В САМ ЖУРНАЛ (бриф, часть 8, пункт 4). Это единственное
// место проекта, где строка журнала появляется НЕ ОТ ТРИГГЕРА, и потому оно
// объяснено здесь, а не подразумевается.
//
// Почему вообще пишется. Выгрузка — единственный момент, когда данные покидают
// систему пачкой: файл копируют, пересылают и забывают. Это то же место, что
// показ пароля АТС.
//
// АВТОР — ЧЕЛОВЕК, А НЕ СЛУЖЕБНОЕ ИМЯ (условие куратора, ответ И208). Выгрузку
// делает человек, и в журнале должен стоять он — со всеми оговорками про то,
// что в админке никто не называется: тогда встанет честное «не указан».
router.post('/export', async (req, res) => {
    try {
        const rows = Number(req.body && req.body.rows);
        if (!Number.isInteger(rows) || rows < 0) return res.status(400).json({ error: 'Неверное число строк' });

        const filters = req.body && typeof req.body.filters === 'object' ? req.body.filters : {};
        // ТЕМ ЖЕ СПОСОБОМ, ЧТО И ТРИГГЕР. `currentSettings()` отдаёт ровно тот
        // набор, который уходит в настройки соединения: номер, вид автора, имя
        // (уже разрешённое по базе, а не то, что назвал браузер), страница и
        // партия. Читать заголовки в маршруте значило бы завести второй способ
        // узнать автора — и он разошёлся бы с журналом в первый же спорный случай.
        const [actorId, actorKind, actorName, page] = auditContext.currentSettings();

        // Пишем ОДНОЙ строкой и своими руками: триггеру здесь сработать не с
        // чего — выгрузка ничего не меняет.
        await pool.query(
            `INSERT INTO audit_log (op, table_name, record_id, record_title,
                                    actor_employee_id, actor_kind, actor_name, page, changes)
             VALUES ('export', 'audit_log', NULL, 'Выгрузка журнала',
                     $1, $2, $3, $4, $5::jsonb)`,
            [
                actorId ? Number(actorId) : null,
                actorKind || 'none',
                actorName || null,
                page || 'history',
                JSON.stringify([
                    { field: 'rows', level: 'full', before: null, after: String(rows) },
                    { field: 'filters', level: 'full', before: null, after: describeFilters(filters) }
                ])
            ]
        );

        res.status(204).end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось записать отметку о выгрузке' });
    }
});

// ---------------------------------------------------------------- сборка запроса

/**
 * УСЛОВИЕ «ЭТА ЗАПИСЬ И ВСЁ, ЧТО К НЕЙ ПРИВЯЗАНО» (К275).
 *
 * ⚠ СПИСОК ТАБЛИЦ ЧИТАЕТСЯ ИЗ `audit_rules`, А НЕ ВПИСАН В КОД. Имён двадцать
 * одно у семи владельцев (замер на `64add46`), и вписанные в код они разошлись
 * бы со схемой на первой же новой привязанной таблице — молча. Так новая
 * таблица подхватывается сама: `lead_comments` приехала лентой комментариев и
 * попала бы в отбор без единой правки здесь.
 *
 * ДВЕ ГРУППЫ, И ЗАПРОС ИМ НУЖЕН РАЗНЫЙ:
 *   · группа А — ключ записи СОВПАДАЕТ с колонкой привязки (`lead_offers` и ещё
 *     шесть). У них `record_id` в журнале УЖЕ равен номеру владельца, и всё
 *     решается одним условием без единого подзапроса;
 *   · группа Б — ключ свой (`calls` и остальные четырнадцать), до владельца
 *     надо идти в саму таблицу.
 *
 * ⚠ СЛЕПОЕ ПЯТНО, И ОНО НАЗВАНО НАРОЧНО. Удалённая запись группы Б в подзапрос
 * не попадает: строки в таблице больше нет. Живой случай ровно один —
 * `routes/schedule.js:215`, снятый день графика сотрудника; по остальным
 * таблицам группы Б удалений в коде нет. У группы А пятна нет по устройству.
 * Лезть за владельцем в `changes` удалённой записи не стали: разбор JSON в
 * условии отбора дорог и хрупок, а случай один.
 */
async function cardScopeSql(filters, params) {
    params.push(filters.recordTable);
    const tableParam = params.length;
    params.push(filters.recordId);
    const idParam = params.length;

    // Сама запись — первым слагаемым и всегда.
    const parts = [`(l.table_name = $${tableParam} AND l.record_id = $${idParam})`];

    const rules = await pool.query(
        `SELECT table_name, key_column, card_column
           FROM audit_rules
          WHERE column_name = '*' AND card_table = $1`,
        [filters.recordTable]
    );

    const groupA = [];
    for (const rule of rules.rows) {
        const table = rule.table_name;
        const column = rule.card_column;
        const key = rule.key_column || 'id';
        if (CARD_SCOPE_SKIP.includes(table)) continue;
        // Негодное имя пропускается молча: это опечатка в правилах, а не запрос
        // человека, и валить ей весь журнал незачем.
        if (!IDENT_RE.test(table) || !IDENT_RE.test(column) || !IDENT_RE.test(key)) continue;
        if (key === column) { groupA.push(table); continue; }
        params.push(table);
        parts.push(
            `(l.table_name = $${params.length} AND l.record_id IN (`
            + `SELECT ${quoteIdent(key)}::text FROM ${quoteIdent(table)}`
            + ` WHERE ${quoteIdent(column)}::text = $${idParam}))`
        );
    }

    if (groupA.length) {
        params.push(groupA);
        parts.push(`(l.table_name = ANY($${params.length}::text[]) AND l.record_id = $${idParam})`);
    }

    return `(${parts.join(' OR ')})`;
}

async function readFilters(query) {
    const today = todayIso();
    const defaultFrom = shiftIso(today, -(DEFAULT_PERIOD_DAYS - 1));
    const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
    const asDate = (value, fallback) => (isDate(value) ? String(value).trim() : fallback);

    // Пресет тулбара считается только тогда, когда дат не прислали. Даты
    // старше пресета: их выбрали руками в окне отбора, а вкладка карточки
    // просит журнал записи целиком и шлёт `from` явно.
    const days = PERIOD_PRESETS.includes(Number(query.days)) ? Number(query.days) : null;
    const explicit = isDate(query.from) || isDate(query.to);

    const from = !explicit && days ? shiftIso(today, -(days - 1)) : asDate(query.from, defaultFrom);
    const to = !explicit && days ? today : asDate(query.to, today);

    return {
        from,
        to,
        // Умолчание — семь дней, считая сегодняшний. Отличается — значит период
        // выбран человеком, и экран считает его отбором.
        periodIsDefault: from === defaultFrom && to === today,
        page: String(query.page || '').trim().slice(0, 64) || null,
        table: String(query.table || '').trim().slice(0, 64) || null,
        op: OPS.includes(query.op) ? query.op : null,
        actorId: intOrNull(query.actorId),
        // 'none' — «назваться было некому», 'service' — любой служебный автор,
        // имя — конкретный служебный. Путать первое со вторым нельзя.
        actorKind: ['none', 'service'].includes(query.actorKind) ? query.actorKind : null,
        actorName: String(query.actorName || '').trim().slice(0, 64) || null,
        batchOnly: query.batchOnly === '1',
        batchId: /^[0-9a-fA-F-]{36}$/.test(String(query.batchId || '')) ? String(query.batchId) : null,
        // Размер порции — из закрытого списка; всё прочее приводится к 30.
        limit: PAGE_SIZES.includes(Number(query.limit)) ? Number(query.limit) : PAGE_SIZE,
        recordTable: String(query.recordTable || '').trim().slice(0, 64) || null,
        recordId: String(query.recordId || '').trim().slice(0, 64) || null,
        search: String(query.search || '').trim().slice(0, 64),
        // ПОРЯДОК — ОДИН НА СПИСОК, и колонка у него одна: «Когда». В остальных
        // колонках лежат разнородные значения, и сортировка по ним ничего не
        // значит (паспорт Р5). Умолчание — свежие сверху.
        sort: query.sort === 'asc' ? 'asc' : 'desc',
        // Признак выгрузки читается ЗДЕСЬ, а не в маршруте: он меняет и потолок
        // строк, и постраничность, и то и другое живёт в сборке запроса.
        forExport: query.export === '1',
        cursorAt: String(query.cursorAt || '').trim() || null,
        cursorId: intOrNull(query.cursorId),
        auditStartedAt: await appSettings.get(pool, 'audit_started_at', null)
    };
}

async function buildWhere(filters) {
    const where = [];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('$$', `$${params.length}`)); };

    add('l.changed_at >= $$::date', filters.from);
    add('l.changed_at < ($$::date + 1)', filters.to);

    if (filters.page) add('l.page = $$', filters.page);
    if (filters.table) add('l.table_name = $$', filters.table);
    if (filters.op) add('l.op = $$', filters.op);
    if (filters.actorId) add('l.actor_employee_id = $$', filters.actorId);
    if (filters.actorKind) add('l.actor_kind = $$', filters.actorKind);
    if (filters.actorName) add('l.actor_name = $$', filters.actorName);
    if (filters.batchOnly) where.push('l.batch_id IS NOT NULL');
    if (filters.batchId) add('l.batch_id = $$', filters.batchId);
    // ⚠ ОТБОР КАРТОЧКИ ВИДИТ И ПРИВЯЗАННЫЕ ЗАПИСИ (К275).
    //
    // Раньше здесь стояли два условия — «эта таблица» и «этот номер», — и
    // записи привязанных таблиц не попадали в карточку НИКОГДА: у оффера лида
    // своё имя таблицы. Владелец не видел, что оффер сняли, хотя запись об этом
    // в журнале была.
    //
    // Расширение работает ТОЛЬКО когда названы оба: одно имя таблицы без номера
    // — это отбор раздела, расширять его нечем и незачем.
    if (filters.recordTable && filters.recordId) {
        where.push(await cardScopeSql(filters, params));
    } else {
        if (filters.recordTable) add('l.table_name = $$', filters.recordTable);
        if (filters.recordId) add('l.record_id = $$', filters.recordId);
    }

    // ⚠ ПОИСК ВМЕСТЕ С ОТБОРОМ ПО ЗАПИСИ СУЖАЕТ ОБРАТНО ДО САМОЙ ЗАПИСИ,
    // и это названо нарочно (К275). Пары ниже — «таблица#номер», для лида
    // это `leads#42`; строки привязанных таблиц в них не входят и
    // отсеются условием `AND`. Расширение при поиске молча схлопывается к
    // прежнему поведению. Так и оставлено: поиск спрашивает про конкретную
    // запись, и подмешивать к ответу чужие записи он не должен.
    if (filters.search) {
        const found = await resolveSearch(filters.search);
        if (!found.length) return { impossible: true };
        // Пары «таблица#номер» одним параметром: длина списка ограничена
        // resolveSearch, и разворачивать её в отдельные параметры незачем.
        params.push(found);
        where.push(`(l.table_name || '#' || COALESCE(l.record_id, '')) = ANY($${params.length}::text[])`);
    }

    return { where, params };
}

/**
 * ПОИСК «ПО ЗАПИСИ» — СНАЧАЛА НАХОДИТ ЗАПИСИ, ПОТОМ ОТДАЁТ ИХ СТРОКИ
 * (требование паспорта Р5, ответ куратора И204).
 *
 * Совпадать со снимком имени нельзя: имя записи в журнале — снимок на момент
 * изменения. Лида переименовали или исправили ему номер — и прежние строки
 * хранят прежнее имя; поиск по снимку разорвал бы историю переименованного
 * надвое и половину потерял. Телефона это касается прямо: у лида он входит в
 * имя записи, а вкладка «Номера на разбор» телефоны как раз меняет.
 *
 * Ищем в «Лидах» и «Сотрудниках» — тех, у кого есть, что искать; остальное
 * добираем по снимку имени, потому что иначе не добрать вовсе.
 */
async function resolveSearch(text) {
    const { exact, digits } = normalizeForSearch(text);
    const like = `%${text.toLowerCase()}%`;
    const keys = new Set();

    const leads = await pool.query(
        `SELECT id FROM leads
          WHERE lower(COALESCE(last_name, '') || ' ' || COALESCE(first_name, '')) LIKE $1
             OR ($2::text IS NOT NULL AND phone = $2)
             OR ($3::text <> '' AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%')
          LIMIT 500`,
        [like, exact, digits]
    );
    leads.rows.forEach((r) => keys.add(`leads#${r.id}`));

    const employees = await pool.query(
        `SELECT id FROM employees
          WHERE lower(COALESCE(last_name, '') || ' ' || COALESCE(first_name, '')) LIKE $1
             OR ($2::text <> '' AND pbx_extension = $2)
          LIMIT 500`,
        [like, digits]
    );
    employees.rows.forEach((r) => keys.add(`employees#${r.id}`));

    // ЦИФРЫ ИЩУТСЯ И КАК НОМЕР ЗАПИСИ (ответ куратора И205). Разделять нечем:
    // «1042» это и номер лида, и кусок телефона, и промолчать про одно из двух
    // хуже, чем показать оба.
    if (digits) {
        const byNumber = await pool.query(
            `SELECT DISTINCT table_name, record_id FROM audit_log
              WHERE record_id = $1 LIMIT 200`,
            [digits]
        );
        byNumber.rows.forEach((r) => keys.add(`${r.table_name}#${r.record_id}`));
    }

    // Записи без своего поиска — по снимку имени. Это не заменяет поиск по
    // записи, а дополняет его там, где искать больше негде.
    const bySnapshot = await pool.query(
        `SELECT DISTINCT table_name, record_id FROM audit_log
          WHERE lower(COALESCE(record_title, '')) LIKE $1 LIMIT 200`,
        [like]
    );
    bySnapshot.rows.forEach((r) => keys.add(`${r.table_name}#${r.record_id || ''}`));

    return Array.from(keys);
}

// СЧЁТЧИКИ СЧИТАЮТСЯ ПО ЭЛЕМЕНТАМ СПИСКА, А НЕ ПО СЫРЫМ СТРОКАМ.
//
// Партия — одна строка, и «Изменений 342» считает именно строки списка. Так и
// задумано паспортом: чип «Массовых операций» стоит рядом ПРЕДУПРЕЖДАЮЩИМ —
// «две партии за день это две строки, за которыми тысячи записей, и в числе
// „342 изменения" этого не видно». Считай мы сырые строки, предупреждать было
// бы не о чем: тысячи и так стояли бы в числе.
async function countAll(whereSql, params, collapse) {
    const q = await pool.query(
        `SELECT count(*) FILTER (WHERE l.batch_id IS NULL)::int AS singles,
                count(DISTINCT l.batch_id)::int AS batches,
                count(*)::int AS raw,
                count(DISTINCT (l.table_name || '#' || COALESCE(l.record_id, '')))
                    FILTER (WHERE l.batch_id IS NULL)::int AS records_singles,
                count(DISTINCT (l.table_name || '#' || COALESCE(l.record_id, '')))::int AS records_all
           FROM audit_log l WHERE ${whereSql}`,
        params
    );
    const r = q.rows[0];
    return {
        total: collapse ? r.singles + r.batches : r.raw,
        // «ЗАТРОНУТО ЗАПИСЕЙ» СЧИТАЕТСЯ ПО ТЕМ ЖЕ СТРОКАМ, ЧТО ПОКАЗАНЫ (К206).
        //
        // Пока партии свёрнуты, строки партий из этого числа исключаются
        // намеренно: за одной строкой стоят тысячи записей, и складывать их с
        // одиночными правками значило бы отнять смысл у чипа «Массовых
        // операций», который об этих тысячах и предупреждает.
        //
        // Но там, где одиночных правок в отборе НЕТ ВОВСЕ, исключать нечего:
        // прежний счёт давал ноль при сорока шести строках на экране. Случаев
        // таких три — отбор по партии, вкладка карточки и «только массовые
        // операции», — и правило написано по данным, а не по этим трём именам:
        // отбор по периоду, в который попали одни лишь партии, дал бы тот же
        // ноль, а имени у такого случая нет.
        records: collapse && r.singles ? r.records_singles : r.records_all,
        batches: r.batches
    };
}

async function selectPage(whereSql, params, filters, collapse) {
    const p = params.slice();
    // ПОРЯДОК ЗАДАЁТ И СРАВНЕНИЕ КУРСОРА. Курсор — это «строго дальше по тому
    // же порядку»; развернув порядок и оставив «меньше», мы бы догружали не
    // следующую порцию, а первую же снова.
    const asc = filters.sort === 'asc';
    const dir = asc ? 'ASC' : 'DESC';
    // КЛЮЧ КУРСОРА — СТРОКА ИЗ САМОЙ БАЗЫ. Колонка типа timestamp приезжает в
    // узел объектом Date в поясе машины, и, вернувшись параметром, сдвинулась бы
    // на смещение пояса. Тот же урок, что в «Звонках».
    const KEY = `to_char(%s, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

    let cursorSql = '';
    // У ВЫГРУЗКИ КУРСОРА НЕТ: она берёт всю выборку разом, с начала и до
    // потолка. Догружать файл нечем и незачем.
    if (!filters.forExport && filters.cursorId && filters.cursorAt) {
        p.push(filters.cursorAt);
        const atIdx = p.length;
        p.push(filters.cursorId);
        const idIdx = p.length;
        cursorSql = ` AND (sort_at, sort_id) ${asc ? '>' : '<'} ($${atIdx}::timestamp, $${idIdx}::bigint)`;
    }

    const single = `
        SELECT 'row'::text AS kind, l.id AS sort_id, l.changed_at AS sort_at,
               ${KEY.replace('%s', 'l.changed_at')} AS sort_at_key,
               l.id, l.changed_at, l.op, l.table_name, l.record_id, l.record_title,
               l.actor_employee_id, l.actor_kind, l.actor_name, l.page, l.batch_id,
               l.changes, NULL::int AS batch_rows, NULL::text AS batch_title,
               NULL::text AS batch_file, NULL::varchar AS batch_kind
          FROM audit_log l
         WHERE ${whereSql}${collapse ? ' AND l.batch_id IS NULL' : ''}`;

    const batched = `
        SELECT 'batch'::text AS kind, max(l.id) AS sort_id, max(l.changed_at) AS sort_at,
               ${KEY.replace('%s', 'max(l.changed_at)')} AS sort_at_key,
               max(l.id) AS id, max(l.changed_at) AS changed_at, 'batch'::varchar AS op,
               NULL::varchar AS table_name, NULL::varchar AS record_id, NULL::varchar AS record_title,
               NULL::int AS actor_employee_id, 'service'::varchar AS actor_kind,
               max(b.title) AS actor_name, max(l.page) AS page, l.batch_id,
               '[]'::jsonb AS changes, count(*)::int AS batch_rows,
               max(b.title) AS batch_title, max(b.file_name) AS batch_file,
               max(b.kind) AS batch_kind
          FROM audit_log l
          LEFT JOIN audit_batches b ON b.id = l.batch_id
         WHERE ${whereSql} AND l.batch_id IS NOT NULL
         GROUP BY l.batch_id`;

    // ПОТОЛОК ВЫГРУЗКИ — 50 000, И ОН НАКОНЕЦ СТОИТ В ЗАПРОСЕ (К205). Прежде
    // число было объявлено и не использовано ни разу: выгрузка уходила с той же
    // порцией в тридцать строк, что и экран, и файл врал про полноту молча.
    const limit = filters.forExport ? EXPORT_LIMIT : filters.limit;

    const sql = `
        SELECT * FROM (${collapse ? `${single} UNION ALL ${batched}` : single}) t
         WHERE true${cursorSql}
         ORDER BY sort_at ${dir}, sort_id ${dir}
         LIMIT ${limit}`;

    const result = await pool.query(sql, p);
    return result.rows;
}

function toRow(r, filters) {
    return {
        kind: r.kind,
        id: Number(r.id),
        changedAt: r.changed_at,
        op: r.op,
        table: r.table_name,
        recordId: r.record_id,
        recordTitle: r.record_title,
        actor: { kind: r.actor_kind, name: r.actor_name },
        page: r.page,
        batchId: r.batch_id,
        batch: r.kind === 'batch'
            ? { rows: r.batch_rows, title: r.batch_title, fileName: r.batch_file, kind: r.batch_kind }
            : null,
        changes: Array.isArray(r.changes) ? r.changes : [],
        // ⚠ ПРИЗНАК ПРИВЯЗАННОЙ ЗАПИСИ (К275). `false` — правка САМОЙ записи,
        // `true` — правка привязанной к ней. Без него во вкладке сотрудника его
        // собственные правки лежали бы вперемешку с правками его расписания, и
        // человек не понял бы, почему в истории сотрудника чужая строка.
        attached: Boolean(filters && filters.recordTable && filters.recordId
            && r.table_name !== filters.recordTable),
        card: null,
        // Проставляется в attachCards и только для строк, чью запись искали.
        deleted: false
    };
}

/**
 * ЧЬЮ КАРТОЧКУ ОТКРЫВАТЬ. Правило живёт в таблице `audit_rules` (часть 3):
 * своей карточки у записи может не быть, тогда открывается карточка владельца —
 * оффер лида ведёт в лида.
 *
 * ВЛАДЕЛЕЦ ЧИТАЕТСЯ ПАЧКОЙ, А НЕ ПО СТРОКЕ. Тридцать строк списка дали бы
 * тридцать запросов; здесь их столько, сколько разных таблиц на странице, —
 * обычно две-три.
 *
 * УДАЛЁННАЯ ЗАПИСЬ ССЫЛКИ НЕ ПОЛУЧАЕТ. Проверяется существованием, а не видом
 * операции: запись могли создать, потом удалить, и строка о создании тоже никуда
 * не ведёт. Ссылка, приводящая в никуда, хуже текста.
 */
async function attachCards(rows) {
    const tables = Array.from(new Set(rows.map((r) => r.table).filter(Boolean)));
    if (!tables.length) return;

    const rules = await pool.query(
        `SELECT table_name, key_column, card_table, card_column
           FROM audit_rules WHERE column_name = '*' AND table_name = ANY($1::text[])`,
        [tables]
    );
    const byTable = new Map(rules.rows.map((r) => [r.table_name, r]));

    // Что искать: у каждой строки либо своя карточка (таблица сама в списке
    // разделов с карточками), либо карточка владельца.
    const wanted = new Map();   // 'leads' -> Set(id)
    const plan = [];            // { row, section, needOwner, ownerFrom }

    rows.forEach((row) => {
        if (!row.table || !row.recordId) return;
        const rule = byTable.get(row.table);
        const ownTable = row.table;
        if (!rule || !rule.card_table) {
            const section = CARD_SECTIONS[ownTable];
            if (!section) return;
            plan.push({ row, section, table: ownTable, id: row.recordId });
            if (!wanted.has(ownTable)) wanted.set(ownTable, new Set());
            wanted.get(ownTable).add(row.recordId);
            return;
        }
        const section = CARD_SECTIONS[rule.card_table];
        if (!section) return;
        plan.push({ row, section, table: rule.card_table, viaTable: ownTable, viaColumn: rule.card_column,
            viaKey: rule.key_column || 'id', viaId: row.recordId });
    });

    // Владельцы: один запрос на исходную таблицу.
    const viaGroups = new Map();
    plan.filter((p) => p.viaTable).forEach((p) => {
        const key = `${p.viaTable}|${p.viaColumn}|${p.viaKey}`;
        if (!viaGroups.has(key)) viaGroups.set(key, []);
        viaGroups.get(key).push(p);
    });

    for (const [key, group] of viaGroups) {
        const [table, column, keyColumn] = key.split('|');
        const ids = Array.from(new Set(group.map((g) => g.viaId)));
        let found;
        try {
            found = await pool.query(
                `SELECT ${quoteIdent(keyColumn)}::text AS own, ${quoteIdent(column)}::text AS owner
                   FROM ${quoteIdent(table)} WHERE ${quoteIdent(keyColumn)}::text = ANY($1::text[])`,
                [ids]
            );
        } catch (err) {
            // Таблицу могли переименовать, колонку — снять. Журнал от этого не
            // ломается: строка останется без ссылки, но останется.
            continue;
        }
        const owners = new Map(found.rows.map((r) => [r.own, r.owner]));
        group.forEach((g) => {
            const ownerId = owners.get(String(g.viaId));
            if (!ownerId) return;
            g.id = ownerId;
            if (!wanted.has(g.table)) wanted.set(g.table, new Set());
            wanted.get(g.table).add(ownerId);
        });
    }

    // Существование: ссылка ставится только на живую запись.
    const alive = new Map();
    for (const [table, ids] of wanted) {
        const found = await pool.query(
            `SELECT id::text AS id FROM ${quoteIdent(table)} WHERE id::text = ANY($1::text[])`,
            [Array.from(ids)]
        );
        alive.set(table, new Set(found.rows.map((r) => r.id)));
    }

    plan.forEach((p) => {
        // Владельца не нашли — значит связочная строка удалена вместе со своей
        // записью. Ссылки нет, и сказать про это можно честно.
        if (!p.id) { p.row.deleted = true; return; }
        const set = alive.get(p.table);
        if (!set || !set.has(String(p.id))) { p.row.deleted = true; return; }
        p.row.card = { section: p.section, id: Number(p.id) };
    });

    // ПРИЗНАК «УДАЛЕНА» СТАВИТСЯ ТОЛЬКО ТАМ, ГДЕ ЗАПИСЬ ИСКАЛИ. У таблиц без
    // карточки — справочников, настроек, самих правил аудита — мы её не искали
    // вовсе, и молчание здесь единственный честный ответ: экран не вправе
    // объявлять удалённым всё, во что нельзя перейти.
}

// ---------------------------------------------------------------- мелочи

function emptyAnswer(filters) {
    return {
        rows: [],
        total: 0,
        counts: { changes: 0, records: 0, batches: 0 },
        cursor: null,
        hasMore: false,
        filters: {
            from: filters.from,
            to: filters.to,
            periodIsDefault: filters.periodIsDefault,
            sort: filters.sort
        },
        auditStartedAt: filters.auditStartedAt
    };
}

// Отбор словами — для строки журнала о выгрузке. Читать её будут через год и
// без экрана рядом, поэтому «весь журнал», а не «без отбора»: первое говорит,
// что попало в файл, второе — чего человек не нажал.
function describeFilters(filters) {
    const parts = [];
    if (filters.from || filters.to) parts.push(`период ${filters.from || '…'} — ${filters.to || '…'}`);
    if (filters.page) parts.push(`раздел ${filters.page}`);
    if (filters.table) parts.push(`таблица ${filters.table}`);
    if (filters.op) parts.push(`вид ${filters.op}`);
    if (filters.search) parts.push(`поиск «${filters.search}»`);
    if (filters.batchOnly) parts.push('только массовые');
    return parts.length ? parts.join(', ') : 'весь журнал';
}

function quoteIdent(name) {
    // В выражение попадает только то, что пришло из таблицы правил, и всё равно
    // экранируется: правила — рабочий инструмент, их правят руками.
    return '"' + String(name).replace(/"/g, '""') + '"';
}

function intOrNull(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function todayIso() {
    const p = zonedParts(new Date());
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function shiftIso(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const moved = new Date(Date.UTC(y, m - 1, d + days));
    const pad = (n) => String(n).padStart(2, '0');
    return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

function shortName(row) {
    const initials = [row.first_name, row.middle_name]
        .filter(Boolean)
        .map((part) => `${String(part).trim().charAt(0).toUpperCase()}.`)
        .join(' ');
    return [row.last_name, initials].filter(Boolean).join(' ');
}

module.exports = router;
