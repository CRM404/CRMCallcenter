// --- routes/scriptsAdmin.js: наполнение/редактирование скрипта звонка (для руководителя) ---
// Без отдельного логина на этой итерации — как и "Сотрудники" (решение куратора,
// 2026-08-05: полноценный логин по ролям — это будущее единое админ-меню).

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function rowToScript(row) {
    return {
        id: row.id,
        title: row.title,
        status: row.status,
        offerId: row.offer_id,
        offerName: row.offer_name || null,
        assignedCount: row.assigned_count === undefined ? null : Number(row.assigned_count)
    };
}

function rowToNode(row) {
    return {
        id: row.id,
        scriptId: row.script_id,
        parentId: row.parent_id,
        nodeType: row.node_type,
        label: row.label,
        content: row.content,
        sortOrder: row.sort_order
    };
}

async function fetchScriptById(id) {
    const result = await pool.query(
        `SELECT s.*, o.name AS offer_name
         FROM scripts s
         LEFT JOIN offers o ON s.offer_id = o.id
         WHERE s.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

// Поднимается по цепочке parent_id от startNodeId — true, если где-то по пути встретился targetId.
async function isDescendantChain(startNodeId, targetId) {
    let currentId = startNodeId;
    const visited = new Set();
    while (currentId !== null && currentId !== undefined) {
        if (currentId === targetId) return true;
        if (visited.has(currentId)) return false; // защита от уже существующего цикла в данных
        visited.add(currentId);
        const result = await pool.query('SELECT parent_id FROM script_nodes WHERE id = $1', [currentId]);
        if (result.rows.length === 0) return false;
        currentId = result.rows[0].parent_id;
    }
    return false;
}

// GET /api/admin/scripts — список всех скриптов (черновики + активные)
router.get('/scripts', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*, o.name AS offer_name,
                    (SELECT count(*)::int FROM employees e WHERE e.script_id = s.id) AS assigned_count
             FROM scripts s
             LEFT JOIN offers o ON s.offer_id = o.id
             ORDER BY s.id`
        );
        res.json(result.rows.map(rowToScript));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список скриптов' });
    }
});

// POST /api/admin/scripts — создать новый скрипт (черновик)
router.post('/scripts', async (req, res) => {
    try {
        const { title, offerId } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: 'Укажите название скрипта' });
        }
        const result = await pool.query(
            'INSERT INTO scripts (title, status, offer_id) VALUES ($1, $2, $3) RETURNING id',
            [title.trim(), 'draft', offerId || null]
        );
        const row = await fetchScriptById(result.rows[0].id);
        res.status(201).json(rowToScript(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать скрипт' });
    }
});

// PUT /api/admin/scripts/:id — изменить title/status/offerId.
// Несколько скриптов могут быть 'active' одновременно (каждый под своих
// назначенных операторов) — здесь нет переключения других скриптов в draft.
router.put('/scripts/:id', async (req, res) => {
    const { title, status, offerId } = req.body;
    if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'Укажите название скрипта' });
    }
    if (status !== 'draft' && status !== 'active') {
        return res.status(400).json({ error: 'Недопустимый статус' });
    }

    try {
        const existing = await pool.query('SELECT id FROM scripts WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Скрипт не найден' });
        }

        if (status === 'active') {
            const nodeCount = await pool.query('SELECT count(*)::int AS c FROM script_nodes WHERE script_id = $1', [req.params.id]);
            if (nodeCount.rows[0].c === 0) {
                return res.status(400).json({ error: 'Нельзя активировать пустой скрипт — добавьте хотя бы один узел' });
            }
        }

        await pool.query(
            'UPDATE scripts SET title = $1, status = $2, offer_id = $3 WHERE id = $4',
            [title.trim(), status, offerId || null, req.params.id]
        );

        const row = await fetchScriptById(req.params.id);
        res.json(rowToScript(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить скрипт' });
    }
});

// DELETE /api/admin/scripts/:id — удалить скрипт целиком (каскадно удалит узлы).
// Заблокировано, если скрипт сейчас назначен хотя бы одному оператору
// (employees.script_id) — статус здесь ни при чём, важно только назначение.
router.delete('/scripts/:id', async (req, res) => {
    try {
        const existing = await pool.query('SELECT id FROM scripts WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Скрипт не найден' });
        }
        const assigned = await pool.query('SELECT count(*)::int AS c FROM employees WHERE script_id = $1', [req.params.id]);
        if (assigned.rows[0].c > 0) {
            return res.status(400).json({ error: 'Скрипт назначен операторам, снимите назначение' });
        }
        await pool.query('DELETE FROM scripts WHERE id = $1', [req.params.id]);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить скрипт' });
    }
});

// GET /api/admin/offers — список офферов (для выпадающего списка)
router.get('/offers', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name FROM offers ORDER BY name');
        res.json(result.rows.map((r) => ({ id: r.id, name: r.name })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список офферов' });
    }
});

// POST /api/admin/offers — создать оффер (справочник совсем новый и пустой)
router.post('/offers', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'Укажите название оффера' });
        }
        const result = await pool.query('INSERT INTO offers (name) VALUES ($1) RETURNING id, name', [name.trim()]);
        res.status(201).json({ id: result.rows[0].id, name: result.rows[0].name });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать оффер' });
    }
});

// PUT /api/admin/employees/:employeeId/script — назначить/снять скрипт оператору.
// { scriptId } или { scriptId: null } для снятия назначения. Нельзя назначить
// черновик — только скрипт со status='active'.
router.put('/employees/:employeeId/script', async (req, res) => {
    try {
        const { scriptId } = req.body;

        if (scriptId === null || scriptId === undefined || scriptId === '') {
            const result = await pool.query(
                'UPDATE employees SET script_id = NULL WHERE id = $1 RETURNING id',
                [req.params.employeeId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Сотрудник не найден' });
            }
            return res.json({ employeeId: Number(req.params.employeeId), scriptId: null });
        }

        const script = await pool.query('SELECT status FROM scripts WHERE id = $1', [scriptId]);
        if (script.rows.length === 0) {
            return res.status(400).json({ error: 'Скрипт не найден' });
        }
        if (script.rows[0].status !== 'active') {
            return res.status(400).json({ error: 'Нельзя назначить черновик — сначала активируйте скрипт' });
        }

        const result = await pool.query(
            'UPDATE employees SET script_id = $1 WHERE id = $2 RETURNING id',
            [scriptId, req.params.employeeId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        res.json({ employeeId: Number(req.params.employeeId), scriptId: Number(scriptId) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось назначить скрипт' });
    }
});

// GET /api/admin/scripts/:id/nodes — плоский список узлов скрипта (дерево строит фронт)
router.get('/scripts/:id/nodes', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM script_nodes WHERE script_id = $1 ORDER BY sort_order',
            [req.params.id]
        );
        res.json(result.rows.map(rowToNode));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить узлы скрипта' });
    }
});

// POST /api/admin/scripts/:id/nodes — добавить узел
router.post('/scripts/:id/nodes', async (req, res) => {
    try {
        const { parentId, nodeType, label, content, sortOrder } = req.body;
        if (!content || !String(content).trim()) {
            return res.status(400).json({ error: 'Укажите текст узла' });
        }
        if (nodeType !== 'statement' && nodeType !== 'objection') {
            return res.status(400).json({ error: 'Недопустимый тип узла' });
        }

        const normalizedParentId = parentId === undefined || parentId === null || parentId === '' ? null : Number(parentId);

        if (normalizedParentId === null) {
            const rootExists = await pool.query(
                'SELECT id FROM script_nodes WHERE script_id = $1 AND parent_id IS NULL',
                [req.params.id]
            );
            if (rootExists.rows.length > 0) {
                return res.status(400).json({ error: 'У скрипта уже есть корневой узел' });
            }
        }

        const result = await pool.query(
            `INSERT INTO script_nodes (script_id, parent_id, node_type, label, content, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.params.id, normalizedParentId, nodeType, label || null, content.trim(), sortOrder || 0]
        );
        res.status(201).json(rowToNode(result.rows[0]));
    } catch (err) {
        if (err.code === '23503') {
            if (err.constraint === 'script_nodes_script_id_fkey') {
                return res.status(404).json({ error: 'Скрипт не найден' });
            }
            return res.status(400).json({ error: 'Указан несуществующий родительский узел' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось добавить узел' });
    }
});

// PUT /api/admin/script-nodes/:id — редактировать узел
router.put('/script-nodes/:id', async (req, res) => {
    try {
        const nodeId = Number(req.params.id);
        const existing = await pool.query('SELECT * FROM script_nodes WHERE id = $1', [nodeId]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Узел не найден' });
        }
        const current = existing.rows[0];

        const { parentId, nodeType, label, content, sortOrder } = req.body;
        if (!content || !String(content).trim()) {
            return res.status(400).json({ error: 'Укажите текст узла' });
        }
        if (nodeType !== 'statement' && nodeType !== 'objection') {
            return res.status(400).json({ error: 'Недопустимый тип узла' });
        }

        const normalizedParentId = parentId === undefined || parentId === null || parentId === '' ? null : Number(parentId);

        if (normalizedParentId === nodeId) {
            return res.status(400).json({ error: 'Узел не может быть родителем самому себе' });
        }

        if (normalizedParentId === null) {
            if (current.parent_id !== null) {
                const rootExists = await pool.query(
                    'SELECT id FROM script_nodes WHERE script_id = $1 AND parent_id IS NULL AND id <> $2',
                    [current.script_id, nodeId]
                );
                if (rootExists.rows.length > 0) {
                    return res.status(400).json({ error: 'У скрипта уже есть корневой узел' });
                }
            }
        } else {
            const parentRow = await pool.query('SELECT script_id FROM script_nodes WHERE id = $1', [normalizedParentId]);
            if (parentRow.rows.length === 0) {
                return res.status(400).json({ error: 'Указан несуществующий родительский узел' });
            }
            if (parentRow.rows[0].script_id !== current.script_id) {
                return res.status(400).json({ error: 'Родительский узел принадлежит другому скрипту' });
            }
            const wouldCycle = await isDescendantChain(normalizedParentId, nodeId);
            if (wouldCycle) {
                return res.status(400).json({ error: 'Нельзя назначить родителем один из дочерних узлов — получится цикл' });
            }
        }

        const result = await pool.query(
            `UPDATE script_nodes SET parent_id = $1, node_type = $2, label = $3, content = $4, sort_order = $5
             WHERE id = $6 RETURNING *`,
            [normalizedParentId, nodeType, label || null, content.trim(), sortOrder || 0, nodeId]
        );
        res.json(rowToNode(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить узел' });
    }
});

// DELETE /api/admin/script-nodes/:id — удалить узел (каскадно удалит дочерние)
router.delete('/script-nodes/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM script_nodes WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Узел не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить узел' });
    }
});

module.exports = router;
