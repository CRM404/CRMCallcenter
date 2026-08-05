// --- routes/leads.js: карточка клиента (лид) для страницы оператора ---
// Видимость строго личная: employeeId передаётся клиентом (нет серверной сессии,
// тот же принцип, что уже принят в проекте) — GET/PUT по :id проверяют, что
// leads.employee_id совпадает с переданным employeeId, и отвечают 403 иначе.
// Это не полноценная защита (клиент технически может передать чужой employeeId),
// но страхует от случайных ошибок — по решению куратора (2026-08-05).

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Порядок должен совпадать со списком колонок в UPDATE ниже.
const EDITABLE_FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['phone', 'phone'],
    ['source', 'source'],
    ['funnelStatusId', 'funnel_status_id'],
    ['offerId', 'offer_id'],
    ['propertyType', 'property_type'],
    ['propertyClass', 'property_class'],
    ['roomCount', 'room_count'],
    ['priceFrom', 'price_from'],
    ['priceTo', 'price_to'],
    ['areaFrom', 'area_from'],
    ['areaTo', 'area_to'],
    ['deliveryDeadline', 'delivery_deadline'],
    ['region', 'region'],
    ['city', 'city'],
    ['district', 'district'],
    ['locality', 'locality'],
    ['purchaseMethod', 'purchase_method'],
    ['mortgageType', 'mortgage_type'],
    ['downPaymentPercent', 'down_payment_percent'],
    ['purchaseTimeframe', 'purchase_timeframe'],
    ['notes', 'notes']
];

const NUMERIC_FIELDS = new Set(['funnelStatusId', 'offerId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

function rowToLead(row) {
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        phone: row.phone,
        source: row.source,
        employeeId: row.employee_id,
        funnelStatusId: row.funnel_status_id,
        offerId: row.offer_id,
        propertyType: row.property_type,
        propertyClass: row.property_class,
        roomCount: row.room_count,
        priceFrom: row.price_from,
        priceTo: row.price_to,
        areaFrom: row.area_from,
        areaTo: row.area_to,
        deliveryDeadline: row.delivery_deadline,
        region: row.region,
        city: row.city,
        district: row.district,
        locality: row.locality,
        purchaseMethod: row.purchase_method,
        mortgageType: row.mortgage_type,
        downPaymentPercent: row.down_payment_percent,
        purchaseTimeframe: row.purchase_timeframe,
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function normalizeValue(key, value) {
    if (NUMERIC_FIELDS.has(key)) {
        return value === '' || value === undefined || value === null ? null : Number(value);
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

// GET /api/leads?employeeId=... — список своих лидов, новые сверху
router.get('/', async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        const result = await pool.query(
            'SELECT * FROM leads WHERE employee_id = $1 ORDER BY created_at DESC',
            [employeeId]
        );
        res.json(result.rows.map(rowToLead));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список лидов' });
    }
});

// GET /api/leads/:id?employeeId=... — одна карточка (только своя)
router.get('/:id', async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        const result = await pool.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const lead = result.rows[0];
        if (String(lead.employee_id) !== String(employeeId)) {
            return res.status(403).json({ error: 'Этот лид назначен другому оператору' });
        }
        res.json(rowToLead(lead));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить лида' });
    }
});

// PUT /api/leads/:id — сохранение карточки (employeeId в теле запроса, только свой лид)
router.put('/:id', async (req, res) => {
    try {
        const { employeeId } = req.body;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }

        const existing = await pool.query('SELECT employee_id FROM leads WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        if (String(existing.rows[0].employee_id) !== String(employeeId)) {
            return res.status(403).json({ error: 'Этот лид назначен другому оператору' });
        }

        const values = EDITABLE_FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = EDITABLE_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
            values
        );
        res.json(rowToLead(result.rows[0]));
    } catch (err) {
        if (err.code === '23503') {
            if (err.constraint === 'leads_offer_id_fkey') {
                return res.status(400).json({ error: 'Указан несуществующий оффер' });
            }
            return res.status(400).json({ error: 'Указан несуществующий статус воронки' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить лида' });
    }
});

module.exports = router;
