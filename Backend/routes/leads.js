// --- routes/leads.js: карточка клиента (лид) для страницы оператора ---
// Видимость строго личная: employeeId передаётся клиентом (нет серверной сессии,
// тот же принцип, что уже принят в проекте) — GET/PUT по :id проверяют, что
// leads.employee_id совпадает с переданным employeeId, и отвечают 403 иначе.
// Это не полноценная защита (клиент технически может передать чужой employeeId),
// но страхует от случайных ошибок — по решению куратора (2026-08-05).

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Порядок должен совпадать со списком колонок в UPDATE ниже. "source" сюда
// намеренно не входит (report_2026-08-01.md, 09.08.2026) — форма оператора
// его больше не показывает (design-решение, риск случайной перезаписи), а
// раз поля нет в форме, PUT присылал бы undefined → normalizeValue превращал
// бы это в null и тихо обнулял source при каждом сохранении карточки — тот
// же баг, что чинили для offerId, только обнаружился по факту удаления поля
// из этой задачи, а не был описан в брифе отдельно.
const EDITABLE_FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['phone', 'phone'],
    ['funnelStatusId', 'funnel_status_id'],
    ['decisionMaker', 'decision_maker'],
    ['clientType', 'client_type'],
    ['otherBorrower', 'other_borrower'],
    ['category', 'category'],
    ['propertyType', 'property_type'],
    ['propertyClass', 'property_class'],
    ['roomCount', 'room_count'],
    ['finish', 'finish'],
    ['priceFrom', 'price_from'],
    ['priceTo', 'price_to'],
    ['areaFrom', 'area_from'],
    ['areaTo', 'area_to'],
    ['deliveryDeadline', 'delivery_deadline'],
    ['region', 'region'],
    ['city', 'city'],
    ['district', 'district'],
    ['locality', 'locality'],
    ['clientRegion', 'client_region'],
    ['clientCity', 'client_city'],
    ['clientDistrict', 'client_district'],
    ['clientLocality', 'client_locality'],
    ['purchaseMethod', 'purchase_method'],
    ['mortgageType', 'mortgage_type'],
    ['downPaymentPercent', 'down_payment_percent'],
    ['purchaseTimeframe', 'purchase_timeframe'],
    ['notes', 'notes']
];

const NUMERIC_FIELDS = new Set(['funnelStatusId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

// «Иной заёмщик» — ТРИ состояния, поэтому отдельно от остальных полей
// (dialog.md H2): null — условие показа не выполнено, поле неприменимо;
// true/false — оператор ответил. Обычная нормализация тут не годится: она
// превращает пустую строку в null (это верно), но строку 'false' из формы
// пропустила бы как непустое значение, и в булеву колонку легло бы true.
const BOOLEAN_FIELDS = new Set(['otherBorrower']);

function rowToLead(row) {
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        phone: row.phone,
        // source и offerId убраны 13.08.2026: обе колонки в leads больше не
        // существуют (source заменён на source_id ещё задачей «Лиды»,
        // offer_id заменён связкой lead_offers этой задачей), поэтому оба
        // поля всегда отдавали undefined. Форма оператора их не показывает и
        // не редактирует — EDITABLE_FIELD_COLUMNS их не содержит.
        employeeId: row.employee_id,
        funnelStatusId: row.funnel_status_id,
        // sourceName приходит только из запроса одной карточки (там есть JOIN);
        // в списке лидов колонки нет, и поле честно остаётся undefined.
        sourceName: row.source_name,
        decisionMaker: row.decision_maker,
        clientType: row.client_type,
        otherBorrower: row.other_borrower,
        category: row.category,
        propertyType: row.property_type,
        propertyClass: row.property_class,
        roomCount: row.room_count,
        finish: row.finish,
        priceFrom: row.price_from,
        priceTo: row.price_to,
        areaFrom: row.area_from,
        areaTo: row.area_to,
        deliveryDeadline: row.delivery_deadline,
        region: row.region,
        city: row.city,
        district: row.district,
        locality: row.locality,
        clientRegion: row.client_region,
        clientCity: row.client_city,
        clientDistrict: row.client_district,
        clientLocality: row.client_locality,
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
    if (BOOLEAN_FIELDS.has(key)) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return null; // undefined, null, '' — «неприменимо»
    }
    if (NUMERIC_FIELDS.has(key)) {
        return value === '' || value === undefined || value === null ? null : Number(value);
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

// Источник лида для шапки карточки — «Площадка · Корневой источник»
// (формат из макета, dialog.md D1). Собирается на сервере, а не на клиенте:
// иначе странице оператора пришлось бы тянуть весь справочник источников ради
// одной подписи. Только чтение — в EDITABLE_FIELD_COLUMNS поля нет: форма его
// не показывает как поле, а PUT прислал бы undefined и обнулил source_id.
const LEAD_CARD_SELECT = `
    SELECT l.*,
           CASE
               WHEN s.id IS NULL THEN NULL
               ELSE COALESCE(p.name || ' · ', '') || s.root_source
           END AS source_name
    FROM leads l
    LEFT JOIN sources s ON s.id = l.source_id
    LEFT JOIN ad_platforms p ON p.id = s.platform_id
`;

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
        const result = await pool.query(`${LEAD_CARD_SELECT} WHERE l.id = $1`, [req.params.id]);
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
        await pool.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
            values
        );
        // Перечитываем тем же запросом, что и GET: RETURNING * не знает про
        // JOIN, и ответ на сохранение приходил бы без source_name — форма
        // обновляет по нему шапку и «Последнее сохранение».
        const result = await pool.query(`${LEAD_CARD_SELECT} WHERE l.id = $1`, [req.params.id]);
        res.json(rowToLead(result.rows[0]));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указан несуществующий статус воронки' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить лида' });
    }
});

module.exports = router;
