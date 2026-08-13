// --- routes/adPlatforms.js: CRUD для справочника "Площадки" (страница
// «Источники», report_2026-08-01.md, 11.08.2026) — упрощённая версия прежних
// "Рекламных площадок" (category/type убраны — заводились 06.08.2026 под
// другую версию сущности, сразу скрытую из UI; теперь площадка — родитель
// для sources, только Название+Статус). Паттерн 1:1 с routes/departments.js,
// без FK — самостоятельный справочник.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const STATUS_VALUES = ['Активна', 'Неактивна'];

const FIELD_COLUMNS = [
    ['name', 'name'],
    ['status', 'status']
];

function normalizeValue(key, value) {
    if (key === 'status') {
        return value === undefined || value === null || String(value).trim() === '' ? 'Активна' : value;
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

function rowToPlatform(row) {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        sourcesCount: row.sources_count === undefined ? null : Number(row.sources_count)
    };
}

function validateBody(body) {
    if (!body.name || String(body.name).trim() === '') {
        return 'Заполните обязательное поле: Наименование';
    }
    const status = body.status === undefined || body.status === null || String(body.status).trim() === '' ? 'Активна' : body.status;
    if (!STATUS_VALUES.includes(status)) {
        return `Статус должен быть одним из: ${STATUS_VALUES.join(', ')}`;
    }
    return null;
}

// GET /api/ad-platforms — список, отсортирован по id. sourcesCount — нужен
// фронту и для пилюли-счётчика на табе площадки, и чтобы заранее (до клика)
// знать, можно ли показывать кнопку удаления активной. (Раньше здесь стояла
// ссылка на assignedCount из routes/scriptsAdmin.js как на такой же паттерн —
// то поле удалено вместе с привязкой операторов к скриптам.)
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, (SELECT count(*)::int FROM sources s WHERE s.platform_id = p.id) AS sources_count
             FROM ad_platforms p
             ORDER BY p.id`
        );
        res.json(result.rows.map(rowToPlatform));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список площадок' });
    }
});

// POST /api/ad-platforms — создание
router.post('/', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO ad_platforms (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
            values
        );
        res.status(201).json(rowToPlatform(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать площадку' });
    }
});

// PUT /api/ad-platforms/:id
router.put('/:id', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE ad_platforms SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Площадка не найдена' });
        }
        res.json(rowToPlatform(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// DELETE /api/ad-platforms/:id — блокируется, пока у площадки есть источники
// (ON DELETE RESTRICT на sources.platform_id тоже это ловит, но голая ошибка
// Postgres — плохой UX, проверяем явно и отвечаем понятным 409).
router.delete('/:id', async (req, res) => {
    try {
        const sourcesCount = await pool.query('SELECT count(*)::int AS c FROM sources WHERE platform_id = $1', [req.params.id]);
        if (sourcesCount.rows[0].c > 0) {
            return res.status(409).json({ error: 'Нельзя удалить площадку, пока к ней привязаны источники' });
        }
        const result = await pool.query('DELETE FROM ad_platforms WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Площадка не найдена' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить площадку' });
    }
});

module.exports = router;
