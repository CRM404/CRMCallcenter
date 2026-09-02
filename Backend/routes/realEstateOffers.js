// --- routes/realEstateOffers.js: CRUD для офферов недвижимости
// (report_2026-08-01.md, 07.08.2026) — паттерн 1:1 с routes/cpaNetworks.js
// для основных полей + пересборка вложенных сегментов/географии целиком
// (delete+insert в транзакции) при каждом POST/PUT, т.к. фронт держит эти
// списки как единый массив в форме, без отдельных CRUD-ручек на строку.

const express = require('express');
const { pool } = require('../db');
const { MAX_OFFERS_PER_LEAD, TOO_MANY_OFFERS_HINT } = require('../services/leadOfferLimits');
const guards = require('../services/deleteGuards');

const router = express.Router();

// Ключ живёт в базе, ПОДПИСЬ — на экране. Сообщение об ошибке называет
// подписи (К86): внутренних active/paused/disabled/draft человек не видел
// нигде и сопоставить их с тем, что выбрал, не может.
//
// Перечень уехал в `services/offerStatus.js` (К229): подписи понадобились
// второму месту — плашке «строка не работает» на вкладке «События», — а второй
// список подписей в проекте был бы ровно К36.
const { STATUS_VALUES, STATUS_LABELS } = require('../services/offerStatus');

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

// ЧИСЛОВЫЕ ПРОВЕРКИ НАРАВНЕ С ОБЯЗАТЕЛЬНЫМИ (К85). Ставка, hold, взнос,
// приоритет и лимит — то, по чему считаются деньги и очередь передачи лида, и
// неправильное значение здесь дороже пустого названия. Раньше сервер смотрел
// только name, networkId и status, а клиент — только name и networkId: ни одной
// числовой проверки не было ни с одной стороны.
//
// Тексты совпадают с клиентскими ДОСЛОВНО (К87): два разных сообщения об одной
// ошибке читаются как две разные ошибки.
const NUMBER_RULES = [
    ['rate', 'Ставка должна быть числом не меньше нуля', (n) => n >= 0],
    ['holdDays', 'Hold должен быть целым числом дней', (n) => Number.isInteger(n) && n >= 0],
    ['downPaymentPercent', 'Первоначальный взнос должен быть числом от 0 до 100', (n) => n >= 0 && n <= 100],
    ['priority', 'Приоритет — число от 1 до 5', (n) => Number.isInteger(n) && n >= 1 && n <= 5],
    ['leadLimit', 'Лимит лидов должен быть целым числом больше нуля', (n) => Number.isInteger(n) && n > 0]
];

function validateNumbers(body) {
    for (const [key, message, ok] of NUMBER_RULES) {
        const raw = body[key];
        if (raw === undefined || raw === null || String(raw).trim() === '') continue;
        const number = Number(raw);
        if (!Number.isFinite(number) || !ok(number)) return message;
    }
    return null;
}

// ----- Числа сегмента: тип, предел и пара (К304) ------------------------------
//
// ⚠ ОТДЕЛЬНОЙ ФУНКЦИЕЙ, А НЕ СТРОКАМИ В `NUMBER_RULES`, и причин две. Первая:
// `NUMBER_RULES` разбирает ПОЛЕ тела оффера, а здесь предмет — вложенный массив,
// и отказ обязан назвать НОМЕР сегмента: «Сегмент 2» человек найдёт глазами,
// «цена неверна» — нет. Вторая: пара — это ДВА поля сразу, и правилу «ключ плюс
// проверка одного числа» она не подчиняется. То же устройство и тот же довод,
// что у `checkRangePairs` в `leadsAdmin.js` (К302).
//
// ⚠ ПОРЯДОК ТРЁХ ПРОВЕРОК НЕ СЛУЧАЕН: сперва «это вообще число», потом «оно не
// отрицательное», и только потом «пара не перевёрнута». Сообщить о перевёрнутой
// паре, когда одно из чисел негодно, значит соврать о причине (правило К302).
//
// ⚠ ДО ЭТОГО ЗАХОДА НЕ ПРОВЕРЯЛОСЬ НИЧЕГО, и это замер, а не предположение:
// `normalizeValue` выше разбирает только `status` и `otherBorrower`, остальное
// пропускает как есть, а `NUMBER_RULES` знает ставку, hold, взнос, приоритет и
// лимит — цен и площадей там нет. Опыт на стенде 02.09.2026: «цена от −5 до −900»
// и «от 9 000 000 до 1 000 000» уходили ответом 200 и ЛОЖИЛИСЬ В БАЗУ.
//
// ⚠⚠ И ТРЕТИЙ СЛУЧАЙ, НАЙДЕННЫЙ ТЕМ ЖЕ ОПЫТОМ СВЕРХ НОМЕРА: нечисловое значение
// («дорого») давало не отказ, а ПАДЕНИЕ — 500 от `numeric_in` самой базы. То есть
// отбивал Postgres, а приложение показывало «наша ошибка». Теперь его отбивает
// первая же проверка, и человек получает 400 с внятным текстом.
//
// РАВЕНСТВО ЗАКОННО: «цена ровно 5 000 000» — точечный отбор, а не ошибка.
// Верхнего предела нет намеренно: обоснованного числа не существует, а
// выдуманное однажды упрётся в настоящий дорогой объект (довод К269 и К270).
const SEGMENT_PAIRS = [
    ['priceMin', 'priceMax', 'Цена от', 'Цена до'],
    ['areaMin', 'areaMax', 'Площадь от', 'Площадь до']
];

function validateSegments(body) {
    const rows = Array.isArray(body.segments) ? body.segments : [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const where = `Сегмент ${i + 1}`;
        for (const [minKey, maxKey, minLabel, maxLabel] of SEGMENT_PAIRS) {
            const pair = {};
            for (const [key, label] of [[minKey, minLabel], [maxKey, maxLabel]]) {
                const raw = row[key];
                if (raw === undefined || raw === null || String(raw).trim() === '') continue;
                const number = Number(raw);
                if (!Number.isFinite(number)) return `${where}: «${label}» должно быть числом`;
                if (number < 0) return `${where}: «${label}» не может быть отрицательной`;
                pair[key] = number;
            }
            if (pair[minKey] !== undefined && pair[maxKey] !== undefined
                && pair[minKey] > pair[maxKey]) {
                return `${where}: «${minLabel}» больше, чем «${maxLabel}»`;
            }
        }
    }
    return null;
}

function validateBody(body) {
    if (!body.name || String(body.name).trim() === '') {
        return 'Заполните обязательное поле: Название';
    }
    if (body.networkId === undefined || body.networkId === null || String(body.networkId).trim() === '') {
        return 'Заполните обязательное поле: Сеть';
    }
    // ПРИОРИТЕТ ОБЯЗАТЕЛЕН (решение владельца 105, корректировка К228). Он
    // решает, по какому офферу переводят лида, у которого офферов несколько:
    // пустое значение означало бы «порядок как повезёт», и на вкладке
    // «События» строки перевода вставали бы в случайном порядке.
    //
    // ⚠ ПРОВЕРКА ПРИЕХАЛА ВМЕСТЕ СО СВОЕЙ МИГРАЦИЕЙ, и порознь их выкатывать
    // нельзя: обязательность без заполнения пустых — это тридцать девять
    // карточек, которые перестают сохраняться. Миграция — в `schema.sql`,
    // замок `2026-08-28-offer-priority-fill`.
    //
    // Отказ называет ПОЛЕ, а не «проверьте данные»: человек должен знать, куда
    // смотреть. Диапазон проверяет `validateNumbers` ниже — здесь только
    // «заполнено ли».
    if (body.priority === undefined || body.priority === null || String(body.priority).trim() === '') {
        return 'Заполните обязательное поле: Приоритет';
    }
    const status = normalizeValue('status', body.status);
    if (!STATUS_VALUES.includes(status)) {
        return `Статус должен быть одним из: ${STATUS_LABELS.join(', ')}`;
    }
    const numberError = validateNumbers(body);
    if (numberError) return numberError;
    // Сегменты проверяются ПОСЛЕ полей самого оффера: сперва человек чинит
    // карточку, потом её строки. Порядок тот же, что у отказов внутри сегмента.
    const segmentError = validateSegments(body);
    if (segmentError) return segmentError;
    // Пустой конец периода значит «бессрочно», поэтому проверяется только пара
    // заполненных дат.
    const start = normalizeValue('dateStart', body.dateStart);
    const end = normalizeValue('dateEnd', body.dateEnd);
    if (start && end && String(end) < String(start)) {
        return 'Конец периода не может быть раньше начала';
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
        // Сколько лидов привязано к офферу (К84). Колонка «Лидов» отвечает на
        // вопрос «работает ли оффер»: «Активен» при нуле лидов и «Активен» при
        // сорока одном — разные вещи, и увидеть разницу надо из списка, а не из
        // отчёта. Считается одной агрегатной подвыборкой на весь список; в
        // ответе одиночной записи поля нет, и ноль там — не число из базы, а
        // «не спрашивали».
        leadsCount: row.leads_count === undefined ? 0 : Number(row.leads_count),
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
        const listSelect = `
            SELECT o.*, COALESCE(lc.c, 0) AS leads_count
            FROM real_estate_offers o
            LEFT JOIN (
                SELECT offer_id, count(*)::int AS c FROM lead_offers GROUP BY offer_id
            ) lc ON lc.offer_id = o.id
        `;
        const offersResult = networkId
            ? await pool.query(`${listSelect} WHERE o.network_id = $1 ORDER BY o.id`, [networkId])
            : await pool.query(`${listSelect} ORDER BY o.id`);
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
// Маппинг фильтров на схему:
//
// «Корневой источник» и «Площадка» — колонки sources (root_source, platform_id
// -> ad_platforms.name), цепляются к офферу через его сеть: network_id ->
// source_cpa_networks -> sources. Оффер проходит, если у его сети есть ХОТЯ БЫ
// ОДИН источник, удовлетворяющий ВСЕМ выбранным условиям сразу.
//
// География (4 уровня) — СОБСТВЕННАЯ география оффера, real_estate_offer_geo
// при kind='object' (решение владельца, 13.08.2026). Раньше здесь стояла
// sources.city_region — география ИСТОЧНИКА, приклеенная к офферу через сеть:
// связь косвенная и практически случайная, оффер находился не по своим данным.
// Совпадение строгое: пустой уровень у оффера НЕ подходит — отдельной логики
// для этого не нужно, обычное равенство с NULL не сматчится само собой.
// ============================================================

const SEARCH_DEFAULT_LIMIT = 50;
// Потолок совпадает с максимумом офферов на лида: после «Добавить все» фронту
// нужны НАЗВАНИЯ всего отбора, чтобы показать выбранное тегами (search-ids по
// контракту отдаёт только id). Больше этого числа офферов на лида всё равно
// не сохранить, поэтому и запрашивать больше незачем.
const SEARCH_MAX_LIMIT = MAX_OFFERS_PER_LEAD;

const GEO_LEVELS = ['region', 'city', 'district', 'locality'];

// Условия по географии строятся один раз и переиспользуются: одна и та же
// строка real_estate_offer_geo и фильтрует оффер, и даёт гео-часть подстроки
// результата. Иначе оффер с двумя строками географии находился бы по одной
// строке, а показывал бы другую — тот же дефект «подстрока врёт», который эта
// задача и чинит (dialog.md A8).
function buildGeoConditions(query, startIndex) {
    const conditions = [];
    const params = [];
    GEO_LEVELS.forEach((level) => {
        const value = query[level];
        if (value && String(value).trim()) {
            params.push(String(value).trim());
            conditions.push(`g.${level} = $${startIndex + params.length - 1}`);
        }
    });
    return { conditions, params };
}

// Возвращает готовые FROM и WHERE с общим массивом параметров. Гео идёт первым
// потому, что его плейсхолдеры попадают в FROM (LATERAL), а нумерация
// параметров в Postgres сквозная по всему запросу.
function buildSearchQuery(query) {
    const params = [];

    const geo = buildGeoConditions(query, 1);
    params.push(...geo.params);
    const geoFilter = geo.conditions.length ? ` AND ${geo.conditions.join(' AND ')}` : '';

    // Гео-фильтр задан -> JOIN LATERAL (внутренний): оффер без подходящей
    // строки географии выпадает из выдачи сам, отдельный EXISTS не нужен, а
    // подстрока гарантированно берётся из СМАТЧИВШЕЙСЯ строки.
    // Гео-фильтра нет -> LEFT JOIN LATERAL: показываем все офферы, гео-часть
    // берётся из первой строки по id (или пустая, если географии нет вовсе).
    const geoJoin = geo.conditions.length ? 'JOIN LATERAL' : 'LEFT JOIN LATERAL';

    const from = `
        FROM real_estate_offers o
        LEFT JOIN LATERAL (
            SELECT s.root_source, p.name AS platform_name
            FROM source_cpa_networks scn
            JOIN sources s ON s.id = scn.source_id
            LEFT JOIN ad_platforms p ON p.id = s.platform_id
            WHERE scn.cpa_network_id = o.network_id
            ORDER BY s.id
            LIMIT 1
        ) src ON true
        ${geoJoin} (
            SELECT g.region, g.city, g.district, g.locality
            FROM real_estate_offer_geo g
            WHERE g.offer_id = o.id AND g.kind = 'object'${geoFilter}
            ORDER BY g.id
            LIMIT 1
        ) geo ON true
    `;

    const conditions = [];
    const { search, rootSource, platformId } = query;

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
    // Ни один из этих двух фильтров не выбран — EXISTS не добавляем вовсе,
    // иначе из выдачи молча выпали бы офферы сетей, у которых источников пока нет.
    if (sourceConditions.length > 0) {
        conditions.push(`EXISTS (
            SELECT 1 FROM source_cpa_networks scn
            JOIN sources s ON s.id = scn.source_id
            WHERE scn.cpa_network_id = o.network_id AND ${sourceConditions.join(' AND ')}
        )`);
    }

    return {
        from,
        whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

// GET /api/real-estate-offers/search?search=&rootSource=&platformId=&region=&city=&district=&locality=&limit=
// Плоские строки + общий счётчик отбора для шапки «Найдено: N».
router.get('/search', async (req, res) => {
    try {
        const { from, whereClause, params } = buildSearchQuery(req.query);

        const requestedLimit = Number(req.query.limit);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, SEARCH_MAX_LIMIT)
            : SEARCH_DEFAULT_LIMIT;
        params.push(limit);

        // count(*) OVER () считается до LIMIT — общий размер отбора известен
        // из того же запроса, второй COUNT не нужен.
        const result = await pool.query(
            `SELECT o.id, o.name, src.platform_name, src.root_source,
                    geo.region, geo.city, geo.district, geo.locality,
                    count(*) OVER ()::int AS total
             ${from}
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
            // Четыре уровня отдаются плоскими полями, а не готовой строкой:
            // как их склеить в подстроку — вопрос представления, он решается
            // на фронте (leadsOffers.js).
            items: result.rows.map((r) => ({
                id: r.id,
                name: r.name,
                platform: r.platform_name,
                rootSource: r.root_source,
                region: r.region,
                city: r.city,
                district: r.district,
                locality: r.locality
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
        const { from, whereClause, params } = buildSearchQuery(req.query);
        const result = await pool.query(
            `SELECT o.id ${from} ${whereClause} ORDER BY o.id`,
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

// Значения одного гео-уровня. Каскад строго сверху вниз: список сужается
// выбранными ВЫШЕСТОЯЩИМИ уровнями и считается по той же одной строке
// real_estate_offer_geo, что и сам фильтр, — иначе списки разъехались бы с
// выдачей (выбран регион, а в городах города всех регионов).
async function fetchGeoLevelValues(level, query) {
    const params = [];
    const conditions = [`kind = 'object'`, `${level} IS NOT NULL`, `${level} <> ''`];
    for (const upper of GEO_LEVELS.slice(0, GEO_LEVELS.indexOf(level))) {
        const value = query[upper];
        if (value && String(value).trim()) {
            params.push(String(value).trim());
            conditions.push(`${upper} = $${params.length}`);
        }
    }
    const result = await pool.query(
        `SELECT DISTINCT ${level} AS value FROM real_estate_offer_geo WHERE ${conditions.join(' AND ')} ORDER BY 1`,
        params
    );
    return result.rows.map((r) => r.value);
}

// GET /api/real-estate-offers/search-filters?region=&city=&district=
// Значения всех фильтров одним ответом. Гео-уровни зависят от выбранных выше,
// поэтому фронт перезапрашивает эндпоинт целиком при смене любого уровня —
// rootSources/platforms приезжают заодно (DISTINCT по нескольким сотням
// источников дешевле, чем отдельный эндпоинт ради экономии).
router.get('/search-filters', async (req, res) => {
    try {
        const [rootSources, platforms, regions, cities, districts, localities] = await Promise.all([
            pool.query(`SELECT DISTINCT root_source FROM sources WHERE root_source IS NOT NULL AND root_source <> '' ORDER BY root_source`),
            pool.query(`SELECT DISTINCT p.id, p.name FROM sources s JOIN ad_platforms p ON p.id = s.platform_id ORDER BY p.name`),
            fetchGeoLevelValues('region', req.query),
            fetchGeoLevelValues('city', req.query),
            fetchGeoLevelValues('district', req.query),
            fetchGeoLevelValues('locality', req.query)
        ]);
        res.json({
            rootSources: rootSources.rows.map((r) => r.root_source),
            platforms: platforms.rows.map((r) => ({ id: r.id, name: r.name })),
            regions,
            cities,
            districts,
            localities
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

// DELETE /api/real-estate-offers/:id — порядок плана 11.4, «Объект недвижимости».
//
// Шаг 1 — связи с лидами: есть хоть одна, удаление запрещено. Связь
// lead_offers → real_estate_offers переведена в запрет (класс Б, ответ
// куратора И74): нельзя удалить объект, который кому-то подобран. Обратная
// сторона той же связки, lead_offers → leads, осталась каскадной — там запрет
// сделал бы удаление лида невозможным всегда.
// Шаг 2 — сегменты, гео, оплата и ипотеки уходят каскадом (класс А).
// Шаг 3 — сам объект.
router.delete('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const blockers = guards.orderBlockers([
            await guards.countBlocker(pool, 'leads',
                `FROM leads l
                  WHERE EXISTS (SELECT 1 FROM lead_offers lo WHERE lo.lead_id = l.id AND lo.offer_id = $1)
                  ORDER BY l.id`, [id])
        ]);
        if (blockers.length > 0) return guards.refuse(res, blockers);

        const found = await pool.query('SELECT name FROM real_estate_offers WHERE id = $1', [id]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Оффер не найден' });
        }
        const removed = await guards.deleteAsBatch(
            pool, `Удаление объекта «${found.rows[0].name}»`,
            (client) => client.query('DELETE FROM real_estate_offers WHERE id = $1 RETURNING id', [id]));
        if (removed.rows.length === 0) {
            return res.status(404).json({ error: 'Оффер не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить оффер' });
    }
});

module.exports = router;
