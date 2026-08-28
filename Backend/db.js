// --- db.js: пул подключений к PostgreSQL ---

const { Pool, types } = require('pg');

// DATE (OID 1082) как строка 'YYYY-MM-DD' без временной зоны — иначе pg отдаёт JS Date
// и <input type="date"> на фронте может сместиться на день из-за локального часового пояса.
types.setTypeParser(1082, val => val);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL не задана (см. .env.example)');
}

// Railway internal/public адреса обычно не требуют SSL для сервис-сервис соединений;
// для локальной разработки SSL тоже не нужен. Включаем SSL только если явно попросили через PGSSL=require.
const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
});

// --- Настройки соединения для аудита ---------------------------------------
//
// Триггер журнала не знает ни про запросы, ни про браузер: единственное, что он
// умеет читать, — настройки соединения. Класть их надо на ТО ЖЕ соединение, на
// котором пойдёт запрос, а pool.query() берёт из пула любое свободное. Отсюда
// правило: соединение сначала берётся, потом настраивается, и только потом на
// нём работают.
//
// ЗАЧЕМ СТАВИТЬ ДАЖЕ ПУСТЫЕ ЗНАЧЕНИЯ. Настройка уровня сеанса переживает
// освобождение соединения и достаётся следующему, кто его возьмёт. Пропустив
// установку там, где контекста нет (фоновая работа, миграция при старте), мы
// приписали бы её записи автора из чужого, уже закончившегося запроса. Поэтому
// установка безусловная: нет контекста — кладём пустое.
//
// Цена — один лишний обход до базы на каждое взятие соединения. Обойтись
// транзакцией с SET LOCAL нельзя: тогда каждый одиночный запрос проекта стал бы
// транзакцией, а это уже другое поведение, а не другая цена.
const { currentSettings } = require('./services/auditContext');

const APPLY_SETTINGS = `SELECT set_config('crm.audit_actor_id', $1, false),
                               set_config('crm.audit_actor_kind', $2, false),
                               set_config('crm.audit_actor_name', $3, false),
                               set_config('crm.audit_page', $4, false),
                               set_config('crm.audit_batch', $5, false)`;

const poolConnect = pool.connect.bind(pool);

pool.connect = async function connectWithAuditContext() {
    const client = await poolConnect();
    try {
        await client.query(APPLY_SETTINGS, currentSettings());
    } catch (err) {
        client.release();
        throw err;
    }
    return client;
};

// pool.query переписан ЧЕРЕЗ pool.connect, а не рядом с ним: иначе настройки
// пришлось бы ставить в двух местах и однажды разойтись.
pool.query = async function queryWithAuditContext(...args) {
    const client = await pool.connect();
    try {
        return await client.query(...args);
    } finally {
        client.release();
    }
};

/**
 * Переставить контекст аудита на УЖЕ ВЗЯТОМ соединении.
 *
 * ⚠ ЛОВУШКА, РАДИ КОТОРОЙ ЭТО ЭКСПОРТИРУЕТСЯ. `runAsService` меняет контекст
 * в памяти процесса, а триггер читает НАСТРОЙКИ СОЕДИНЕНИЯ — и кладутся они
 * один раз, при взятии соединения из пула. Значит внутри транзакции, где
 * соединение взято заранее, смена автора сама по себе ничего не меняет: запись
 * уйдёт в журнал под тем же автором, что и весь запрос.
 *
 * Заметить это чтением нельзя — код выглядит правильным. Поймано набором захода
 * 6: закрытие карточки по времени подписывалось оператором вместо системы.
 *
 * Вызывать ВНУТРИ нужного контекста, а после — ещё раз, чтобы вернуть прежнего
 * автора: настройка живёт до конца сеанса, а соединение вернётся в пул.
 */
async function applyAuditSettings(client) {
    await client.query(APPLY_SETTINGS, currentSettings());
}

module.exports = { pool, applyAuditSettings };
