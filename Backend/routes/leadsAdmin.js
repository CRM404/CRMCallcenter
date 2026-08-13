// --- routes/leadsAdmin.js: админский слой для страницы «Лиды»
// (report_2026-08-01.md, 13.08.2026). Отдельный от routes/leads.js файл —
// тот целиком заточен под личный кабинет оператора (обязательный employeeId,
// доступ только к своим лидам), используется Backend/Operator/, ломать нельзя.
// Здесь — полный доступ ко всем лидам, без ограничения по employeeId.

const express = require('express');
const { pool } = require('../db');
const { distributePendingLeads, findNewFunnelStatusId } = require('../services/leadDistribution');

const router = express.Router();

// Порядок должен совпадать со списком колонок в INSERT/UPDATE ниже.
const FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['phone', 'phone'],
    ['sourceId', 'source_id'],
    ['employeeId', 'employee_id'],
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

const NUMERIC_FIELDS = new Set(['sourceId', 'employeeId', 'funnelStatusId', 'offerId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

function normalizeValue(key, value) {
    if (NUMERIC_FIELDS.has(key)) {
        return value === '' || value === undefined || value === null ? null : Number(value);
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

// JOIN на sources/employees/lead_funnel_statuses/real_estate_offers для
// читаемых имён — тот же приём, что уже есть в routes/sources.js для площадки.
const BASE_SELECT = `
    SELECT l.*,
           s.root_source AS source_name,
           CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name ELSE NULL END AS employee_name,
           fs.status_name, fs.stage_name, fs.stage_number,
           o.name AS offer_name
    FROM leads l
    LEFT JOIN sources s ON s.id = l.source_id
    LEFT JOIN employees e ON e.id = l.employee_id
    LEFT JOIN lead_funnel_statuses fs ON fs.id = l.funnel_status_id
    LEFT JOIN real_estate_offers o ON o.id = l.offer_id
`;

function rowToLead(row) {
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        phone: row.phone,
        sourceId: row.source_id,
        sourceName: row.source_name,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        funnelStatusId: row.funnel_status_id,
        statusName: row.status_name,
        stageName: row.stage_name,
        stageNumber: row.stage_number,
        offerId: row.offer_id,
        offerName: row.offer_name,
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

function handleFkError(err, res) {
    if (err.code !== '23503') return false;
    if (err.constraint === 'leads_source_id_fkey') {
        res.status(400).json({ error: 'Указанный источник не найден' });
        return true;
    }
    if (err.constraint === 'leads_employee_id_fkey') {
        res.status(400).json({ error: 'Указанный сотрудник не найден' });
        return true;
    }
    if (err.constraint === 'leads_funnel_status_id_fkey') {
        res.status(400).json({ error: 'Указанный статус воронки не найден' });
        return true;
    }
    if (err.constraint === 'leads_offer_id_fkey') {
        res.status(400).json({ error: 'Указанный оффер не найден' });
        return true;
    }
    return false;
}

// GET /api/leads-admin — список всех лидов, фильтры + LIMIT/OFFSET под
// кнопку "Показать ещё" (фронт грузит порциями, без серверной пагинации).
router.get('/', async (req, res) => {
    try {
        const { fio, phone, sourceId, employeeId, funnelStatusId, limit, offset } = req.query;

        const conditions = [];
        const params = [];

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

        params.push(Number(limit) > 0 ? Number(limit) : 50);
        const limitIdx = params.length;
        params.push(Number(offset) > 0 ? Number(offset) : 0);
        const offsetIdx = params.length;

        const result = await pool.query(
            `${BASE_SELECT} ${whereClause} ORDER BY l.created_at DESC, l.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            params
        );
        res.json(result.rows.map(rowToLead));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список лидов' });
    }
});

// GET /api/leads-admin/stats — три цифры шапки страницы (всего / без
// оператора / за сегодня), считаются по ВСЕМ лидам, не по текущим фильтрам.
router.get('/stats', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE employee_id IS NULL)::int AS queue,
                count(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today
            FROM leads
        `);
        const row = result.rows[0];
        res.json({ total: row.total, queue: row.queue, today: row.today });
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
        const result = await pool.query(`${BASE_SELECT} WHERE l.id = $1`, [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        res.json(rowToLead(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить лида' });
    }
});

// POST /api/leads-admin — создание вручную. Обязателен только phone, дубль
// по телефону не блокирует (фронт заранее предупреждает через check-phone).
router.post('/', async (req, res) => {
    if (!req.body.phone || String(req.body.phone).trim() === '') {
        return res.status(400).json({ error: 'Заполните обязательное поле: Номер телефона' });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO leads (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const row = await pool.query(`${BASE_SELECT} WHERE l.id = $1`, [result.rows[0].id]);
        res.status(201).json(rowToLead(row.rows[0]));
    } catch (err) {
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать лида' });
    }
});

// PUT /api/leads-admin/:id — те же поля, без ограничения по employeeId
// (в отличие от routes/leads.js).
router.put('/:id', async (req, res) => {
    if (!req.body.phone || String(req.body.phone).trim() === '') {
        return res.status(400).json({ error: 'Заполните обязательное поле: Номер телефона' });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const row = await pool.query(`${BASE_SELECT} WHERE l.id = $1`, [result.rows[0].id]);
        res.json(rowToLead(row.rows[0]));
    } catch (err) {
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить лида' });
    }
});

// DELETE /api/leads-admin/:id — без ограничений.
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

// POST /api/leads-admin/bulk-import { sourceId, rows: [{lastName, firstName,
// middleName, phone}, ...] } — массовая загрузка (report_2026-08-01.md, п.3).
// Парсинг Excel/CSV — на фронте, сюда приходит уже готовый JSON. Каждая
// строка вставляется отдельным лидом со статусом "Новый", источником =
// sourceId на всю партию, employee_id = NULL. Дубли по телефону (внутри
// файла и против уже существующих лидов) не блокируют вставку — только
// помечаются в ответе. Вся вставка + автораспределение — одной транзакцией.
router.post('/bulk-import', async (req, res) => {
    const { sourceId, rows } = req.body;
    if (!sourceId) {
        return res.status(400).json({ error: 'Укажите источник для партии' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'Файл пуст или не содержит строк для загрузки' });
    }

    const client = await pool.connect();
    try {
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
                `INSERT INTO leads (last_name, first_name, middle_name, phone, source_id, funnel_status_id)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [
                    row.lastName ? String(row.lastName).trim() || null : null,
                    row.firstName ? String(row.firstName).trim() || null : null,
                    row.middleName ? String(row.middleName).trim() || null : null,
                    phone,
                    sourceId,
                    newStatusId
                ]
            );
            insertedIds.push(inserted.rows[0].id);
        }

        await distributePendingLeads(client);

        // Сколько именно из ЭТОЙ партии распределилось/осталось в очереди —
        // считаем по insertedIds отдельно, а не по возвращаемому значению
        // distributePendingLeads(): та разбирает ВСЮ зависшую очередь разом
        // (включая лидов из прошлых загрузок), поэтому её общее число не
        // равно доле именно этой партии.
        const batchStatus = await client.query(
            `SELECT count(*) FILTER (WHERE employee_id IS NOT NULL)::int AS assigned,
                    count(*) FILTER (WHERE employee_id IS NULL)::int AS queued
             FROM leads WHERE id = ANY($1)`,
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
        await client.query('ROLLBACK');
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось загрузить базу' });
    } finally {
        client.release();
    }
});

module.exports = router;
