// --- routes/operatorAuth.js: полноценный вход на страницу оператора ---
// В отличие от auth.js (лёгкая разовая проверка для настроек колонок), это
// полноценный логин перед всей страницей оператора — с проверкой status.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// POST /api/auth/operator-login — { email, password } → данные сотрудника (без пароля) или ошибка
router.post('/operator-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Введите email и пароль' });
        }

        const result = await pool.query(
            'SELECT id, last_name, first_name, middle_name, email, status, password FROM employees WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0 || result.rows[0].password !== password) {
            return res.status(401).json({ error: 'Неверный email или пароль' });
        }

        const employee = result.rows[0];
        if (employee.status !== 'active') {
            return res.status(403).json({ error: 'Доступ заблокирован — обратитесь к руководителю' });
        }

        res.json({
            id: employee.id,
            fullName: `${employee.last_name} ${employee.first_name}`,
            email: employee.email
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось выполнить вход' });
    }
});

module.exports = router;
