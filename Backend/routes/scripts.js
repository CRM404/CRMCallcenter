// --- routes/scripts.js: скрипт звонка для карточки лида (страница оператора) ---
// Скрипт привязан к ЛИДУ, а не к оператору: администратор выбирает его на
// странице «Лиды» при добавлении лида или партии (решение владельца,
// 13.08.2026 — автоподбор «по совпадению признаков» отменён окончательно,
// employee_scripts удалена вместе с ручной привязкой операторов).
//
// ПРАВИЛО ПОКАЗА (переписано целиком 15.08.2026, задача «рабочий режим
// оператора»; прежняя редакция ниже по тексту стала неверной):
//   - текущий статус лида на этапе 5–6 («Повторный контакт» / «Повторная
//     передача лида») -> leads.repeat_script_id, независимо от списка статусов
//     показа: любой повторный статус включает повторный скрипт;
//   - этап 0–4 -> leads.script_id, если текущий статус лида входит в список
//     статусов показа этого лида (lead_script_statuses) ИЛИ имеет
//     releases_lead = true;
//   - иначе (нет статуса, нет скрипта, статус вне списка) — null.
//
// Почему добавилось «ИЛИ releases_lead». Отпускающие статусы — это четыре
// недозвона и «Перезвон»: они означают, что РАЗГОВОРА НЕ БЫЛО. Лид с таким
// статусом возвращается в очередь сам и приходит к оператору снова; по старому
// правилу он приходил бы с надписью «Для этого статуса скрипт не назначен», если
// администратор не отметил эти статусы вручную (а в модалке «Лидов» по умолчанию
// отмечен только «Новый»). С очередью и автоперезвоном это не редкость, а
// половина всех возвратов. Список статусов показа управляет тем, где скрипт
// продолжает висеть ПОСЛЕ состоявшегося разговора, и к недозвону отношения не
// имеет (решение куратора, dialog.md F1).
//
// null — нормальное состояние с кодом 200 («для этого статуса скрипт не
// назначен»), 404 зарезервирован строго за случаем «такого лида не существует».
// Статус самого скрипта здесь не проверяется: draft/active решает только
// момент назначения на «Лидах», уже назначенный скрипт продолжает
// показываться оператору (dialog.md C1).
//
// СКРИПТ ЛИНЕЙНЫЙ (решение владельца). Кнопок перехода под текстом нет: наружу
// отдаются только statement-узлы, у которых в цепочке родителей нет ни одного
// возражения. Продолжение ответа на возражение — это реплика для конкретного
// возражения, и в сплошном тексте оператор зачитал бы её как часть основного
// разговора. Сами возражения переехали в поиск (см. GET /objections).

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const REPEAT_STAGE_FROM = 5;

// Дети по родителю, каждый список — по sort_order. Обход дерева, а не плоская
// сортировка по sort_order: у узлов разных уровней своя нумерация внутри
// родителя, и плоская сортировка перемешала бы уровни.
function buildChildrenMap(nodes) {
    const childrenByParent = new Map();
    nodes.forEach((n) => {
        const key = n.parent_id === null ? 'root' : n.parent_id;
        if (!childrenByParent.has(key)) childrenByParent.set(key, []);
        childrenByParent.get(key).push(n);
    });
    childrenByParent.forEach((list) => list.sort((a, b) => a.sort_order - b.sort_order));
    return childrenByParent;
}

// Линейный текст: обход в глубину, ветки возражений отсекаются целиком вместе с
// потомками.
function flattenStatements(nodes) {
    const childrenByParent = buildChildrenMap(nodes);
    const result = [];
    const walk = (key) => {
        (childrenByParent.get(key) || []).forEach((node) => {
            if (node.node_type === 'objection') return;
            result.push(node);
            walk(node.id);
        });
    };
    walk('root');
    return result;
}

// Возражения — ВСЕ узлы node_type='objection', плоским списком, независимо от
// глубины вложенности: возражение внутри возражения встречается и в реальных
// скриптах, а в поиске вложенность не значит ничего (dialog.md F3).
function collectObjections(nodes) {
    const childrenByParent = buildChildrenMap(nodes);
    const result = [];
    const walk = (key) => {
        (childrenByParent.get(key) || []).forEach((node) => {
            if (node.node_type === 'objection') result.push(node);
            walk(node.id);
        });
    };
    walk('root');
    return result;
}

async function loadLead(leadId) {
    const result = await pool.query(
        `SELECT l.script_id, l.repeat_script_id, l.funnel_status_id, fs.stage_number, fs.releases_lead
         FROM leads l
         LEFT JOIN lead_funnel_statuses fs ON fs.id = l.funnel_status_id
         WHERE l.id = $1`,
        [leadId]
    );
    return result.rows[0] || null;
}

async function loadNodes(scriptId) {
    const result = await pool.query(
        'SELECT id, parent_id, node_type, label, content, sort_order FROM script_nodes WHERE script_id = $1',
        [scriptId]
    );
    return result.rows;
}

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
    if (lead.releases_lead) return lead.script_id;

    const inList = await pool.query(
        'SELECT 1 FROM lead_script_statuses WHERE lead_id = $1 AND funnel_status_id = $2 LIMIT 1',
        [leadId, lead.funnel_status_id]
    );
    return inList.rows.length > 0 ? lead.script_id : null;
}

// GET /api/scripts?leadId= — скрипт, назначенный лиду, линейным текстом.
router.get('/', async (req, res) => {
    try {
        const { leadId } = req.query;
        if (!leadId) {
            return res.status(400).json({ error: 'Не передан leadId' });
        }

        const lead = await loadLead(leadId);
        if (!lead) {
            return res.status(404).json({ error: 'Лид не найден' });
        }

        const scriptId = await resolveScriptId(lead, leadId);
        if (!scriptId) {
            return res.json(null);
        }

        const scriptResult = await pool.query('SELECT id, title FROM scripts WHERE id = $1', [scriptId]);
        if (scriptResult.rows.length === 0) {
            return res.json(null);
        }
        const script = scriptResult.rows[0];

        const nodes = await loadNodes(script.id);
        res.json({
            id: script.id,
            title: script.title,
            nodes: flattenStatements(nodes).map((r) => ({
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

// GET /api/scripts/objections?leadId= — возражения ТОГО скрипта, который сейчас
// открыт у оператора. Принимает leadId, а не scriptId (dialog.md F2): сервер сам
// решает, основной скрипт или повторный, и оператор не может вытащить возражения
// чужого скрипта, подставив идентификатор. Возражение из чужого скрипта отвечает
// про другой оффер и другую линию — оператор зачитал бы клиенту неверный ответ.
//
// Поиск делается на клиенте: возражений в скрипте десятки, не тысячи, и в
// разговоре задержка на запрос заметна.
router.get('/objections', async (req, res) => {
    try {
        const { leadId } = req.query;
        if (!leadId) {
            return res.status(400).json({ error: 'Не передан leadId' });
        }

        const lead = await loadLead(leadId);
        if (!lead) {
            return res.status(404).json({ error: 'Лид не найден' });
        }

        const scriptId = await resolveScriptId(lead, leadId);
        if (!scriptId) {
            return res.json({ scriptId: null, title: null, objections: [] });
        }

        const scriptResult = await pool.query('SELECT id, title FROM scripts WHERE id = $1', [scriptId]);
        if (scriptResult.rows.length === 0) {
            return res.json({ scriptId: null, title: null, objections: [] });
        }

        const nodes = await loadNodes(scriptId);
        res.json({
            scriptId,
            title: scriptResult.rows[0].title,
            objections: collectObjections(nodes).map((n) => ({
                id: n.id,
                label: n.label,
                content: n.content
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить возражения' });
    }
});

module.exports = router;
