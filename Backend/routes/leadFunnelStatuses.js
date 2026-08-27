// --- routes/leadFunnelStatuses.js: справочник статусов/этапов воронки лида (только чтение) ---

const express = require('express');
const { pool } = require('../db');
const { fetchAutoRecallRules } = require('../services/callEvents');

const router = express.Router();

// GET /api/lead-funnel-statuses — полный список, для группировки по этапу на фронте.
// С 15.08.2026 отдаются и признаки поведения статуса: по requiresCallTime форма
// оператора раскрывает выбор даты и времени перезвона. Сравнений по названию
// статуса на клиенте нет и быть не должно.
//
// ПРЕДЕЛ ПОПЫТОК ПРИЕЗЖАЕТ ОТСЮДА ЖЕ (часть 9, заход 3, ловушка 2 наряда). До
// этого экран оператора держал своё число двадцать: поставил бы руководитель
// предел семь — сервер переключил бы статус на седьмой попытке, а оператор читал
// бы «из 20», и ни в логе, ни на экране не появилось бы ничего.
//
// ПОЧЕМУ СЮДА, А НЕ ОТДЕЛЬНЫМ МАРШРУТОМ. Этот список уже отвечает на вопрос «что
// будет, если поставить этот статус» — тем же и признаки поведения. Предел и
// целевой статус после него — тот же вопрос, только числом. Отдельный маршрут
// означал бы второй запрос и второй кеш ради ответа на первый.
//
// ⚠ `auto_recall` БОЛЬШЕ НЕ ОТВЕЧАЕТ НА ЭТОТ ВОПРОС. Колонка заморожена заходом
// 2: список статусов для обзвона задаёт событие, и у нового статуса колонка
// навсегда `false`. Она остаётся в ответе, пока живёт сама, но помечать ею
// статус на экране нельзя — соврёт в обе стороны.
router.get('/', async (req, res) => {
    try {
        const [result, recallRules] = await Promise.all([
            pool.query(
                `SELECT id, stage_number, stage_name, status_name, sort_order,
                        auto_recall, requires_call_time, releases_lead
                 FROM lead_funnel_statuses ORDER BY stage_number, sort_order`
            ),
            fetchAutoRecallRules(pool)
        ]);
        const ruleByStatus = new Map(recallRules.map((r) => [r.funnelStatusId, r]));
        res.json(result.rows.map(r => {
            const rule = ruleByStatus.get(r.id) || null;
            return {
                id: r.id,
                stageNumber: r.stage_number,
                stageName: r.stage_name,
                statusName: r.status_name,
                sortOrder: r.sort_order,
                autoRecall: r.auto_recall,
                requiresCallTime: r.requires_call_time,
                releasesLead: r.releases_lead,
                // null — по этому статусу система не перезванивает: правила нет
                // либо событие целиком не годно к работе.
                recallMaxAttempts: rule ? rule.maxAttempts : null,
                recallIntervalMinutes: rule ? rule.intervalMinutes : null,
                recallAfterStatusName: rule ? rule.afterStatusName : null
            };
        }));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список статусов воронки' });
    }
});

module.exports = router;
