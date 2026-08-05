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
        employeeId: row.employee_id,
        authorName: row.last_name ? `${row.last_name} ${row.first_name}` : null
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
        `SELECT s.*, e.last_name, e.first_name
         FROM scripts s
         LEFT JOIN employees e ON s.employee_id = e.id
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

// GET /api/admin/scripts — список всех скриптов (черновики + активный)
router.get('/scripts', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*, e.last_name, e.first_name
             FROM scripts s
             LEFT JOIN employees e ON s.employee_id = e.id
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
        const { title, employeeId } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: 'Укажите название скрипта' });
        }
        const result = await pool.query(
            'INSERT INTO scripts (title, status, employee_id) VALUES ($1, $2, $3) RETURNING id',
            [title.trim(), 'draft', employeeId || null]
        );
        const row = await fetchScriptById(result.rows[0].id);
        res.status(201).json(rowToScript(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать скрипт' });
    }
});

// PUT /api/admin/scripts/:id — изменить title/status/employeeId
// Активация ('status' -> 'active'): предыдущий активный автоматически становится
// draft, в одной транзакции — не должно быть момента с двумя активными или без него.
router.put('/scripts/:id', async (req, res) => {
    const { title, status, employeeId } = req.body;
    if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'Укажите название скрипта' });
    }
    if (status !== 'draft' && status !== 'active') {
        return res.status(400).json({ error: 'Недопустимый статус' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query('SELECT id FROM scripts WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Скрипт не найден' });
        }

        if (status === 'active') {
            const nodeCount = await client.query('SELECT count(*)::int AS c FROM script_nodes WHERE script_id = $1', [req.params.id]);
            if (nodeCount.rows[0].c === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Нельзя активировать пустой скрипт — добавьте хотя бы один узел' });
            }
            await client.query("UPDATE scripts SET status = 'draft' WHERE status = 'active' AND id <> $1", [req.params.id]);
        }

        await client.query(
            'UPDATE scripts SET title = $1, status = $2, employee_id = $3 WHERE id = $4',
            [title.trim(), status, employeeId || null, req.params.id]
        );

        await client.query('COMMIT');
        const row = await fetchScriptById(req.params.id);
        res.json(rowToScript(row));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить скрипт' });
    } finally {
        client.release();
    }
});

// DELETE /api/admin/scripts/:id — удалить черновик целиком (каскадно удалит узлы)
router.delete('/scripts/:id', async (req, res) => {
    try {
        const existing = await pool.query('SELECT status FROM scripts WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Скрипт не найден' });
        }
        if (existing.rows[0].status === 'active') {
            return res.status(400).json({ error: 'Нельзя удалить активный скрипт, сначала активируйте другой' });
        }
        await pool.query('DELETE FROM scripts WHERE id = $1', [req.params.id]);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить скрипт' });
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
