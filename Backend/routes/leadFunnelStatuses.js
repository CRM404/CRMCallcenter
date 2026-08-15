// --- routes/leadFunnelStatuses.js: справочник статусов/этапов воронки лида (только чтение) ---

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/lead-funnel-statuses — полный список, для группировки по этапу на фронте.
// С 15.08.2026 отдаются и признаки поведения статуса: по requiresCallTime форма
// оператора раскрывает выбор даты и времени перезвона, по autoRecall помечает
// статус в списке («— автоперезвон»), чтобы оператор понимал, что лид вернётся
// сам. Сравнений по названию статуса на клиенте нет и быть не должно.
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, stage_number, stage_name, status_name, sort_order,
                    auto_recall, requires_call_time, releases_lead
             FROM lead_funnel_statuses ORDER BY stage_number, sort_order`
        );
        res.json(result.rows.map(r => ({
            id: r.id,
            stageNumber: r.stage_number,
            stageName: r.stage_name,
            statusName: r.status_name,
            sortOrder: r.sort_order,
            autoRecall: r.auto_recall,
            requiresCallTime: r.requires_call_time,
            releasesLead: r.releases_lead
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список статусов воронки' });
    }
});

module.exports = router;
