// --- routes/paramLists.js: «Настройка списков» — 11 управляемых справочников
// формы оффера недвижимости (report_2026-08-01.md, Фаза 2, 07.08.2026).
// Одна общая таблица param_lists на все 11 списков (архитектурное решение
// куратора — списки структурно одинаковы, отдельные таблицы дали бы
// 11-кратный дублирующийся CRUD без пользы). «Статус» сюда намеренно не
// входит — от него зависит цвет бейджа/логика фильтра в таблице офферов.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const LIST_KEYS = [
    'category', 'actionType', 'leadCheck', 'objType', 'objClass', 'finish',
    'rooms', 'clientType', 'purchaseTerm', 'paymentMethod', 'mortgageType'
];

function validateKey(key) {
    return LIST_KEYS.includes(key);
}

// GET /api/param-lists — { category: [...], actionType: [...], ... }, каждый
// список отсортирован по sort_order, значения — плоский массив строк (id не
// нужен фронту, нужен только backend'у для DELETE по (list_key, value)).
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT list_key, value FROM param_lists ORDER BY list_key, sort_order'
        );
        const lists = {};
        for (const key of LIST_KEYS) lists[key] = [];
        for (const row of result.rows) {
            if (lists[row.list_key]) lists[row.list_key].push(row.value);
        }
        res.json(lists);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить списки значений' });
    }
});

// POST /api/param-lists/:key { value } — добавление значения в конец списка
router.post('/:key', async (req, res) => {
    const { key } = req.params;
    if (!validateKey(key)) {
        return res.status(400).json({ error: 'Неизвестный список' });
    }
    const value = req.body.value === undefined || req.body.value === null ? '' : String(req.body.value).trim();
    if (!value) {
        return res.status(400).json({ error: 'Укажите значение' });
    }
    try {
        const existing = await pool.query('SELECT value FROM param_lists WHERE list_key = $1', [key]);
        if (existing.rows.some((r) => r.value.toLowerCase() === value.toLowerCase())) {
            return res.status(400).json({ error: 'Такое значение уже есть в списке' });
        }
        const maxResult = await pool.query(
            'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM param_lists WHERE list_key = $1',
            [key]
        );
        const sortOrder = Number(maxResult.rows[0].max_order) + 1;
        await pool.query(
            'INSERT INTO param_lists (list_key, value, sort_order) VALUES ($1, $2, $3)',
            [key, value, sortOrder]
        );
        res.status(201).json({ key, value });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось добавить значение' });
    }
});

// DELETE /api/param-lists/:key/:value — удаление значения; уже сохранённые
// офферы, использующие это значение, не трогаются (та же логика, что и
// сейчас у обычных VARCHAR-полей вроде client_type).
router.delete('/:key/:value', async (req, res) => {
    const { key, value } = req.params;
    if (!validateKey(key)) {
        return res.status(400).json({ error: 'Неизвестный список' });
    }
    try {
        const result = await pool.query(
            'DELETE FROM param_lists WHERE list_key = $1 AND value = $2 RETURNING id',
            [key, value]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Значение не найдено' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить значение' });
    }
});

module.exports = router;
