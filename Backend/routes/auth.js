// --- routes/auth.js: лёгкая проверка личности (для настроек колонок, не полноценный логин) ---

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// POST /api/auth/verify-employee — { employeeId, password } → { fullName } или 401
router.post('/verify-employee', async (req, res) => {
    try {
        const { employeeId, password } = req.body;
        if (!employeeId || !password) {
            return res.status(400).json({ error: 'Выберите сотрудника и введите пароль' });
        }

        const result = await pool.query(
            'SELECT last_name, first_name, password FROM employees WHERE id = $1',
            [employeeId]
        );

        if (result.rows.length === 0 || result.rows[0].password !== password) {
            return res.status(401).json({ error: 'Неверный пароль' });
        }

        const { last_name, first_name } = result.rows[0];
        res.json({ fullName: `${last_name} ${first_name}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось проверить личность' });
    }
});

module.exports = router;
