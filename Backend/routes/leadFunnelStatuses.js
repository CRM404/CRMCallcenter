// --- routes/leadFunnelStatuses.js: справочник статусов/этапов воронки лида (только чтение) ---

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/lead-funnel-statuses — полный список, для группировки по этапу на фронте
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, stage_number, stage_name, status_name, sort_order FROM lead_funnel_statuses ORDER BY stage_number, sort_order'
        );
        res.json(result.rows.map(r => ({
            id: r.id,
            stageNumber: r.stage_number,
            stageName: r.stage_name,
            statusName: r.status_name,
            sortOrder: r.sort_order
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список статусов воронки' });
    }
});

module.exports = router;
