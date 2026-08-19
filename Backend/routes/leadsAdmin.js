// --- routes/leadsAdmin.js: админский слой для страницы «Лиды»
// (report_2026-08-01.md, 13.08.2026). Отдельный от routes/leads.js файл —
// тот целиком заточен под личный кабинет оператора (обязательный employeeId,
// доступ только к своим лидам), используется Backend/Operator/, ломать нельзя.
// Здесь — полный доступ ко всем лидам, без ограничения по employeeId.
//
// Задача «скрипты: привязка к лиду»: у лида появились линия, основной скрипт,
// скрипт для повторных и три связки многие-ко-многим (офферы, статусы показа
// скрипта, пул раздачи). Связки пересобираются целиком в транзакции при каждом
// POST/PUT — тот же приём, что у real_estate_offer_segments.

const express = require('express');
const { pool } = require('../db');
const { startOfDay, startOfNextDay, zonedParts } = require('../services/appTime');
const { distributePendingLeads, findNewFunnelStatusId } = require('../services/leadDistribution');

const router = express.Router();

const { MAX_OFFERS_PER_LEAD, MAX_OFFER_LINKS_PER_BATCH, TOO_MANY_OFFERS_HINT } = require('../services/leadOfferLimits');

const LINE_TYPES = ['Входящая', 'Исходящая'];

// Порядок должен совпадать со списком колонок в INSERT/UPDATE ниже.
const FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['phone', 'phone'],
    ['sourceId', 'source_id'],
    ['lineType', 'line_type'],
    ['employeeId', 'employee_id'],
    ['funnelStatusId', 'funnel_status_id'],
    ['scriptId', 'script_id'],
    ['repeatScriptId', 'repeat_script_id'],
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

const NUMERIC_FIELDS = new Set(['sourceId', 'employeeId', 'funnelStatusId', 'scriptId', 'repeatScriptId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

// «Иной заёмщик» трёхзначный (NULL / true / false) — та же обработка, что в
// routes/leads.js: без неё строка 'false' из формы легла бы в базу как true.
const BOOLEAN_FIELDS = new Set(['otherBorrower']);

// Ключи, которые разрешено менять через bulk-update. Строгий whitelist, а не
// «всё, что пришло» (требование куратора, dialog.md B1): иначе лёгкий PATCH
// стал бы чёрным ходом мимо обязательной валидации PUT.
const BULK_PATCH_COLUMNS = {
    employeeId: 'employee_id',
    funnelStatusId: 'funnel_status_id',
    scriptId: 'script_id',
    repeatScriptId: 'repeat_script_id'
};

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

// null — значение вообще не массив (клиент прислал мусор); [] — пустой список.
function normalizeIdArray(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    for (const raw of value) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) return null;
        seen.add(n);
    }
    return Array.from(seen);
}

// JOIN на sources/employees/lead_funnel_statuses/scripts для читаемых имён +
// три связки одним json_agg на каждую (без N+1 с фронта, dialog.md H2).
const BASE_SELECT = `
    SELECT l.*,
           s.root_source AS source_name,
           CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name ELSE NULL END AS employee_name,
           fs.status_name, fs.stage_name, fs.stage_number,
           sc.title AS script_title,
           rsc.title AS repeat_script_title,
           COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name) ORDER BY o.name)
                     FROM lead_offers lo JOIN real_estate_offers o ON o.id = lo.offer_id
                     WHERE lo.lead_id = l.id), '[]'::json) AS offers,
           COALESCE((SELECT json_agg(lss.funnel_status_id ORDER BY lss.funnel_status_id)
                     FROM lead_script_statuses lss WHERE lss.lead_id = l.id), '[]'::json) AS script_status_ids,
           COALESCE((SELECT json_agg(ldp.employee_id ORDER BY ldp.employee_id)
                     FROM lead_distribution_pool ldp WHERE ldp.lead_id = l.id), '[]'::json) AS pool_employee_ids
    FROM leads l
    LEFT JOIN sources s ON s.id = l.source_id
    LEFT JOIN employees e ON e.id = l.employee_id
    LEFT JOIN lead_funnel_statuses fs ON fs.id = l.funnel_status_id
    LEFT JOIN scripts sc ON sc.id = l.script_id
    LEFT JOIN scripts rsc ON rsc.id = l.repeat_script_id
`;

function rowToLead(row) {
    const offers = row.offers || [];
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        phone: row.phone,
        sourceId: row.source_id,
        sourceName: row.source_name,
        lineType: row.line_type,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        funnelStatusId: row.funnel_status_id,
        statusName: row.status_name,
        stageName: row.stage_name,
        stageNumber: row.stage_number,
        scriptId: row.script_id,
        scriptTitle: row.script_title,
        repeatScriptId: row.repeat_script_id,
        repeatScriptTitle: row.repeat_script_title,
        offers,
        offerIds: offers.map((o) => o.id),
        scriptStatusIds: row.script_status_ids || [],
        poolEmployeeIds: row.pool_employee_ids || [],
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

const FK_MESSAGES = {
    leads_source_id_fkey: 'Указанный источник не найден',
    leads_employee_id_fkey: 'Указанный сотрудник не найден',
    leads_funnel_status_id_fkey: 'Указанный статус воронки не найден',
    leads_script_id_fkey: 'Указанный скрипт не найден',
    leads_repeat_script_id_fkey: 'Указанный скрипт для повторных не найден',
    lead_offers_offer_id_fkey: 'Один из выбранных офферов не найден',
    lead_script_statuses_funnel_status_id_fkey: 'Один из выбранных статусов показа не найден',
    lead_distribution_pool_employee_id_fkey: 'Один из выбранных сотрудников не найден'
};

function handleFkError(err, res) {
    if (err.code !== '23503') return false;
    const message = FK_MESSAGES[err.constraint];
    if (!message) return false;
    res.status(400).json({ error: message });
    return true;
}

// ================= Валидация =================

async function checkActiveScript(db, scriptId, label) {
    const result = await db.query('SELECT status FROM scripts WHERE id = $1', [scriptId]);
    if (result.rows.length === 0) return `${label}: скрипт не найден`;
    if (result.rows[0].status !== 'active') return `${label}: назначить можно только активный скрипт`;
    return null;
}

// "Повторные" = этапы воронки 5 и 6 (решение владельца п.2).
async function hasRepeatStages(db, statusIds) {
    if (statusIds.length === 0) return false;
    const result = await db.query(
        'SELECT 1 FROM lead_funnel_statuses WHERE id = ANY($1::int[]) AND stage_number >= 5 LIMIT 1',
        [statusIds]
    );
    return result.rows.length > 0;
}

// Общий набор параметров подбора — одинаков для карточки лида (POST/PUT) и
// для всей партии в bulk-import. Возвращает { error } либо { data }.
async function validateLeadParams(db, body) {
    if (!LINE_TYPES.includes(body.lineType)) {
        return { error: `Укажите линию: ${LINE_TYPES.join(' или ')}` };
    }
    if (!body.sourceId) {
        return { error: 'Заполните обязательное поле: Источник' };
    }

    const offerIds = normalizeIdArray(body.offerIds);
    if (offerIds === null) return { error: 'Некорректный список офферов' };
    if (offerIds.length === 0) return { error: 'Выберите хотя бы один оффер' };
    if (offerIds.length > MAX_OFFERS_PER_LEAD) {
        return { error: `Слишком много офферов на одного лида: ${offerIds.length}, максимум ${MAX_OFFERS_PER_LEAD}. ${TOO_MANY_OFFERS_HINT}` };
    }

    const scriptStatusIds = normalizeIdArray(body.scriptStatusIds);
    if (scriptStatusIds === null) return { error: 'Некорректный список статусов показа скрипта' };
    if (scriptStatusIds.length === 0) return { error: 'Выберите хотя бы один статус показа скрипта' };

    const poolEmployeeIds = normalizeIdArray(body.poolEmployeeIds);
    if (poolEmployeeIds === null) return { error: 'Некорректный список сотрудников для пула раздачи' };

    if (!body.scriptId) return { error: 'Заполните обязательное поле: Скрипт' };
    const scriptError = await checkActiveScript(db, body.scriptId, 'Скрипт');
    if (scriptError) return { error: scriptError };

    // Скрипт для повторных обязателен, если среди статусов показа есть этапы
    // 5–6. Если не обязателен, но всё равно передан — сохраняем (лид может
    // дойти до повторного этапа и без такого статуса в списке), но проверяем
    // так же строго.
    const repeatScriptId = body.repeatScriptId ? Number(body.repeatScriptId) : null;
    const needsRepeat = await hasRepeatStages(db, scriptStatusIds);
    if (needsRepeat && !repeatScriptId) {
        return { error: 'Среди статусов показа есть этапы 5–6 — укажите скрипт для повторных' };
    }
    if (repeatScriptId) {
        const repeatError = await checkActiveScript(db, repeatScriptId, 'Скрипт для повторных');
        if (repeatError) return { error: repeatError };
    }

    return { data: { offerIds, scriptStatusIds, poolEmployeeIds, repeatScriptId } };
}

async function validateFullLeadBody(db, body) {
    if (!body.phone || String(body.phone).trim() === '') {
        return { error: 'Заполните обязательное поле: Номер телефона' };
    }
    return validateLeadParams(db, body);
}

// Назначить лиду можно только оператора ЕГО линии — то же правило, по которому
// работает автораздача (services/leadDistribution.js). Проверка нужна и в обход
// интерфейса: эндпоинт доступен напрямую.
//
// Ключевая тонкость: проверяем ТОЛЬКО когда назначение МЕНЯЕТСЯ. У легаси-лида
// уже может стоять оператор другой линии (на бою такие есть), а карточка шлёт
// PUT полным телом — без этого условия правка телефона у такого лида падала бы
// с 400 на операторе, которого пользователь не трогал (dialog.md B1).
// currentEmployeeId === undefined означает «сравнивать не с чем» (создание).
async function checkEmployeeLine(db, { employeeId, lineType, currentEmployeeId }) {
    if (employeeId === null || employeeId === undefined || employeeId === '') return null;
    const nextId = Number(employeeId);
    if (currentEmployeeId !== undefined && currentEmployeeId !== null && Number(currentEmployeeId) === nextId) {
        return null; // назначение не меняется — не наше дело
    }
    if (!lineType) {
        return 'Сначала укажите линию лида — без неё нельзя назначить оператора';
    }
    const result = await db.query('SELECT last_name, first_name, line_type FROM employees WHERE id = $1', [nextId]);
    if (result.rows.length === 0) return 'Указанный сотрудник не найден';
    const employee = result.rows[0];
    if (employee.line_type !== lineType) {
        const employeeLine = employee.line_type ? `«${employee.line_type}»` : 'не указана';
        return `Сотрудник ${employee.last_name} ${employee.first_name}: линия ${employeeLine}, а у лида «${lineType}». Назначить можно только оператора той же линии`;
    }
    return null;
}

// ================= Связки =================

// Пересборка целиком: delete + один INSERT ... SELECT unnest на связку.
// unnest вместо цикла — при 1000 офферов цикл дал бы 1000 round-trip'ов.
async function replaceLeadLinks(client, leadId, { offerIds, scriptStatusIds, poolEmployeeIds }) {
    await client.query('DELETE FROM lead_offers WHERE lead_id = $1', [leadId]);
    if (offerIds.length > 0) {
        await client.query('INSERT INTO lead_offers (lead_id, offer_id) SELECT $1, unnest($2::int[])', [leadId, offerIds]);
    }
    await client.query('DELETE FROM lead_script_statuses WHERE lead_id = $1', [leadId]);
    if (scriptStatusIds.length > 0) {
        await client.query('INSERT INTO lead_script_statuses (lead_id, funnel_status_id) SELECT $1, unnest($2::int[])', [leadId, scriptStatusIds]);
    }
    await client.query('DELETE FROM lead_distribution_pool WHERE lead_id = $1', [leadId]);
    if (poolEmployeeIds.length > 0) {
        await client.query('INSERT INTO lead_distribution_pool (lead_id, employee_id) SELECT $1, unnest($2::int[])', [leadId, poolEmployeeIds]);
    }
}

// Тот же набор связок сразу на всю партию — одним запросом на связку,
// а не на каждого лида: CROSS JOIN двух unnest'ов даёт декартово
// произведение "все лиды партии × все значения набора".
async function insertBatchLinks(client, leadIds, { offerIds, scriptStatusIds, poolEmployeeIds }) {
    if (leadIds.length === 0) return;
    if (offerIds.length > 0) {
        await client.query(
            `INSERT INTO lead_offers (lead_id, offer_id)
             SELECT l, o FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) o
             ON CONFLICT DO NOTHING`,
            [leadIds, offerIds]
        );
    }
    if (scriptStatusIds.length > 0) {
        await client.query(
            `INSERT INTO lead_script_statuses (lead_id, funnel_status_id)
             SELECT l, s FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) s
             ON CONFLICT DO NOTHING`,
            [leadIds, scriptStatusIds]
        );
    }
    if (poolEmployeeIds.length > 0) {
        await client.query(
            `INSERT INTO lead_distribution_pool (lead_id, employee_id)
             SELECT l, e FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) e
             ON CONFLICT DO NOTHING`,
            [leadIds, poolEmployeeIds]
        );
    }
}

async function fetchLeadById(id) {
    const result = await pool.query(`${BASE_SELECT} WHERE l.id = $1`, [id]);
    return result.rows[0] ? rowToLead(result.rows[0]) : null;
}

// ================= Роуты =================

// GET /api/leads-admin — список лидов под фильтры и кнопку «Показать ещё».
//
// ОТВЕТ — ОБЪЕКТ { items, total }, а не массив (часть 2, подвал «Показано N из
// M»). Раньше отдавался голый массив, и «M» фронту взять было неоткуда: он знал
// только длину полученной порции. Считаем total ТЕМ ЖЕ условием, что и выборку,
// — иначе подвал обещал бы одно, а фильтр показывал другое.
//
// Параметр q — общий поиск по ФИО И телефону сразу, под одно поле тулбара
// «Поиск по имени или телефону». Раздельные fio и phone остались: ими
// пользуется окно «Фильтры», где это два разных поля.
router.get('/', async (req, res) => {
    try {
        const { q, fio, phone, sourceId, employeeId, funnelStatusId, limit, offset } = req.query;

        const conditions = [];
        const params = [];

        if (q && q.trim()) {
            params.push(`%${q.trim()}%`);
            const idx = params.length;
            conditions.push(`(l.last_name ILIKE $${idx} OR l.first_name ILIKE $${idx}
                              OR l.middle_name ILIKE $${idx} OR l.phone ILIKE $${idx})`);
        }
        if (fio && fio.trim()) {
            params.push(`%${fio.trim()}%`);
            const idx = params.length;
            conditions.push(`(l.last_name ILIKE $${idx} OR l.first_name ILIKE $${idx} OR l.middle_name ILIKE $${idx})`);
        }
        if (phone && phone.trim()) {
            params.push(`%${phone.trim()}%`);
            conditions.push(`l.phone ILIKE $${params.length}`);
        }
        if (sourceId) {
            params.push(sourceId);
            conditions.push(`l.source_id = $${params.length}`);
        }
        if (employeeId === 'none') {
            conditions.push('l.employee_id IS NULL');
        } else if (employeeId) {
            params.push(employeeId);
            conditions.push(`l.employee_id = $${params.length}`);
        }
        if (funnelStatusId) {
            params.push(funnelStatusId);
            conditions.push(`l.funnel_status_id = $${params.length}`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const filterParams = params.slice();

        params.push(Number(limit) > 0 ? Number(limit) : 50);
        const limitIdx = params.length;
        params.push(Number(offset) > 0 ? Number(offset) : 0);
        const offsetIdx = params.length;

        const [rows, totals] = await Promise.all([
            pool.query(
                `${BASE_SELECT} ${whereClause} ORDER BY l.created_at DESC, l.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
                params
            ),
            pool.query(`SELECT count(*)::int AS total FROM leads l ${whereClause}`, filterParams)
        ]);
        res.json({ items: rows.rows.map(rowToLead), total: totals.rows[0].total });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список лидов' });
    }
});

// GET /api/leads-admin/stats — три цифры шапки раздела (всего / без оператора /
// за сегодня), считаются по ВСЕМ лидам, не по текущим фильтрам.
//
// СУТКИ СЧИТАЮТСЯ В ПОЯСЕ ПРИЛОЖЕНИЯ, а не в поясе сессии БД. Раньше здесь
// стояло `created_at::date = CURRENT_DATE`: на Railway контейнер идёт в UTC, и
// с полуночи до трёх ночи по Москве цифра показывала вчерашний день. Это было
// единственное место в routes/* с CURRENT_DATE.
//
// Ответ несёт ещё и само серверное «сегодня» (todayDate, YYYY-MM-DD в поясе
// приложения): подпись раздела «очередь на 19 августа» обязана совпадать с тем
// днём, по которому посчитан счётчик, а часы браузера у оператора могут стоять
// в другом поясе.
router.get('/stats', async (req, res) => {
    try {
        const now = new Date();
        const dayStart = startOfDay(now);
        const dayEnd = startOfNextDay(now);
        const p = zonedParts(now);
        const todayDate = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

        const result = await pool.query(`
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE employee_id IS NULL)::int AS queue,
                count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS today
            FROM leads
        `, [dayStart, dayEnd]);
        const row = result.rows[0];
        res.json({ total: row.total, queue: row.queue, today: row.today, todayDate });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить статистику' });
    }
});

// GET /api/leads-admin/check-phone?phone= — не блокирует ничего сама по
// себе, фронт вызывает по blur поля телефона и показывает предупреждение.
router.get('/check-phone', async (req, res) => {
    try {
        const phone = (req.query.phone || '').trim();
        if (!phone) {
            return res.json({ duplicateId: null });
        }
        const result = await pool.query('SELECT id FROM leads WHERE phone = $1 LIMIT 1', [phone]);
        res.json({ duplicateId: result.rows[0] ? result.rows[0].id : null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось проверить номер' });
    }
});

// GET /api/leads-admin/:id
router.get('/:id', async (req, res) => {
    try {
        const lead = await fetchLeadById(req.params.id);
        if (!lead) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        res.json(lead);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить лида' });
    }
});

// POST /api/leads-admin — создание вручную. Обязательны телефон, линия,
// источник, минимум один оффер, скрипт и минимум один статус показа; дубль
// по телефону не блокирует (фронт заранее предупреждает через check-phone).
router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
        const validation = await validateFullLeadBody(client, req.body);
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }
        // Новый лид — сравнивать не с чем, назначение всегда «меняется».
        const lineError = await checkEmployeeLine(client, {
            employeeId: req.body.employeeId,
            lineType: req.body.lineType
        });
        if (lineError) {
            return res.status(400).json({ error: lineError });
        }

        await client.query('BEGIN');
        const body = { ...req.body, repeatScriptId: validation.data.repeatScriptId };
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await client.query(
            `INSERT INTO leads (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const leadId = result.rows[0].id;
        await replaceLeadLinks(client, leadId, validation.data);
        await client.query('COMMIT');

        res.status(201).json(await fetchLeadById(leadId));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать лида' });
    } finally {
        client.release();
    }
});

// PUT /api/leads-admin/:id — те же поля и та же валидация, что у POST
// (в отличие от routes/leads.js — без ограничения по employeeId).
router.put('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const validation = await validateFullLeadBody(client, req.body);
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }
        // Текущее назначение нужно, чтобы отличить «пользователь назначил
        // нового оператора» от «легаси-назначение просто приехало обратно».
        const current = await client.query('SELECT employee_id FROM leads WHERE id = $1', [req.params.id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const lineError = await checkEmployeeLine(client, {
            employeeId: req.body.employeeId,
            lineType: req.body.lineType,
            currentEmployeeId: current.rows[0].employee_id
        });
        if (lineError) {
            return res.status(400).json({ error: lineError });
        }

        await client.query('BEGIN');
        const body = { ...req.body, repeatScriptId: validation.data.repeatScriptId };
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await client.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
            values
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const leadId = result.rows[0].id;
        await replaceLeadLinks(client, leadId, validation.data);
        await client.query('COMMIT');

        res.json(await fetchLeadById(leadId));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить лида' });
    } finally {
        client.release();
    }
});

// DELETE /api/leads-admin/:id — связки уходят каскадом.
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM leads WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить лида' });
    }
});

// POST /api/leads-admin/bulk-update { leadIds, patch } — лёгкая PATCH-семантика
// под массовые действия списка (dialog.md B1). Полное тело лида не требуется,
// поэтому массово править можно и старых лидов, у которых ещё не заполнены
// обязательные для PUT поля. patch — строгий whitelist из четырёх ключей.
router.post('/bulk-update', async (req, res) => {
    const { leadIds, patch } = req.body;

    const ids = normalizeIdArray(leadIds);
    if (ids === null) return res.status(400).json({ error: 'Некорректный список лидов' });
    if (ids.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного лида' });

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'Не передан набор изменений' });
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) return res.status(400).json({ error: 'Не передан набор изменений' });
    const unknown = keys.filter((key) => !Object.prototype.hasOwnProperty.call(BULK_PATCH_COLUMNS, key));
    if (unknown.length > 0) {
        return res.status(400).json({ error: `Это поле нельзя изменить массово: ${unknown.join(', ')}` });
    }

    try {
        for (const key of ['scriptId', 'repeatScriptId']) {
            if (keys.includes(key) && patch[key]) {
                const label = key === 'scriptId' ? 'Скрипт' : 'Скрипт для повторных';
                const scriptError = await checkActiveScript(pool, patch[key], label);
                if (scriptError) return res.status(400).json({ error: scriptError });
            }
        }

        // Массовое назначение оператора проверяется по КАЖДОМУ лиду отдельно:
        // линия у них своя, а у части может стоять то же назначение (тогда
        // ничего не меняется и проверять нечего). Всё или ничего — применить
        // к части выбранных нельзя, иначе пользователь не поймёт, что вышло.
        if (keys.includes('employeeId') && patch.employeeId) {
            const leads = await pool.query('SELECT id, employee_id, line_type FROM leads WHERE id = ANY($1::int[])', [ids]);
            for (const lead of leads.rows) {
                const lineError = await checkEmployeeLine(pool, {
                    employeeId: patch.employeeId,
                    lineType: lead.line_type,
                    currentEmployeeId: lead.employee_id
                });
                if (lineError) {
                    return res.status(400).json({ error: `Лид #${lead.id}: ${lineError}` });
                }
            }
        }

        const setClauses = keys.map((key, i) => `${BULK_PATCH_COLUMNS[key]} = $${i + 1}`);
        const values = keys.map((key) => normalizeValue(key, patch[key]));
        values.push(ids);
        const result = await pool.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = ANY($${values.length}::int[]) RETURNING id`,
            values
        );
        res.json({ updated: result.rows.length });
    } catch (err) {
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось применить массовое изменение' });
    }
});

// POST /api/leads-admin/bulk-import — массовая загрузка. Парсинг Excel/CSV на
// фронте, сюда приходит готовый JSON: { sourceId, lineType, scriptId,
// repeatScriptId?, offerIds, scriptStatusIds, poolEmployeeIds?, rows }.
// Один набор параметров на всю партию. Каждая строка становится лидом со
// статусом "Новый" и без оператора; сразу после вставки запускается
// автораспределение. Дубли по телефону (внутри файла и против существующих
// лидов) не блокируют вставку — только помечаются в ответе. Вся вставка +
// связки + распределение — одной транзакцией.
router.post('/bulk-import', async (req, res) => {
    const { sourceId, rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'Файл пуст или не содержит строк для загрузки' });
    }

    const client = await pool.connect();
    try {
        const validation = await validateLeadParams(client, req.body);
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }
        const { offerIds, scriptStatusIds, poolEmployeeIds, repeatScriptId } = validation.data;

        // Потолок на лида (проверен выше) партию не защищает: связки
        // перемножаются, и 5000 строк × 1000 офферов дали бы 5 млн строк в
        // одной транзакции — таймаут прокси с откатом всей загрузки в конце.
        // Считаем по rows.length, а не по числу строк с телефоном: это верхняя
        // граница, и отбить партию нужно ДО того, как начнём вставку.
        const linkCount = rows.length * offerIds.length;
        if (linkCount > MAX_OFFER_LINKS_PER_BATCH) {
            return res.status(400).json({
                error: `Слишком большая партия: ${rows.length} строк × ${offerIds.length} офферов = ${linkCount} связок, максимум ${MAX_OFFER_LINKS_PER_BATCH}. Уменьшите файл или сузьте набор офферов`
            });
        }

        await client.query('BEGIN');

        const newStatusId = await findNewFunnelStatusId(client);
        if (newStatusId === null) {
            await client.query('ROLLBACK');
            return res.status(500).json({ error: 'Не найден системный статус "Новый" — обратитесь к разработчику' });
        }

        const insertedIds = [];
        const duplicates = [];

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const phone = row.phone ? String(row.phone).trim() : '';
            if (!phone) continue; // без телефона строку вставить нельзя (leads.phone NOT NULL)

            const existing = await client.query('SELECT id FROM leads WHERE phone = $1 LIMIT 1', [phone]);
            if (existing.rows.length > 0) {
                duplicates.push({ row: i + 1, phone, existingLeadId: existing.rows[0].id });
            }

            const inserted = await client.query(
                `INSERT INTO leads (last_name, first_name, middle_name, phone, source_id, funnel_status_id,
                                    line_type, script_id, repeat_script_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                [
                    row.lastName ? String(row.lastName).trim() || null : null,
                    row.firstName ? String(row.firstName).trim() || null : null,
                    row.middleName ? String(row.middleName).trim() || null : null,
                    phone,
                    sourceId,
                    newStatusId,
                    req.body.lineType,
                    req.body.scriptId,
                    repeatScriptId
                ]
            );
            insertedIds.push(inserted.rows[0].id);
        }

        await insertBatchLinks(client, insertedIds, { offerIds, scriptStatusIds, poolEmployeeIds });
        await distributePendingLeads(client);

        // Сколько именно из ЭТОЙ партии распределилось/осталось в очереди —
        // считаем по insertedIds отдельно, а не по возвращаемому значению
        // distributePendingLeads(): та разбирает ВСЮ зависшую очередь разом
        // (включая лидов из прошлых загрузок), поэтому её общее число не
        // равно доле именно этой партии.
        const batchStatus = await client.query(
            `SELECT count(*) FILTER (WHERE employee_id IS NOT NULL)::int AS assigned,
                    count(*) FILTER (WHERE employee_id IS NULL)::int AS queued
             FROM leads WHERE id = ANY($1::int[])`,
            [insertedIds]
        );
        const { assigned, queued } = batchStatus.rows[0];

        await client.query('COMMIT');
        res.status(201).json({
            imported: insertedIds.length,
            distributed: assigned,
            queued,
            duplicates
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось загрузить базу' });
    } finally {
        client.release();
    }
});

module.exports = router;
