// --- routes/sources.js: CRUD для "Источников" — дочерняя сущность площадки
// (страница «Источники», report_2026-08-01.md, 11.08.2026). Источник -> ровно
// одна площадка (platform_id, простой FK), но несколько CPA-сетей (M:N через
// source_cpa_networks) — та же механика пересборки связки целиком
// (delete+insert в транзакции), что уже есть у real_estate_offer_segments/
// _geo/_payment_methods (routes/realEstateOffers.js).

const express = require('express');
const { pool } = require('../db');
const guards = require('../services/deleteGuards');

const router = express.Router();

const STATUS_VALUES = ['Активен', 'Неактивен', 'Архив', 'Актуализация'];

// array_agg с FILTER — иначе LEFT JOIN на источник без единой CPA-сети (не
// должно происходить при валидных данных, но на всякий случай) дал бы
// массив [NULL] вместо пустого '{}'.
// leads_count — сколько лидов ссылается на источник. Нужен подтверждению
// удаления: правило проекта «подтверждение называет не только объект, но и
// последствия», а последствие здесь — лиды, которые останутся в системе без
// источника (leads.source_id объявлен ON DELETE SET NULL). Без числа правило
// невыполнимо, и окно говорило только «Это необратимо» (К132).
//
// Счёт идёт ОДНИМ агрегатом в подзапросе, а не коррелированным подзапросом на
// каждую строку: индекса на leads.source_id нет, и на списке из сотни
// источников это была бы сотня проходов по таблице лидов.
const BASE_SELECT = `
    SELECT s.*, p.name AS platform_name,
           COALESCE(lc.c, 0) AS leads_count,
           COALESCE(array_agg(cn.id ORDER BY cn.name) FILTER (WHERE cn.id IS NOT NULL), '{}') AS cpa_network_ids,
           COALESCE(array_agg(cn.name ORDER BY cn.name) FILTER (WHERE cn.id IS NOT NULL), '{}') AS cpa_network_names
    FROM sources s
    JOIN ad_platforms p ON p.id = s.platform_id
    LEFT JOIN (
        SELECT source_id, count(*)::int AS c FROM leads WHERE source_id IS NOT NULL GROUP BY source_id
    ) lc ON lc.source_id = s.id
    LEFT JOIN source_cpa_networks scn ON scn.source_id = s.id
    LEFT JOIN cpa_networks cn ON cn.id = scn.cpa_network_id
`;

// GROUP BY основного запроса. lc.c обязан быть здесь: функциональную
// зависимость от первичного ключа Postgres применяет только к таблице, чей
// ключ сгруппирован, а lc — подзапрос.
const BASE_GROUP_BY = 'GROUP BY s.id, p.name, lc.c';

function rowToSource(row) {
    return {
        id: row.id,
        platformId: row.platform_id,
        platformName: row.platform_name,
        rootSource: row.root_source,
        leadSource: row.lead_source,
        cityRegion: row.city_region,
        status: row.status,
        leadsCount: row.leads_count === undefined || row.leads_count === null ? 0 : Number(row.leads_count),
        cpaNetworkIds: row.cpa_network_ids,
        cpaNetworkNames: row.cpa_network_names,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function validateBody(body) {
    if (body.platformId === undefined || body.platformId === null || String(body.platformId).trim() === '') {
        return 'Заполните обязательное поле: Площадка';
    }
    if (!body.rootSource || String(body.rootSource).trim() === '') {
        return 'Заполните обязательное поле: Корневой источник';
    }
    if (!body.leadSource || String(body.leadSource).trim() === '') {
        return 'Заполните обязательное поле: Источник лидов';
    }
    if (!body.cityRegion || String(body.cityRegion).trim() === '') {
        return 'Заполните обязательное поле: Город/Регион';
    }
    if (!STATUS_VALUES.includes(body.status)) {
        return `Статус должен быть одним из: ${STATUS_VALUES.join(', ')}`;
    }
    if (!Array.isArray(body.cpaNetworkIds) || body.cpaNetworkIds.length === 0) {
        // Текст совпадает с клиентским ДОСЛОВНО (К145): расхождение
        // («Укажите» на сервере против «Выберите» на клиенте) читается как две
        // разные ошибки.
        return 'Выберите хотя бы одну CPA-сеть.';
    }
    return null;
}

async function fetchSourceById(id) {
    const result = await pool.query(`${BASE_SELECT} WHERE s.id = $1 ${BASE_GROUP_BY}`, [id]);
    return result.rows[0] || null;
}

async function replaceCpaNetworks(client, sourceId, cpaNetworkIds) {
    await client.query('DELETE FROM source_cpa_networks WHERE source_id = $1', [sourceId]);
    for (const cpaNetworkId of cpaNetworkIds) {
        await client.query(
            'INSERT INTO source_cpa_networks (source_id, cpa_network_id) VALUES ($1, $2)',
            [sourceId, cpaNetworkId]
        );
    }
}

function handleFkError(err, res) {
    if (err.code !== '23503') return false;
    if (err.constraint === 'sources_platform_id_fkey') {
        res.status(400).json({ error: 'Указанная площадка не найдена' });
        return true;
    }
    if (err.constraint === 'source_cpa_networks_cpa_network_id_fkey') {
        res.status(400).json({ error: 'Указанная CPA-сеть не найдена' });
        return true;
    }
    return false;
}

// GET /api/sources?platformId=X — источники одной площадки (обычный режим,
// открытая вкладка). GET /api/sources?search=текст — кросс-площадочный режим:
// игнорирует platformId, ищет по всем источникам сразу по всем полям
// (название, площадка, CPA-сети, город/регион, статус). GET /api/sources без
// параметров — плоский список ВСЕХ источников (нужен странице «Лиды» для
// выпадающего списка «Источник», report_2026-08-01.md, 13.08.2026).
router.get('/', async (req, res) => {
    try {
        const { platformId, search } = req.query;
        const q = (search || '').trim();
        let where;
        let params;
        if (q) {
            params = [`%${q}%`];
            where = `WHERE (
                s.root_source ILIKE $1 OR s.lead_source ILIKE $1 OR p.name ILIKE $1 OR s.city_region ILIKE $1 OR s.status ILIKE $1
                OR EXISTS (
                    SELECT 1 FROM source_cpa_networks scn2
                    JOIN cpa_networks cn2 ON cn2.id = scn2.cpa_network_id
                    WHERE scn2.source_id = s.id AND cn2.name ILIKE $1
                )
            )`;
        } else if (platformId) {
            params = [platformId];
            where = 'WHERE s.platform_id = $1';
        } else {
            params = [];
            where = '';
        }
        const result = await pool.query(`${BASE_SELECT} ${where} ${BASE_GROUP_BY} ORDER BY s.id`, params);
        res.json(result.rows.map(rowToSource));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список источников' });
    }
});

// GET /api/sources/:id
router.get('/:id', async (req, res) => {
    try {
        const row = await fetchSourceById(req.params.id);
        if (!row) {
            return res.status(404).json({ error: 'Источник не найден' });
        }
        res.json(rowToSource(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить источник' });
    }
});

// POST /api/sources — создание источника + связки CPA-сетей одной транзакцией
router.post('/', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertResult = await client.query(
            `INSERT INTO sources (platform_id, root_source, lead_source, city_region, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [req.body.platformId, req.body.rootSource.trim(), req.body.leadSource.trim(), req.body.cityRegion.trim(), req.body.status]
        );
        const sourceId = insertResult.rows[0].id;
        await replaceCpaNetworks(client, sourceId, req.body.cpaNetworkIds);
        await client.query('COMMIT');
        res.status(201).json(rowToSource(await fetchSourceById(sourceId)));
    } catch (err) {
        await client.query('ROLLBACK');
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать источник' });
    } finally {
        client.release();
    }
});

// PUT /api/sources/:id — та же валидация, связку CPA-сетей пересобираем целиком
router.put('/:id', async (req, res) => {
    const validationError = validateBody(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE sources SET platform_id = $1, root_source = $2, lead_source = $3, city_region = $4, status = $5, updated_at = NOW() WHERE id = $6 RETURNING id`,
            [req.body.platformId, req.body.rootSource.trim(), req.body.leadSource.trim(), req.body.cityRegion.trim(), req.body.status, req.params.id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Источник не найден' });
        }
        const sourceId = result.rows[0].id;
        await replaceCpaNetworks(client, sourceId, req.body.cpaNetworkIds);
        await client.query('COMMIT');
        res.json(rowToSource(await fetchSourceById(sourceId)));
    } catch (err) {
        await client.query('ROLLBACK');
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    } finally {
        client.release();
    }
});

// DELETE /api/sources/:id — порядок плана 11.4, «Источник».
//
// Шаг 1 — есть лиды с этим источником? Запрещено. План отмечает это словами
// «сейчас молча обнуляется», и так оно и было: leads.source_id объявлен
// ON DELETE SET NULL, поэтому удаление источника стирало у лидов, откуда они
// пришли. Для лидов, купленных за деньги, это потеря учёта, а не мелочь.
// Связь оставлена обнуляющей по тому же доводу, что у скрипта: запрет живёт в
// маршруте, где его объясняют, а SET NULL страхует удаление мимо маршрута.
//
// Шаг 2 — связи с CPA-сетями удаляются ЯВНО. Раньше они уходили каскадом;
// теперь source_cpa_networks → sources переведена в запрет (класс Б), и без
// явного удаления источник не удалился бы вовсе.
//
// Шаг 3 — сам источник.
router.delete('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const blockers = guards.orderBlockers([
            await guards.countBlocker(pool, 'leads',
                `FROM leads l WHERE l.source_id = $1 ORDER BY l.id`, [id])
        ]);
        if (blockers.length > 0) return guards.refuse(res, blockers);

        const found = await pool.query('SELECT root_source, city_region FROM sources WHERE id = $1', [id]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Источник не найден' });
        }
        const title = [found.rows[0].root_source, found.rows[0].city_region].filter(Boolean).join(' · ');
        const removed = await guards.deleteAsBatch(
            pool, `Удаление источника «${title}»`, async (client) => {
                await client.query('DELETE FROM source_cpa_networks WHERE source_id = $1', [id]);
                return client.query('DELETE FROM sources WHERE id = $1 RETURNING id', [id]);
            });
        if (removed.rows.length === 0) {
            return res.status(404).json({ error: 'Источник не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить источник' });
    }
});

module.exports = router;
