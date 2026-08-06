// --- routes/departments.js: CRUD для справочника "Отделы" (report_2026-08-01.md,
// п.1) — обычный список записей, паттерн 1:1 с routes/cpaNetworks.js.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const FIELD_COLUMNS = [
    ['organizationId', 'organization_id'],
    ['name', 'name']
];

function normalizeValue(value) {
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

function rowToDepartment(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name || null,
        name: row.name
    };
}

async function fetchDepartmentWithOrganization(id) {
    const result = await pool.query(
        `SELECT d.*, o.name AS organization_name
         FROM departments d
         LEFT JOIN organizations o ON o.id = d.organization_id
         WHERE d.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

function validateBody(body) {
    if (!body.name || String(body.name).trim() === '') {
        return 'Заполните обязательное поле: Название';
    }
    if (body.organizationId === undefined || body.organizationId === null || String(body.organizationId).trim() === '') {
        return 'Заполните обязательное поле: Юрлицо';
    }
    return null;
}

// GET /api/departments — список, отсортирован по id
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT d.*, o.name AS organization_name
             FROM departments d
             LEFT JOIN organizations o ON o.id = d.organization_id
             ORDER BY d.id`
        );
        res.json(result.rows.map(rowToDepartment));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список отделов' });
    }
});

// POST /api/departments — создание
router.post('/', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO departments (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const row = await fetchDepartmentWithOrganization(result.rows[0].id);
        res.status(201).json(rowToDepartment(row));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указанная организация не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать отдел' });
    }
});

// PUT /api/departments/:id
router.put('/:id', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE departments SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Отдел не найден' });
        }
        const row = await fetchDepartmentWithOrganization(result.rows[0].id);
        res.json(rowToDepartment(row));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указанная организация не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// DELETE /api/departments/:id
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM departments WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Отдел не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить отдел' });
    }
});

module.exports = router;
