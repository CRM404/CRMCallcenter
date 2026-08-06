// --- routes/adPlatforms.js: CRUD для справочника "Рекламные площадки"
// (report_2026-08-01.md) — паттерн 1:1 с routes/departments.js, но без FK
// вообще (самостоятельный справочник, решение куратора: без связи с оффером).

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const FIELD_COLUMNS = [
    ['name', 'name'],
    ['category', 'category'],
    ['type', 'type'],
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
        category: row.category,
        type: row.type,
        status: row.status
    };
}

function validateBody(body) {
    if (!body.name || String(body.name).trim() === '') {
        return 'Заполните обязательное поле: Наименование';
    }
    return null;
}

// GET /api/ad-platforms — список, отсортирован по id
router.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ad_platforms ORDER BY id');
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

// DELETE /api/ad-platforms/:id
router.delete('/:id', async (req, res) => {
    try {
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
