// --- routes/scriptsAdmin.js: наполнение/редактирование скрипта звонка (для руководителя) ---
// Без отдельного логина на этой итерации — как и "Сотрудники" (решение куратора,
// 2026-08-05: полноценный логин по ролям — это будущее единое админ-меню).

const express = require('express');
const { pool } = require('../db');
const guards = require('../services/deleteGuards');

const router = express.Router();

// Белый список тегов для content ЛЮБОГО узла — и корневого, и возражения
// (rich-text тулбар в scriptsAdminNodes.js). Для большинства тегов ВСЕ атрибуты
// отбрасываются — неразрешённые теги вырезаются целиком (текст внутри
// остаётся), этим же путём убираются <script> и любые on*-обработчики.
//
// Возражения ходили мимо санитайзера, пока у них не было редактора: текст
// сохранялся как есть и на экран выводился экранированным. С К156 у них тот же
// редактор, что у основного текста, — значит и тот же путь чистки. Записи,
// сохранённые до этого, приведены разовой правкой данных в schema.sql
// (2026-08-21-escape-objection-content).
//
// Исключение — span: единственный тег, которому разрешён атрибут style, и то
// только с двумя свойствами (font-family/font-size) из жёстко заданного
// списка значений (шрифт/попиксельный размер текста, см. scriptsAdminNodes.js).
// Само значение style ПЕРЕД сравнением со списком нормализуется (декодируются
// HTML-сущности кавычек, схлопываются пробелы) — нельзя полагаться на то, что
// фронт всегда пришлёт байты в одном виде: запрос может прийти напрямую в API,
// в обход UI. Проверено эмпирически в реальном Chromium (не только на глаз):
// span.style.fontFamily=... сериализуется браузером как
// `font-family: &quot;SF Serif&quot;, Georgia, serif;` — с пробелом, `&quot;`
// и `;`, что не совпадает буквально с "чистым" каноническим значением.
const ALLOWED_RICH_TEXT_TAGS = new Set(['b', 'strong', 'i', 'em', 'ul', 'ol', 'li', 'br', 'span']);

const ALLOWED_FONT_FAMILIES = new Set([
    '"SF Serif", Georgia, serif',
    '"Times New Roman", Times, serif',
    'initial' // "По умолчанию" — явный сброс переопределения шрифта у родительских span
]);
const FONT_SIZE_PATTERN = /^\d{1,3}px$/;
const MAX_FONT_SIZE_PX = 200;
// Свободный выбор цвета (report_2026-08-01.md, Задача 2) — в отличие от шрифта,
// не список конкретных значений, а формат: ровно 6-значный hex.
const TEXT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// div/p — не в белом списке тегов, но в отличие от прочих неразрешённых тегов их
// нельзя просто молча вырезать: это то, во что браузер (при обычном наборе текста,
// см. report_2026-08-01.md, Задача 1) иногда оборачивает абзацы вместо <br>, и
// молчаливое вырезание тега схлопывает вместе с ним и сам перенос строки. Основной
// путь исправления — клиентский (ручная вставка <br> по Enter, scriptsAdminNodes.js);
// эта обработка — подстраховка на случай, если source всё же пришлёт div/p (в обход
// клиента или в будущем). На месте открывающего тега — ничего (не задваивать перенос
// на каждой границе), на месте закрывающего — <br>.
const BLOCK_TAGS_AS_BREAK = new Set(['div', 'p']);

function decodeHtmlEntities(value) {
    return value
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

// Разбирает style="..." на объявления, оставляет только разрешённые
// font-family/font-size с разрешёнными значениями — всё остальное (любое
// другое свойство, не прошедшее проверку значение, весь style у любого тега
// кроме span) отбрасывается молча.
function sanitizeStyleValue(rawStyle) {
    const declarations = decodeHtmlEntities(rawStyle).split(';').map((d) => d.trim()).filter(Boolean);
    const kept = [];
    for (const decl of declarations) {
        const sepIndex = decl.indexOf(':');
        if (sepIndex === -1) continue;
        const prop = decl.slice(0, sepIndex).trim().toLowerCase();
        const value = decl.slice(sepIndex + 1).trim().replace(/\s*,\s*/g, ', ');

        if (prop === 'font-family' && ALLOWED_FONT_FAMILIES.has(value)) {
            kept.push(`font-family: ${value}`);
        } else if (prop === 'font-size' && FONT_SIZE_PATTERN.test(value) && parseInt(value, 10) > 0 && parseInt(value, 10) <= MAX_FONT_SIZE_PX) {
            kept.push(`font-size: ${value}`);
        } else if (prop === 'color' && TEXT_COLOR_PATTERN.test(value)) {
            kept.push(`color: ${value.toLowerCase()}`);
        }
    }
    return kept.join('; ');
}

// Текст между тегами. Экранируются только < и >, и это важно: & не трогаем,
// иначе уже сохранённые сущности (&nbsp;, &lt;) задваивались бы при каждом
// повторном сохранении, и текст расползался бы сам по себе при обычной правке.
function escapeTextNode(text) {
    return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Разбор с накоплением, а не одна сплошная замена.
//
// Замена вырезала тег, и соседние символы смыкались — из безобидного на вид
// ввода получался живой тег:
//
//     <<x>img src=x onerror=alert(1)>
//     разбор убирал <x>, оставалось <img …> — целый тег, который уже никто не
//     проверит: проход идёт слева направо и позиция пройдена.
//
// Здесь всё, что не распознано как тег, — текст, и в нём < и > экранируются.
// Одиночный < не может стать началом тега ни при каком вырезании: он уже не <.
function sanitizeRichText(html) {
    const source = String(html);
    const tagPattern = /<(\/?)([a-zA-Z0-9]+)([^>]*)>/g;
    let out = '';
    let lastIndex = 0;
    let match;

    while ((match = tagPattern.exec(source)) !== null) {
        out += escapeTextNode(source.slice(lastIndex, match.index));
        lastIndex = tagPattern.lastIndex;

        const closingSlash = match[1];
        const tag = match[2].toLowerCase();
        const attrs = match[3];

        if (!ALLOWED_RICH_TEXT_TAGS.has(tag)) {
            if (BLOCK_TAGS_AS_BREAK.has(tag)) out += closingSlash ? '<br>' : '';
            continue;
        }
        if (closingSlash) {
            out += `</${tag}>`;
            continue;
        }
        if (tag === 'span') {
            const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"/i) || attrs.match(/style\s*=\s*'([^']*)'/i);
            if (styleMatch) {
                const cleanStyle = sanitizeStyleValue(styleMatch[1]);
                // Одинарные кавычки для АТРИБУТА, т.к. значения font-family (SF Serif,
                // Times New Roman) сами содержат двойные кавычки — style="...""..." было
                // бы невалидным HTML (браузер обрывает атрибут на первой внутренней "),
                // ломая и рендер, и повторный парсинг при редактировании.
                out += cleanStyle ? `<span style='${cleanStyle}'>` : '<span>';
            } else {
                out += '<span>';
            }
            continue;
        }
        out += `<${tag}>`;
    }

    out += escapeTextNode(source.slice(lastIndex));
    return out;
}

// hasMainText/objectionsCount — подстрока наполненности в списке скриптов
// («основной текст · N возражений» / «Пока не наполнен»). Считаются одним
// JOIN в SCRIPT_SELECT ниже, без N+1 запросов с фронта.
function rowToScript(row) {
    return {
        id: row.id,
        title: row.title,
        status: row.status,
        hasMainText: row.has_main_text === undefined ? null : Boolean(row.has_main_text),
        objectionsCount: row.objections_count === undefined ? null : Number(row.objections_count)
    };
}

const SCRIPT_SELECT = `
    SELECT s.*,
           COALESCE(n.objections_count, 0) AS objections_count,
           COALESCE(n.has_main_text, false) AS has_main_text
    FROM scripts s
    LEFT JOIN (
        SELECT script_id,
               count(*) FILTER (WHERE node_type = 'objection')::int AS objections_count,
               bool_or(parent_id IS NULL AND node_type = 'statement') AS has_main_text
        FROM script_nodes
        GROUP BY script_id
    ) n ON n.script_id = s.id
`;

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
    const result = await pool.query(`${SCRIPT_SELECT} WHERE s.id = $1`, [id]);
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

// GET /api/admin/scripts — список скриптов (по умолчанию все: черновики +
// активные). ?status=active — только активные, под выпадающие списки
// «Скрипт»/«Скрипт для повторных» на странице «Лиды».
router.get('/scripts', async (req, res) => {
    try {
        const { status } = req.query;
        if (status !== undefined && status !== 'draft' && status !== 'active') {
            return res.status(400).json({ error: 'Недопустимый статус' });
        }
        const result = status
            ? await pool.query(`${SCRIPT_SELECT} WHERE s.status = $1 ORDER BY s.id`, [status])
            : await pool.query(`${SCRIPT_SELECT} ORDER BY s.id`);
        res.json(result.rows.map(rowToScript));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список скриптов' });
    }
});

// POST /api/admin/scripts — создать новый скрипт (черновик)
router.post('/scripts', async (req, res) => {
    try {
        const { title } = req.body;
        if (!title || !String(title).trim()) {
            return res.status(400).json({ error: 'Укажите название скрипта' });
        }
        const result = await pool.query(
            'INSERT INTO scripts (title, status) VALUES ($1, $2) RETURNING id',
            [title.trim(), 'draft']
        );
        const row = await fetchScriptById(result.rows[0].id);
        res.status(201).json(rowToScript(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать скрипт' });
    }
});

// PUT /api/admin/scripts/:id — изменить title/status. Несколько скриптов
// могут быть 'active' одновременно (каждый под своих назначенных операторов)
// — здесь нет переключения других скриптов в draft.
router.put('/scripts/:id', async (req, res) => {
    const { title, status } = req.body;
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

        await pool.query('UPDATE scripts SET title = $1, status = $2 WHERE id = $3', [title.trim(), status, req.params.id]);

        const row = await fetchScriptById(req.params.id);
        res.json(rowToScript(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить скрипт' });
    }
});

// DELETE /api/admin/scripts/:id — порядок плана 11.4, «Скрипт».
//
// Шаг 1 — назначен лидам основным или повторным? Запрещено.
//
// ЭТО ИЗМЕНЕНИЕ ПОВЕДЕНИЯ, а не оформление прежнего. До части 5 удаление
// скрипта ничем не блокировалось: привязка у лида обнулялась сама, потому что
// leads.script_id и leads.repeat_script_id объявлены ON DELETE SET NULL. То
// есть скрипт исчезал, а у лидов молча пропадало, по какому скрипту с ними
// говорили, — и узнать это было уже неоткуда. План 11.4 требует запрета, и
// связь остаётся обнуляющей намеренно: запрет живёт в маршруте, где его можно
// объяснить словами, а SET NULL остаётся страховкой на случай удаления мимо
// маршрута.
//
// Шаг 2 — узлы дерева уходят каскадом (класс А, script_nodes).
// Шаг 3 — сам скрипт.
router.delete('/scripts/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const blockers = guards.orderBlockers([
            await guards.countBlocker(pool, 'leads',
                `FROM leads l WHERE l.script_id = $1 OR l.repeat_script_id = $1 ORDER BY l.id`, [id])
        ]);
        if (blockers.length > 0) return guards.refuse(res, blockers);

        const found = await pool.query('SELECT title FROM scripts WHERE id = $1', [id]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Скрипт не найден' });
        }
        const removed = await guards.deleteAsBatch(
            pool, `Удаление скрипта «${found.rows[0].title}»`,
            (client) => client.query('DELETE FROM scripts WHERE id = $1 RETURNING id', [id]));
        if (removed.rows.length === 0) {
            return res.status(404).json({ error: 'Скрипт не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить скрипт' });
    }
});

// Здесь были GET/POST /api/admin/offers (таблица-заглушка offers) и
// POST/DELETE /api/admin/employees/:employeeId/scripts (привязка операторов к
// скриптам через employee_scripts). Все четыре удалены 13.08.2026: привязка
// операторов отменена целиком — скрипт назначается лиду на странице «Лиды», а
// эндпоинты офферов-заглушек фронт не вызывал уже давно (реальные офферы живут
// в routes/realEstateOffers.js).

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

        // Санитайзер стоит на ЛЮБОМ узле, а не только на корневом (К156).
        // Возражение правится тем же редактором и показывается разметкой — путь
        // для пользовательской разметки в проекте один, и второго быть не
        // должно: разметка, которую никто не чистит, доезжает до экрана
        // оператора как есть.
        const normalizedContent = sanitizeRichText(content).trim();

        const result = await pool.query(
            `INSERT INTO script_nodes (script_id, parent_id, node_type, label, content, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [req.params.id, normalizedParentId, nodeType, label || null, normalizedContent, sortOrder || 0]
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

        // Санитайзер стоит на ЛЮБОМ узле, а не только на корневом (К156).
        // Возражение правится тем же редактором и показывается разметкой — путь
        // для пользовательской разметки в проекте один, и второго быть не
        // должно: разметка, которую никто не чистит, доезжает до экрана
        // оператора как есть.
        const normalizedContent = sanitizeRichText(content).trim();

        const result = await pool.query(
            `UPDATE script_nodes SET parent_id = $1, node_type = $2, label = $3, content = $4, sort_order = $5
             WHERE id = $6 RETURNING *`,
            [normalizedParentId, nodeType, label || null, normalizedContent, sortOrder || 0, nodeId]
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
