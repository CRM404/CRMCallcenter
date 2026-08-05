// --- routes/scripts.js: дерево скрипта звонка (только чтение, для страницы оператора) ---
// Один скрипт может быть назначен сразу нескольким операторам (см. routes/scriptsAdmin.js) —
// отдаётся ровно тот, что назначен конкретному оператору через employees.script_id.
// Если оператору ничего не назначено — 404 (нет общего скрипта "по умолчанию").

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/scripts?employeeId=... — скрипт, назначенный оператору, + все его узлы
router.get('/', async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        const scriptResult = await pool.query(
            `SELECT s.id, s.title
             FROM scripts s
             JOIN employees e ON e.script_id = s.id
             WHERE e.id = $1`,
            [employeeId]
        );
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
