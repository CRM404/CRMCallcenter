// --- routes/scripts.js: скрипт звонка для карточки лида (страница оператора) ---
// Скрипт привязан к ЛИДУ, а не к оператору: администратор выбирает его на
// странице «Лиды» при добавлении лида или партии (решение владельца,
// 13.08.2026 — автоподбор «по совпадению признаков» отменён окончательно,
// employee_scripts удалена вместе с ручной привязкой операторов).
//
// Правило показа (решение куратора):
//   - текущий статус лида на этапе 5–6 («Повторный контакт» / «Повторная
//     передача лида») -> leads.repeat_script_id, независимо от списка статусов
//     показа: любой повторный статус включает повторный скрипт;
//   - этап 0–4 -> leads.script_id, но только если текущий статус лида входит
//     в список статусов показа этого лида (lead_script_statuses);
//   - иначе (нет статуса, нет скрипта, статус вне списка) — null.
// null — нормальное состояние с кодом 200 («для этого статуса скрипт не
// назначен»), 404 зарезервирован строго за случаем «такого лида не существует».
// Статус самого скрипта здесь не проверяется: draft/active решает только
// момент назначения на «Лидах», уже назначенный скрипт продолжает
// показываться оператору (dialog.md C1).

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const REPEAT_STAGE_FROM = 5;

// GET /api/scripts?leadId= — скрипт, назначенный лиду, + все его узлы.
router.get('/', async (req, res) => {
    try {
        const { leadId } = req.query;
        if (!leadId) {
            return res.status(400).json({ error: 'Не передан leadId' });
        }

        const leadResult = await pool.query(
            `SELECT l.script_id, l.repeat_script_id, l.funnel_status_id, fs.stage_number
             FROM leads l
             LEFT JOIN lead_funnel_statuses fs ON fs.id = l.funnel_status_id
             WHERE l.id = $1`,
            [leadId]
        );
        if (leadResult.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const lead = leadResult.rows[0];

        const scriptId = await resolveScriptId(lead, leadId);
        if (!scriptId) {
            return res.json(null);
        }

        const scriptResult = await pool.query('SELECT id, title FROM scripts WHERE id = $1', [scriptId]);
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

async function resolveScriptId(lead, leadId) {
    // Нет текущего статуса — показывать нечего: правило показа целиком
    // построено на этапе статуса (dialog.md B3).
    if (lead.funnel_status_id === null || lead.stage_number === null) return null;

    if (lead.stage_number >= REPEAT_STAGE_FROM) {
        // Повторного скрипта может не быть (старый лид или партия без
        // повторных статусов в списке) — тогда null, без отката на основной:
        // текст первичного обзвона на повторном звонке хуже, чем пустота
        // (dialog.md C2).
        return lead.repeat_script_id;
    }

    if (!lead.script_id) return null;
    const inList = await pool.query(
        'SELECT 1 FROM lead_script_statuses WHERE lead_id = $1 AND funnel_status_id = $2 LIMIT 1',
        [leadId, lead.funnel_status_id]
    );
    return inList.rows.length > 0 ? lead.script_id : null;
}

module.exports = router;
