// --- routes/realEstateOffers.js: CRUD для офферов недвижимости
// (report_2026-08-01.md, 07.08.2026) — паттерн 1:1 с routes/cpaNetworks.js
// для основных полей + пересборка вложенных сегментов/географии целиком
// (delete+insert в транзакции) при каждом POST/PUT, т.к. фронт держит эти
// списки как единый массив в форме, без отдельных CRUD-ручек на строку.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const STATUS_VALUES = ['active', 'paused', 'disabled', 'draft'];

const FIELD_COLUMNS = [
    ['networkId', 'network_id'],
    ['name', 'name'],
    ['category', 'category'],
    ['status', 'status'],
    ['dateStart', 'date_start'],
    ['dateEnd', 'date_end'],
    ['actionType', 'action_type'],
    ['rate', 'rate'],
    ['holdDays', 'hold_days'],
    ['leadCheck', 'lead_check'],
    ['targetCriteria', 'target_criteria'],
    ['nonTargetCriteria', 'non_target_criteria'],
    ['developer', 'developer'],
    ['deadline', 'deadline'],
    ['otherBorrower', 'other_borrower'],
    ['purchaseTerm', 'purchase_term'],
    ['downPaymentPercent', 'down_payment_percent'],
    ['priority', 'priority'],
    ['transferTime', 'transfer_time'],
    ['leadLimit', 'lead_limit']
];

const ARRAY_COLUMNS = [
    ['objTypes', 'obj_types'],
    ['finishes', 'finishes'],
    ['clientTypes', 'client_types']
];

function normalizeValue(key, value) {
    if (key === 'status') {
        return value === undefined || value === null || String(value).trim() === '' ? 'draft' : value;
    }
    // Трёхзначное поле: null означает "неприменимо" («Пенсионер» не выбран
    // среди типов клиента) — не приводить к false, иначе теряется разница
    // между "неприменимо" и "выбран, но чекбокс снят".
    if (key === 'otherBorrower') {
        if (value === null || value === undefined) return null;
        return value === true || value === 'true';
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
}

function validateBody(body) {
    if (!body.name || String(body.name).trim() === '') {
        return 'Заполните обязательное поле: Название';
    }
    if (body.networkId === undefined || body.networkId === null || String(body.networkId).trim() === '') {
        return 'Заполните обязательное поле: Сеть';
    }
    const status = normalizeValue('status', body.status);
    if (!STATUS_VALUES.includes(status)) {
        return `Статус должен быть одним из: ${STATUS_VALUES.join(', ')}`;
    }
    return null;
}

function groupBy(rows, key) {
    return rows.reduce((acc, row) => {
        (acc[row[key]] = acc[row[key]] || []).push(row);
        return acc;
    }, {});
}

function rowToSegment(row) {
    return {
        id: row.id,
        label: row.label,
        objectClass: row.object_class,
        roomCount: row.room_count,
        priceMin: row.price_min,
        priceMax: row.price_max,
        areaMin: row.area_min,
        areaMax: row.area_max
    };
}

function rowToGeo(row) {
    return {
        id: row.id,
        region: row.region,
        city: row.city,
        district: row.district,
        locality: row.locality
    };
}

function rowToOffer(row, segments, objGeo, clientGeo, paymentMethods, mortgageTypes) {
    return {
        id: row.id,
        networkId: row.network_id,
        name: row.name,
        category: row.category,
        status: row.status,
        dateStart: row.date_start,
        dateEnd: row.date_end,
        actionType: row.action_type,
        rate: row.rate,
        holdDays: row.hold_days,
        leadCheck: row.lead_check,
        targetCriteria: row.target_criteria,
        nonTargetCriteria: row.non_target_criteria,
        objTypes: row.obj_types || [],
        finishes: row.finishes || [],
        developer: row.developer,
        deadline: row.deadline,
        clientTypes: row.client_types || [],
        otherBorrower: row.other_borrower,
        purchaseTerm: row.purchase_term,
        downPaymentPercent: row.down_payment_percent,
        priority: row.priority,
        transferTime: row.transfer_time,
        leadLimit: row.lead_limit,
        segments: (segments || []).map(rowToSegment),
        objGeo: (objGeo || []).map(rowToGeo),
        clientGeo: (clientGeo || []).map(rowToGeo),
        paymentMethods: (paymentMethods || []).map((r) => r.value),
        mortgageTypes: (mortgageTypes || []).map((r) => r.value)
    };
}

async function fetchOfferFull(id) {
    const offerResult = await pool.query('SELECT * FROM real_estate_offers WHERE id = $1', [id]);
    if (offerResult.rows.length === 0) return null;
    const [segmentsResult, objGeoResult, clientGeoResult, paymentMethodsResult, mortgageTypesResult] = await Promise.all([
        pool.query('SELECT * FROM real_estate_offer_segments WHERE offer_id = $1 ORDER BY id', [id]),
        pool.query("SELECT * FROM real_estate_offer_geo WHERE offer_id = $1 AND kind = 'object' ORDER BY id", [id]),
        pool.query("SELECT * FROM real_estate_offer_geo WHERE offer_id = $1 AND kind = 'client' ORDER BY id", [id]),
        pool.query('SELECT * FROM real_estate_offer_payment_methods WHERE offer_id = $1 ORDER BY id', [id]),
        pool.query('SELECT * FROM real_estate_offer_mortgage_types WHERE offer_id = $1 ORDER BY id', [id])
    ]);
    return rowToOffer(offerResult.rows[0], segmentsResult.rows, objGeoResult.rows, clientGeoResult.rows, paymentMethodsResult.rows, mortgageTypesResult.rows);
}

async function replaceSegments(client, offerId, segments) {
    await client.query('DELETE FROM real_estate_offer_segments WHERE offer_id = $1', [offerId]);
    for (const s of normalizeArray(segments)) {
        await client.query(
            `INSERT INTO real_estate_offer_segments (offer_id, label, object_class, room_count, price_min, price_max, area_min, area_max)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                offerId,
                normalizeValue('label', s.label),
                normalizeValue('objectClass', s.objectClass),
                normalizeValue('roomCount', s.roomCount),
                normalizeValue('priceMin', s.priceMin),
                normalizeValue('priceMax', s.priceMax),
                normalizeValue('areaMin', s.areaMin),
                normalizeValue('areaMax', s.areaMax)
            ]
        );
    }
}

async function replaceGeo(client, offerId, kind, rows) {
    await client.query('DELETE FROM real_estate_offer_geo WHERE offer_id = $1 AND kind = $2', [offerId, kind]);
    for (const r of normalizeArray(rows)) {
        await client.query(
            `INSERT INTO real_estate_offer_geo (offer_id, kind, region, city, district, locality)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                offerId,
                kind,
                normalizeValue('region', r.region),
                normalizeValue('city', r.city),
                normalizeValue('district', r.district),
                normalizeValue('locality', r.locality)
            ]
        );
    }
}

async function replacePaymentMethods(client, offerId, values) {
    await client.query('DELETE FROM real_estate_offer_payment_methods WHERE offer_id = $1', [offerId]);
    for (const value of normalizeArray(values)) {
        await client.query(
            'INSERT INTO real_estate_offer_payment_methods (offer_id, value) VALUES ($1, $2)',
            [offerId, value]
        );
    }
}

async function replaceMortgageTypes(client, offerId, values) {
    await client.query('DELETE FROM real_estate_offer_mortgage_types WHERE offer_id = $1', [offerId]);
    for (const value of normalizeArray(values)) {
        await client.query(
            'INSERT INTO real_estate_offer_mortgage_types (offer_id, value) VALUES ($1, $2)',
            [offerId, value]
        );
    }
}

// GET /api/real-estate-offers?networkId= — список (все сети, если не передан
// networkId), с вложенными segments/objGeo/clientGeo на каждый оффер.
router.get('/', async (req, res) => {
    try {
        const { networkId } = req.query;
        const offersResult = networkId
            ? await pool.query('SELECT * FROM real_estate_offers WHERE network_id = $1 ORDER BY id', [networkId])
            : await pool.query('SELECT * FROM real_estate_offers ORDER BY id');
        const offers = offersResult.rows;
        if (offers.length === 0) return res.json([]);

        const ids = offers.map((o) => o.id);
        const [segmentsResult, geoResult, paymentMethodsResult, mortgageTypesResult] = await Promise.all([
            pool.query('SELECT * FROM real_estate_offer_segments WHERE offer_id = ANY($1) ORDER BY id', [ids]),
            pool.query('SELECT * FROM real_estate_offer_geo WHERE offer_id = ANY($1) ORDER BY id', [ids]),
            pool.query('SELECT * FROM real_estate_offer_payment_methods WHERE offer_id = ANY($1) ORDER BY id', [ids]),
            pool.query('SELECT * FROM real_estate_offer_mortgage_types WHERE offer_id = ANY($1) ORDER BY id', [ids])
        ]);
        const segmentsByOffer = groupBy(segmentsResult.rows, 'offer_id');
        const objGeoByOffer = groupBy(geoResult.rows.filter((r) => r.kind === 'object'), 'offer_id');
        const clientGeoByOffer = groupBy(geoResult.rows.filter((r) => r.kind === 'client'), 'offer_id');
        const paymentMethodsByOffer = groupBy(paymentMethodsResult.rows, 'offer_id');
        const mortgageTypesByOffer = groupBy(mortgageTypesResult.rows, 'offer_id');

        res.json(offers.map((o) => rowToOffer(
            o, segmentsByOffer[o.id], objGeoByOffer[o.id], clientGeoByOffer[o.id],
            paymentMethodsByOffer[o.id], mortgageTypesByOffer[o.id]
        )));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список офферов' });
    }
});

// POST /api/real-estate-offers — создание оффера + вложенных сегментов/географии
router.post('/', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        const arrayColumns = ARRAY_COLUMNS.map(([, col]) => col);
        const arrayValues = ARRAY_COLUMNS.map(([key]) => normalizeArray(req.body[key]));
        const allColumns = [...columns, ...arrayColumns];
        const allValues = [...values, ...arrayValues];
        const placeholders = allColumns.map((_, i) => `$${i + 1}`);

        const insertResult = await client.query(
            `INSERT INTO real_estate_offers (${allColumns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            allValues
        );
        const offerId = insertResult.rows[0].id;
        await replaceSegments(client, offerId, req.body.segments);
        await replaceGeo(client, offerId, 'object', req.body.objGeo);
        await replaceGeo(client, offerId, 'client', req.body.clientGeo);
        await replacePaymentMethods(client, offerId, req.body.paymentMethods);
        await replaceMortgageTypes(client, offerId, req.body.mortgageTypes);
        await client.query('COMMIT');

        res.status(201).json(await fetchOfferFull(offerId));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указанная сеть не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать оффер' });
    } finally {
        client.release();
    }
});

// PUT /api/real-estate-offers/:id — полное обновление оффера + пересборка
// сегментов/географии
router.put('/:id', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        const arrayColumns = ARRAY_COLUMNS.map(([, col]) => col);
        const arrayValues = ARRAY_COLUMNS.map(([key]) => normalizeArray(req.body[key]));
        const arraySetClauses = arrayColumns.map((col, i) => `${col} = $${values.length + i + 1}`);
        const allValues = [...values, ...arrayValues];
        allValues.push(req.params.id);

        const result = await client.query(
            `UPDATE real_estate_offers SET ${[...setClauses, ...arraySetClauses].join(', ')} WHERE id = $${allValues.length} RETURNING id`,
            allValues
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Оффер не найден' });
        }
        const offerId = result.rows[0].id;
        await replaceSegments(client, offerId, req.body.segments);
        await replaceGeo(client, offerId, 'object', req.body.objGeo);
        await replaceGeo(client, offerId, 'client', req.body.clientGeo);
        await replacePaymentMethods(client, offerId, req.body.paymentMethods);
        await replaceMortgageTypes(client, offerId, req.body.mortgageTypes);
        await client.query('COMMIT');

        res.json(await fetchOfferFull(offerId));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указанная сеть не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    } finally {
        client.release();
    }
});

// DELETE /api/real-estate-offers/:id — сегменты/география чистятся каскадом
// (ON DELETE CASCADE), отдельный код не нужен.
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM real_estate_offers WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Оффер не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить оффер' });
    }
});

module.exports = router;
