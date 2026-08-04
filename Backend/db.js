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

module.exports = { pool };
