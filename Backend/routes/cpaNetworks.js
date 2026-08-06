// --- routes/cpaNetworks.js: CRUD для справочника CPA-сетей (партнёров, которым
// организация передаёт лиды дальше) — обычный список записей, как employees.js,
// не singleton, как organization.js.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const STATUS_VALUES = ['Активна', 'Приостановлена', 'Отключена'];

const FIELD_COLUMNS = [
    ['organizationId', 'organization_id'],
    ['name', 'name'],
    ['status', 'status'],
    ['connectedAt', 'connected_at'],
    ['payoutCurrency', 'payout_currency'],
    ['commissionPercent', 'commission_percent']
];

function normalizeValue(key, value) {
    if (key === 'status') {
        return value === undefined || value === null || String(value).trim() === '' ? 'Активна' : value;
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

function rowToCpaNetwork(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name || null,
        name: row.name,
        status: row.status,
        connectedAt: row.connected_at,
        payoutCurrency: row.payout_currency,
        commissionPercent: row.commission_percent
    };
}

async function fetchCpaNetworkWithOrganization(id) {
    const result = await pool.query(
        `SELECT c.*, o.name AS organization_name
         FROM cpa_networks c
         LEFT JOIN organizations o ON o.id = c.organization_id
         WHERE c.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

function validateRequiredFields(body) {
    if (!body.name || String(body.name).trim() === '') {
        return 'Заполните обязательное поле: Название';
    }
    if (body.organizationId === undefined || body.organizationId === null || String(body.organizationId).trim() === '') {
        return 'Заполните обязательное поле: Юрлицо';
    }
    return null;
}

function validateStatus(status) {
    const value = status === undefined || status === null || String(status).trim() === '' ? 'Активна' : status;
    if (!STATUS_VALUES.includes(value)) {
        return `Статус должен быть одним из: ${STATUS_VALUES.join(', ')}`;
    }
    return null;
}

function validateCommissionPercent(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
        return 'Комиссия должна быть числом от 0 до 100';
    }
    return null;
}

function validateBody(body) {
    return validateRequiredFields(body) || validateStatus(body.status) || validateCommissionPercent(body.commissionPercent);
}

// GET /api/cpa-networks — список, отсортирован по id
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.*, o.name AS organization_name
             FROM cpa_networks c
             LEFT JOIN organizations o ON o.id = c.organization_id
             ORDER BY c.id`
        );
        res.json(result.rows.map(rowToCpaNetwork));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список CPA-сетей' });
    }
});

// POST /api/cpa-networks — создание
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
            `INSERT INTO cpa_networks (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const row = await fetchCpaNetworkWithOrganization(result.rows[0].id);
        res.status(201).json(rowToCpaNetwork(row));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указанная организация не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать CPA-сеть' });
    }
});

// PUT /api/cpa-networks/:id — полная замена (непереданное поле становится NULL,
// кроме обязательных)
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
            `UPDATE cpa_networks SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'CPA-сеть не найдена' });
        }
        const row = await fetchCpaNetworkWithOrganization(result.rows[0].id);
        res.json(rowToCpaNetwork(row));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указанная организация не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// DELETE /api/cpa-networks/:id
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM cpa_networks WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'CPA-сеть не найдена' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить CPA-сеть' });
    }
});

module.exports = router;
