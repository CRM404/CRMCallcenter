// --- services/auditContext.js: кто и с какой страницы менял данные ---
//
// Журнал пишет триггер в базе, а триггер не знает ни про запросы, ни про
// браузер. Единственное, что он умеет читать, — настройки соединения. Значит
// задача этого файла одна: донести до соединения то, чем назвался браузер, и
// не дать этому значению протечь в чужой запрос.
//
// ЧТО ИМЕННО ЗАПИСЫВАЕТСЯ. Не «кто изменил», а «кем назвался браузер», и в
// интерфейсе так и написано. В CRM нет входа: админка никого не спрашивает,
// оператор прикладывает свой номер к запросу, и сервер верит на слово —
// прислать чужой номер ничто не мешает. В обычной работе это одно и то же; в
// споре, ради которого аудит и заводят, это разные вещи (план 10.3).
//
// ТРИ ВИДА АВТОРА, И ПЕРВЫЕ ДВА ПУТАТЬ НЕЛЬЗЯ:
//   browser — назвался, и мы записали его слова;
//   none    — назваться было некому (админка без входа);
//   service — импорт, раздача, миграция: действие системы, а не человека.
// Написать «указан браузером» там, где никто не назывался, значит придать
// журналу достоверность, которой у него нет.

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

// Заголовки ставит единый транспорт оболочки (Shell/api.js) и транспорт
// страницы оператора. Двух правок хватает на все разделы разом — именно ради
// этого оболочка и сводила запросы в одну функцию.
const HEADER_ACTOR = 'x-crm-actor';
const HEADER_PAGE = 'x-crm-page';
const HEADER_BATCH = 'x-crm-batch';
const HEADER_BATCH_TITLE = 'x-crm-batch-title';

// Имя автора берётся из базы по номеру, а не из заголовка: номер браузер
// прислать может любой, но имя по этому номеру пусть будет настоящее — иначе
// в журнале появится человек, которого не существует.
//
// Кэш на минуту, потому что операторов шестеро, а запросов от них десятки в
// минуту: без него каждый запрос оператора тянул бы за собой лишний поход в
// базу за именем, которое не меняется месяцами.
const NAME_TTL_MS = 60 * 1000;
const nameCache = new Map();

async function resolveActorName(pool, id) {
    const cached = nameCache.get(id);
    if (cached && cached.until > Date.now()) return cached.name;
    let name = null;
    try {
        const found = await pool.query('SELECT last_name, first_name, middle_name FROM employees WHERE id = $1', [id]);
        const row = found.rows[0];
        if (row) {
            const initials = [row.first_name, row.middle_name]
                .filter(Boolean)
                .map((part) => `${String(part).trim().charAt(0).toUpperCase()}.`)
                .join(' ');
            name = [row.last_name, initials].filter(Boolean).join(' ');
        }
    } catch (err) {
        // Имя — украшение записи, а не её суть. Не смогли узнать — пишем без
        // имени, но запись не теряем.
        console.error('Аудит: не удалось узнать имя автора', err.message);
    }
    nameCache.set(id, { name, until: Date.now() + NAME_TTL_MS });
    return name;
}

/**
 * Заводит партию массовой операции. Одно действие человека обязано читаться
 * как одно, а не как пять тысяч (Б2.10).
 *
 * Возвращает идентификатор, который потом кладётся в настройку соединения.
 */
async function startBatch(pool, { kind, title, fileName }) {
    const ctx = storage.getStore() || {};
    const created = await pool.query(
        `INSERT INTO audit_batches (id, kind, title, file_name, actor_employee_id, actor_kind, actor_name, page)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [kind, title || null, fileName || null,
            ctx.actorId || null, ctx.actorKind || 'none', ctx.actorName || null, ctx.page || null]
    );
    return created.rows[0].id;
}

/**
 * Выполняет работу под признаком партии и под служебным автором.
 *
 * Служебный автор здесь честнее человека: строки создаёт не он, а импорт. В
 * журнале так и будет написано — «Импорт», а не фамилия того, кто нажал.
 */
async function runAsBatch(pool, { kind, title, fileName, actorName }, fn) {
    const batchId = await startBatch(pool, { kind, title, fileName });
    const outer = storage.getStore() || {};
    const inner = {
        ...outer,
        actorId: null,
        actorKind: 'service',
        actorName: actorName || title || kind,
        batchId
    };
    return storage.run(inner, () => fn(batchId));
}

/** Работа от имени системы без партии: раздача, разовые пересчёты. */
function runAsService(name, fn) {
    const outer = storage.getStore() || {};
    return storage.run({ ...outer, actorId: null, actorKind: 'service', actorName: name, batchId: null }, fn);
}

/**
 * Промежуточный слой Express. Стоит ДО маршрутов и охватывает весь запрос
 * целиком — включая то, что маршрут делает после await.
 *
 * Контекст ставится на КАЖДЫЙ запрос, а не только на изменяющий. Отличить
 * чтение от записи по глаголу нельзя: `GET /api/leads/next` и
 * `GET /api/employees/:id/work-state` пишут в базу, и запись из них ушла бы
 * без автора.
 */
function middleware(pool) {
    return function auditContext(req, res, next) {
        const rawActor = String(req.headers[HEADER_ACTOR] || '').trim();
        const actorId = /^\d+$/.test(rawActor) ? Number(rawActor) : null;
        const page = String(req.headers[HEADER_PAGE] || '').trim().slice(0, 64) || null;
        const rawBatch = String(req.headers[HEADER_BATCH] || '').trim();
        const batchId = /^[0-9a-fA-F-]{36}$/.test(rawBatch) ? rawBatch : null;
        // Заголовок партии приезжает закодированным: в заголовке HTTP может
        // жить только латиница, а название массового действия — русский текст.
        const batchTitle = decodeTitle(req.headers[HEADER_BATCH_TITLE]);

        const ctx = {
            actorId,
            actorKind: actorId ? 'browser' : 'none',
            actorName: null,
            page,
            batchId
        };

        const start = () => storage.run(ctx, () => {
            // Партия, начатая браузером (массовые действия в таблицах, которые
            // клиент делает чередой обычных запросов): заводим строку партии
            // при первом же запросе с новым признаком.
            if (batchId) ensureBrowserBatch(pool, batchId, batchTitle, ctx).finally(next);
            else next();
        });

        if (actorId === null) return start();
        resolveActorName(pool, actorId).then((name) => { ctx.actorName = name; start(); });
    };
}

function decodeTitle(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    try {
        return decodeURIComponent(value).slice(0, 200);
    } catch (err) {
        // Прислали не то — партия останется без названия, но останется.
        return value.slice(0, 200);
    }
}

const seenBatches = new Set();

async function ensureBrowserBatch(pool, batchId, title, ctx) {
    if (seenBatches.has(batchId)) return;
    seenBatches.add(batchId);
    // Множество растёт только на массовых операциях и живёт до перезапуска —
    // за смену их единицы. Чистить нечего.
    try {
        await pool.query(
            `INSERT INTO audit_batches (id, kind, title, actor_employee_id, actor_kind, actor_name, page)
             VALUES ($1, 'browser', $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
            [batchId, title, ctx.actorId, ctx.actorKind, ctx.actorName, ctx.page]
        );
    } catch (err) {
        console.error('Аудит: не удалось завести партию', err.message);
    }
}

/**
 * Пометить признаком партии соединение, которое УЖЕ взято и в котором уже
 * открыта транзакция.
 *
 * Обычный путь — контекст запроса: настройки кладутся при взятии соединения из
 * пула (db.js). Массовая загрузка берёт соединение раньше, чем узнаёт, что
 * партия состоится: сначала проверки, потом BEGIN, и только потом становится
 * ясно, что грузить есть что. Разворачивать ради этого весь обработчик наизнанку
 * значит трогать работающую загрузку без нужды.
 *
 * Автор здесь СЛУЖЕБНЫЙ и это честнее человека: пять тысяч строк создаёт
 * импорт, а не тот, кто нажал кнопку. В журнале так и будет написано.
 */
async function markClientBatch(client, batchId, actorName) {
    await client.query(
        `SELECT set_config('crm.audit_batch', $1, false),
                set_config('crm.audit_actor_kind', 'service', false),
                set_config('crm.audit_actor_name', $2, false),
                set_config('crm.audit_actor_id', '', false)`,
        [String(batchId), actorName]
    );
}

/** Что положить в настройки соединения. Пустая строка = «нечего сказать». */
function currentSettings() {
    const ctx = storage.getStore();
    return [
        ctx && ctx.actorId ? String(ctx.actorId) : '',
        ctx && ctx.actorKind ? ctx.actorKind : 'none',
        ctx && ctx.actorName ? ctx.actorName : '',
        ctx && ctx.page ? ctx.page : '',
        ctx && ctx.batchId ? String(ctx.batchId) : ''
    ];
}

/**
 * Кто сейчас действует — для колонок автора В САМОЙ ЗАПИСИ, а не в журнале.
 *
 * Часть 4 завела такие колонки у вердикта разбора номера, часть 5 — у архива
 * лида, и обе берут автора отсюда, а не из заголовков запроса напрямую. Разница
 * существенная: здесь имя УЖЕ разрешено по базе (resolveActorName), то есть в
 * записи окажется настоящая фамилия по присланному номеру, а не то, что браузер
 * назвал именем. Читать заголовок в маршруте значило бы завести второй способ
 * узнать автора — и он разошёлся бы с журналом в первый же спорный случай.
 */
function currentActor() {
    const ctx = storage.getStore() || {};
    return {
        id: ctx.actorId || null,
        kind: ctx.actorKind || 'none',
        name: ctx.actorName || null
    };
}

module.exports = {
    middleware, currentSettings, startBatch, markClientBatch,
    runAsBatch, runAsService, currentActor, storage
};
