// --- routes/realEstateOffers.js: CRUD для офферов недвижимости
// (report_2026-08-01.md, 07.08.2026) — паттерн 1:1 с routes/cpaNetworks.js
// для основных полей + пересборка вложенных сегментов/географии целиком
// (delete+insert в транзакции) при каждом POST/PUT, т.к. фронт держит эти
// списки как единый массив в форме, без отдельных CRUD-ручек на строку.

const express = require('express');
const { pool } = require('../db');
const { MAX_OFFERS_PER_LEAD, TOO_MANY_OFFERS_HINT } = require('../services/leadOfferLimits');

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

// ============================================================
// Серверный поиск офферов для страницы «Лиды» (13.08.2026).
// Офферов в базе ≈38 000 — фронт «Лидов» не грузит справочник целиком
// никогда, только эти три лёгких эндпоинта. GET / выше не тронут: им живёт
// страница CPA-сетей, там нужны вложенные segments/geo.
//
// Маппинг фильтров на схему (решение куратора): «Корневой источник»,
// «Площадка» и «Регион/город» — это колонки sources (root_source,
// platform_id -> ad_platforms.name, city_region). К офферу они цепляются
// через его сеть: real_estate_offers.network_id -> source_cpa_networks ->
// sources. Оффер проходит фильтр, если у его сети есть ХОТЯ БЫ ОДИН источник,
// удовлетворяющий ВСЕМ выбранным условиям сразу (один EXISTS со всеми
// условиями, dialog.md D1) — иначе подстрока строки результата, которая
// берётся с одного конкретного источника, противоречила бы фильтру.
// ============================================================

const SEARCH_DEFAULT_LIMIT = 50;
// Потолок совпадает с максимумом офферов на лида: после «Добавить все» фронту
// нужны НАЗВАНИЯ всего отбора, чтобы показать выбранное тегами (search-ids по
// контракту отдаёт только id). Больше этого числа офферов на лида всё равно
// не сохранить, поэтому и запрашивать больше незачем.
const SEARCH_MAX_LIMIT = MAX_OFFERS_PER_LEAD;

// Подстрока «площадка · корневой источник · город, регион» — от первого по id
// источника сети оффера. Нет источников — прочерк (LEFT JOIN LATERAL).
const SEARCH_FROM = `
    FROM real_estate_offers o
    LEFT JOIN LATERAL (
        SELECT s.root_source, s.city_region, p.name AS platform_name
        FROM source_cpa_networks scn
        JOIN sources s ON s.id = scn.source_id
        LEFT JOIN ad_platforms p ON p.id = s.platform_id
        WHERE scn.cpa_network_id = o.network_id
        ORDER BY s.id
        LIMIT 1
    ) src ON true
`;

function buildSearchWhere(query) {
    const { search, rootSource, platformId, cityRegion } = query;
    const conditions = [];
    const params = [];

    if (search && String(search).trim()) {
        params.push(`%${String(search).trim()}%`);
        conditions.push(`o.name ILIKE $${params.length}`);
    }

    const sourceConditions = [];
    if (rootSource && String(rootSource).trim()) {
        params.push(String(rootSource).trim());
        sourceConditions.push(`s.root_source = $${params.length}`);
    }
    if (platformId && String(platformId).trim()) {
        params.push(Number(platformId));
        sourceConditions.push(`s.platform_id = $${params.length}`);
    }
    if (cityRegion && String(cityRegion).trim()) {
        params.push(String(cityRegion).trim());
        sourceConditions.push(`s.city_region = $${params.length}`);
    }
    // Ни один фильтр не выбран — EXISTS не добавляем вовсе, иначе из выдачи
    // молча выпали бы офферы сетей, у которых источников пока нет.
    if (sourceConditions.length > 0) {
        conditions.push(`EXISTS (
            SELECT 1 FROM source_cpa_networks scn
            JOIN sources s ON s.id = scn.source_id
            WHERE scn.cpa_network_id = o.network_id AND ${sourceConditions.join(' AND ')}
        )`);
    }

    return {
        whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

// GET /api/real-estate-offers/search?search=&rootSource=&platformId=&cityRegion=&limit=
// Плоские строки + общий счётчик отбора для шапки «Найдено: N».
router.get('/search', async (req, res) => {
    try {
        const { whereClause, params } = buildSearchWhere(req.query);

        const requestedLimit = Number(req.query.limit);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, SEARCH_MAX_LIMIT)
            : SEARCH_DEFAULT_LIMIT;
        params.push(limit);

        // count(*) OVER () считается до LIMIT — общий размер отбора известен
        // из того же запроса, второй COUNT не нужен.
        const result = await pool.query(
            `SELECT o.id, o.name, src.platform_name, src.root_source, src.city_region,
                    count(*) OVER ()::int AS total
             ${SEARCH_FROM}
             ${whereClause}
             ORDER BY o.name, o.id
             LIMIT $${params.length}`,
            params
        );

        res.json({
            total: result.rows[0] ? result.rows[0].total : 0,
            // Лимит отдаётся вместе с выдачей, а не хардкодится во фронте:
            // бандлера в проекте нет, require серверного модуля из браузера
            // невозможен, а разъехавшиеся числа дали бы кнопку «Добавить все»,
            // предлагающую действие, которое сервер обязан отбить.
            maxPerLead: MAX_OFFERS_PER_LEAD,
            items: result.rows.map((r) => ({
                id: r.id,
                name: r.name,
                platform: r.platform_name,
                rootSource: r.root_source,
                cityRegion: r.city_region
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось выполнить поиск офферов' });
    }
});

// GET /api/real-estate-offers/search-ids — те же параметры, только id всего
// отбора: транспорт кнопки «Добавить все (N)». Фронт видит первые строки, но
// выбирает весь отбор и отправляет id обычным offerIds при сохранении лида —
// отдельной серверной записи «критериев отбора» не заводим.
router.get('/search-ids', async (req, res) => {
    try {
        const { whereClause, params } = buildSearchWhere(req.query);
        const result = await pool.query(
            `SELECT o.id ${SEARCH_FROM} ${whereClause} ORDER BY o.id`,
            params
        );
        if (result.rows.length > MAX_OFFERS_PER_LEAD) {
            return res.status(400).json({
                error: `В отборе ${result.rows.length} офферов, максимум на одного лида — ${MAX_OFFERS_PER_LEAD}. ${TOO_MANY_OFFERS_HINT}`
            });
        }
        res.json({ ids: result.rows.map((r) => r.id) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список офферов отбора' });
    }
});

// GET /api/real-estate-offers/search-filters — значения трёх фильтров.
// Простые DISTINCT по sources, без проверки «есть ли под это значение офферы»
// (решение куратора D3): джойн на 38 000 при каждом открытии модалки дороже,
// чем изредка пустой результат — пользователь честно увидит «Ничего не найдено».
router.get('/search-filters', async (req, res) => {
    try {
        const [rootSources, platforms, cityRegions] = await Promise.all([
            pool.query(`SELECT DISTINCT root_source FROM sources WHERE root_source IS NOT NULL AND root_source <> '' ORDER BY root_source`),
            pool.query(`SELECT DISTINCT p.id, p.name FROM sources s JOIN ad_platforms p ON p.id = s.platform_id ORDER BY p.name`),
            pool.query(`SELECT DISTINCT city_region FROM sources WHERE city_region IS NOT NULL AND city_region <> '' ORDER BY city_region`)
        ]);
        res.json({
            rootSources: rootSources.rows.map((r) => r.root_source),
            platforms: platforms.rows.map((r) => ({ id: r.id, name: r.name })),
            cityRegions: cityRegions.rows.map((r) => r.city_region)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить значения фильтров' });
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
