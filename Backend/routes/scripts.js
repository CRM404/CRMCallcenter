// --- routes/scripts.js: подбор скрипта звонка для карточки лида (страница оператора) ---
// Скрипт привязан только к оператору (employee_scripts), без оффера/статуса
// воронки лида — окончательное решение владельца (09.08.2026), не временный
// обход (см. schema.sql — offer_id/funnel_status_id убраны из scripts).
// Если оператору назначено несколько скриптов (employee_scripts — многие-ко-многим,
// "разные линии") — берём первый по id; это заведомо не то, что нужно для
// мультискриптовых операторов, доработка подбора — отдельная будущая задача.
// Совпадений может не быть — это нормальное состояние ("для этого статуса
// скрипт не назначен"), не ошибка: тело ответа в этом случае — null с кодом
// 200. 404 зарезервирован строго за случаем "такого лида не существует".

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/scripts?employeeId=&leadId= — скрипт, назначенный employeeId, + все
// его узлы. null, если оператору ничего не назначено.
router.get('/', async (req, res) => {
    try {
        const { employeeId, leadId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        if (!leadId) {
            return res.status(400).json({ error: 'Не передан leadId' });
        }

        const leadResult = await pool.query('SELECT id FROM leads WHERE id = $1', [leadId]);
        if (leadResult.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }

        const scriptResult = await pool.query(
            `SELECT s.id, s.title
             FROM scripts s
             JOIN employee_scripts es ON es.script_id = s.id
             WHERE es.employee_id = $1
             ORDER BY s.id
             LIMIT 1`,
            [employeeId]
        );
        if (scriptResult.rows.length === 0) {
            return res.json(null);
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
