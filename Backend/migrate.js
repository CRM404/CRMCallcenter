// --- migrate.js: автоматическое накатывание схемы БД при старте сервера ---

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function runMigrations() {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
}

module.exports = { runMigrations };
