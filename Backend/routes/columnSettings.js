// --- routes/columnSettings.js: персональные настройки видимых колонок таблицы сотрудников ---

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /api/employees/column-settings/:employeeId — { hiddenColumns: [...] }, дефолт [] (всё видимо)
router.get('/employees/column-settings/:employeeId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT hidden_columns FROM employee_column_settings WHERE employee_id = $1',
            [req.params.employeeId]
        );
        const hiddenColumns = result.rows.length > 0 ? result.rows[0].hidden_columns : [];
        res.json({ hiddenColumns });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить настройки колонок' });
    }
});

// PUT /api/employees/column-settings/:employeeId — { hiddenColumns: [...] }, upsert
router.put('/employees/column-settings/:employeeId', async (req, res) => {
    try {
        const hiddenColumns = Array.isArray(req.body.hiddenColumns) ? req.body.hiddenColumns : [];
        await pool.query(
            `INSERT INTO employee_column_settings (employee_id, hidden_columns, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (employee_id)
             DO UPDATE SET hidden_columns = EXCLUDED.hidden_columns, updated_at = NOW()`,
            [req.params.employeeId, JSON.stringify(hiddenColumns)]
        );
        res.json({ hiddenColumns });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить настройки колонок' });
    }
});

module.exports = router;
