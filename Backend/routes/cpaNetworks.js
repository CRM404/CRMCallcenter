// --- routes/cpaNetworks.js: CRUD для справочника CPA-сетей (партнёров, которым
// организация передаёт лиды дальше) — обычный список записей, как employees.js,
// не singleton, как organization.js.

const express = require('express');
const { pool } = require('../db');
const guards = require('../services/deleteGuards');

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

// offersCount и sourcesCount приходят вместе с сетью, а не отдельными
// запросами: оба числа нужны разделу на КАЖДОЙ строке списка — первое стоит в
// подписи сети и в подтверждении удаления («вместе с ней удалятся её офферы»),
// второе гасит саму кнопку удаления заранее, пока на сеть ссылаются источники
// (К77). Без них раздел либо предлагал бы действие, которое сервер обязан
// отбить, либо ходил бы на сервер по разу на сеть.
function rowToCpaNetwork(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name || null,
        name: row.name,
        status: row.status,
        connectedAt: row.connected_at,
        payoutCurrency: row.payout_currency,
        commissionPercent: row.commission_percent,
        offersCount: row.offers_count === undefined ? 0 : Number(row.offers_count),
        sourcesCount: row.sources_count === undefined ? 0 : Number(row.sources_count)
    };
}

// Одна выборка на список и на одиночную запись: разошедшиеся SELECT'ы — это
// поле, которое есть в списке и пропадает после сохранения.
const BASE_SELECT = `
    SELECT c.*, o.name AS organization_name,
           COALESCE(off.c, 0) AS offers_count,
           COALESCE(src.c, 0) AS sources_count
    FROM cpa_networks c
    LEFT JOIN organizations o ON o.id = c.organization_id
    LEFT JOIN (
        SELECT network_id, count(*)::int AS c FROM real_estate_offers GROUP BY network_id
    ) off ON off.network_id = c.id
    LEFT JOIN (
        SELECT cpa_network_id, count(*)::int AS c FROM source_cpa_networks GROUP BY cpa_network_id
    ) src ON src.cpa_network_id = c.id
`;

async function fetchCpaNetworkWithOrganization(id) {
    const result = await pool.query(`${BASE_SELECT} WHERE c.id = $1`, [id]);
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
        const result = await pool.query(`${BASE_SELECT} ORDER BY c.id`);
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

// DELETE /api/cpa-networks/:id — порядок плана 11.4, «CPA-сеть».
//
// ЭТО САМАЯ ГРОМКАЯ ИЗ ТРЁХ МОЛЧАЛИВЫХ ЦЕПОЧЕК плана 11.1. До части 5 одно
// нажатие сносило сеть, все её объекты недвижимости, у каждого — сегменты,
// географию, способы оплаты и виды ипотеки, и связи объектов с лидами. Три
// уровня вглубь, и человек об этом не узнавал.
//
// Теперь связь real_estate_offers → cpa_networks запрещающая (класс Б), и
// каталог сам по себе уже не пропадёт. Но голый отказ базы читается как
// «нарушение ограничения внешнего ключа», поэтому маршрут проверяет помехи
// сам и называет их числами.
//
// Шаг 1 — связи объектов сети с лидами. Проверяются ДО источников намеренно:
// подобранный объект дороже связки с источником, и человек должен увидеть
// сначала то, что тяжелее (порядок помех в deleteGuards).
// Шаг 2 — источники.
// Шаг 3 — объекты сети поштучно; сегменты, гео, оплата и ипотеки уходят
// каскадом как части целого (класс А).
// Шаг 4 — сама сеть.
router.delete('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const blockers = guards.orderBlockers([
            await guards.countBlocker(pool, 'leads',
                `FROM leads l
                  WHERE EXISTS (SELECT 1 FROM lead_offers lo
                                  JOIN real_estate_offers o ON o.id = lo.offer_id
                                 WHERE lo.lead_id = l.id AND o.network_id = $1)
                  ORDER BY l.id`, [id]),
            await guards.countBlocker(pool, 'sources',
                `FROM sources s
                  WHERE EXISTS (SELECT 1 FROM source_cpa_networks sc
                                 WHERE sc.source_id = s.id AND sc.cpa_network_id = $1)
                  ORDER BY s.id`, [id])
        ]);
        if (blockers.length > 0) return guards.refuse(res, blockers);

        const found = await pool.query('SELECT name FROM cpa_networks WHERE id = $1', [id]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'CPA-сеть не найдена' });
        }

        const removed = await guards.deleteAsBatch(
            pool, `Удаление CPA-сети «${found.rows[0].name}»`, async (client) => {
                // Поштучно, а не одним DELETE ... WHERE network_id: так каждый
                // объект попадает в журнал отдельной записью со своим
                // содержимым, и восстановить можно любой из них по одному.
                const offers = await client.query(
                    'SELECT id FROM real_estate_offers WHERE network_id = $1 ORDER BY id', [id]);
                for (const offer of offers.rows) {
                    await client.query('DELETE FROM real_estate_offers WHERE id = $1', [offer.id]);
                }
                const gone = await client.query('DELETE FROM cpa_networks WHERE id = $1 RETURNING id', [id]);
                return { offers: offers.rows.length, network: gone.rows.length };
            });
        if (removed.network === 0) {
            return res.status(404).json({ error: 'CPA-сеть не найдена' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить CPA-сеть' });
    }
});

module.exports = router;
