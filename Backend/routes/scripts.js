// --- routes/scripts.js: скрипт звонка для карточки лида (страница оператора) ---
// Скрипт привязан к ЛИДУ, а не к оператору: администратор выбирает его на
// странице «Лиды» при добавлении лида или партии (решение владельца,
// 13.08.2026 — автоподбор «по совпадению признаков» отменён окончательно,
// employee_scripts удалена вместе с ручной привязкой операторов).
//
// ПРАВИЛО ПОКАЗА (переписано целиком 25.08.2026, решения владельца 82–83):
// у лида до пяти пар «скрипт + его статусы». Текущий статус лида попадает РОВНО
// В ОДНУ пару — это гарантирует первичный ключ (lead_id, funnel_status_id), — и
// показывается скрипт этой пары. Не попал ни в одну — null.
//
// ЧТО ОТМЕНЕНО И ПОЧЕМУ ЭТО НАЗВАНО ЗДЕСЬ. Прежнее правило имело три ветки, и
// две из них работали В ОБХОД списка статусов: этап 5–6 отдавал отдельное поле
// «повторный скрипт», а отпускающий статус (`releases_lead`) отдавал основной
// скрипт независимо от списка. Оба обхода существовали потому, что список был
// ОДИН на лида и выразить «здесь другой скрипт» было нечем.
//
// Пары это выражают прямо: повторный скрипт — просто пара с повторными
// статусами, недозвон — пара со статусами недозвона. Обходы стали не нужны и
// сняты вместе с полем `leads.repeat_script_id`.
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
//
// БЕРЁМ ТОЛЬКО 'statement', А НЕ «ВСЁ, КРОМЕ ВОЗРАЖЕНИЙ». Раньше это было одно и
// то же — видов было два. С появлением третьего ('transfer', фраза для перевода,
// решение владельца 86) прежнее условие молча пустило бы её в основной текст,
// и оператор зачитал бы фразу перевода посреди разговора. Условие от обратного
// живёт ровно до появления третьего значения — вот оно и появилось.
function flattenStatements(nodes) {
    const childrenByParent = buildChildrenMap(nodes);
    const result = [];
    const walk = (key) => {
        (childrenByParent.get(key) || []).forEach((node) => {
            if (node.node_type !== 'statement') return;
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
        // Из лида нужен ровно один признак — его текущий статус. Прежние
        // четыре колонки ушли вместе с правилом показа: repeat_script_id
        // снят схемой этой же работы, script_id сервер больше не пишет,
        // stage_number и releases_lead в выборе скрипта не участвуют.
        `SELECT l.funnel_status_id FROM leads l WHERE l.id = $1`,
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

// ПРАВИЛО ПОКАЗА СТАЛО ОДНИМ ЗАПРОСОМ (решения владельца 82–83, 25.08.2026).
//
// Было три ветки: этап 5–6 отдавал отдельное поле «повторный скрипт» мимо списка
// статусов; отпускающий статус отдавал основной скрипт тоже мимо списка; и лишь
// третья ветка смотрела в список. Три правила на один вопрос — и два из них
// работали в обход того места, где человек этот вопрос настраивал.
//
// Стало одно: у лида есть пары «скрипт + его статусы», текущий статус попадает
// РОВНО В ОДНУ пару (первичный ключ таблицы это гарантирует), её скрипт и
// показываем. Не попал ни в одну — показывать нечего, и это ответ владельца:
// «пусто».
//
// Отменённое названо вслух, чтобы через месяц не искали, куда делось:
//   · правило «этап 5–6 → повторный скрипт» отменено вместе с полем;
//   · правило «отпускающий статус показывает скрипт мимо списка» отменено:
//     привязка теперь строго по выбранным статусам.
async function resolveScriptId(lead, leadId) {
    if (lead.funnel_status_id === null) return null;

    const pair = await pool.query(
        'SELECT script_id FROM lead_script_statuses WHERE lead_id = $1 AND funnel_status_id = $2',
        [leadId, lead.funnel_status_id]
    );
    return pair.rows.length > 0 ? pair.rows[0].script_id : null;
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
