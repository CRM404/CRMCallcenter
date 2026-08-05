// --- routes/scripts.js: дерево скрипта звонка (только чтение, для страницы оператора) ---
// Может существовать несколько скриптов-черновиков (см. routes/scriptsAdmin.js),
// но оператору всегда отдаётся ровно один — со status='active'.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/scripts — активный скрипт + все его узлы
router.get('/', async (req, res) => {
    try {
        const scriptResult = await pool.query("SELECT id, title FROM scripts WHERE status = 'active' LIMIT 1");
        if (scriptResult.rows.length === 0) {
            return res.status(404).json({ error: 'Скрипт не найден' });
        }
        const script = scriptResult.rows[0];

        const nodesResult = await pool.query(
            'SELECT id, parent_id, node_type, label, content, sort_order FROM script_nodes WHERE script_id = $1 ORDER BY sort_order',
            [script.id]
        );

        res.json({
            id: script.id,
            title: script.title,
            nodes: nodesResult.rows.map(r => ({
                id: r.id,
                parentId: r.parent_id,
                nodeType: r.node_type,
                label: r.label,
                content: r.content,
                sortOrder: r.sort_order
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить скрипт' });
    }
});

module.exports = router;
