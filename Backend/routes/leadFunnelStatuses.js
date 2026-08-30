// --- routes/leadFunnelStatuses.js: справочник статусов/этапов воронки лида (только чтение) ---

const express = require('express');
const { pool } = require('../db');
const { fetchAutoRecallRules } = require('../services/callEvents');
const { countBlocker, orderBlockers, refuse } = require('../services/deleteGuards');

const router = express.Router();

// Пометка статуса — три состояния, третье пустое (решение владельца 100).
// Значения русские и пришпилены ограничением базы: журнал изменений пишет
// значение как текст, и «true → false» человек не прочитает.
const MARKS = ['окончательный', 'промежуточный'];

// Подпись этапа в отказах — та же, что на экране: «1 · Первичный контакт».
function stageLabel(stageNumber, stageName) {
    return `${stageNumber} · ${stageName}`;
}

/**
 * Этап существует? Перечень берётся ИЗ ДАННЫХ, а не из зашитого списка семи:
 * разбивка живёт в схеме, и второй список этапов разошёлся бы с ней молча. Тот
 * же довод, по которому экран собирает коробки этапов из самих статусов.
 */
async function findStage(db, stageNumber) {
    const result = await db.query(
        `SELECT stage_number, stage_name FROM lead_funnel_statuses
          WHERE stage_number = $1 LIMIT 1`, [stageNumber]);
    return result.rows[0] || null;
}

/**
 * «Этап системный» — ОДИН ТЕКСТ НА ТРИ МЕСТА (К242).
 *
 * Отдельного признака у этапа нет: системный — тот, в котором лежат системные
 * статусы. Ответ на этот вопрос нужен перечню этапов, правке описания и запрету
 * заводить статус; три написанных порознь условия совпали бы в день написания и
 * разошлись бы в первый же день правки — а расхождение выглядело бы как «экран
 * врёт», и искать его пошли бы на экране.
 *
 * Псевдоним `sys` намеренно не `s`: условие подставляется внутрь запросов, где
 * `s` уже занято.
 */
function stageIsSystemSql(numberExpr) {
    return `EXISTS (SELECT 1 FROM lead_funnel_statuses sys
                     WHERE sys.stage_number = ${numberExpr} AND sys.is_system)`;
}

async function stageIsSystem(db, stageNumber) {
    const result = await db.query(`SELECT ${stageIsSystemSql('$1')} AS is_system`, [stageNumber]);
    return result.rows[0].is_system;
}

/**
 * Имя занято внутри этапа? Сравнение БЕЗ учёта регистра — строже, чем
 * `UNIQUE (stage_number, status_name)` в базе, и тот же приём, что в «Настройке
 * списков» (`routes/paramLists.js:61`): «Перезвон» и «перезвон» в одном этапе —
 * это не два статуса, а один и опечатка.
 *
 * `exceptId` нужен переименованию: смена регистра собственного имени отказом не
 * считается.
 */
async function nameTaken(db, stageNumber, name, exceptId) {
    const result = await db.query(
        `SELECT id FROM lead_funnel_statuses
          WHERE stage_number = $1 AND lower(btrim(status_name)) = lower(btrim($2))
            AND ($3::int IS NULL OR id <> $3)`,
        [stageNumber, name, exceptId === undefined ? null : exceptId]);
    return result.rows.length > 0;
}

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
                        auto_recall, requires_call_time, releases_lead, mark,
                        is_system, awaits_manager
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
                // Пометка «окончательный / промежуточный»; null — не размечен.
                // Заведена заходом 1, а отдавать её понадобилось только сейчас:
                // до захода 4 её никто не показывал и не правил.
                mark: r.mark,
                // Два признака захода 6, и оба про поведение, а не про вид.
                // `isSystem` — статус ставит система, человек его выбрать не
                // может. `awaitsManager` — по такому статусу лид дальше не
                // двинется, пока руководитель не вмешается; именно этот смысл
                // экран рисует красным, и решает это экран, а не колонка.
                isSystem: r.is_system,
                awaitsManager: r.awaits_manager,
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

// GET /api/lead-funnel-statuses/stages — этапы с описаниями
//
// СТОИТ ВЫШЕ `PUT /:id` НАМЕРЕННО, и то же самое ниже: иначе слово «stages»
// уедет в `:id` как идентификатор. Тот же образец, что у `/list-for-manager` в
// маршруте сотрудников.
router.get('/stages', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT g.stage_number, g.description,
                    (SELECT s.stage_name FROM lead_funnel_statuses s
                      WHERE s.stage_number = g.stage_number LIMIT 1) AS stage_name,
                    ${stageIsSystemSql('g.stage_number')} AS is_system
               FROM lead_funnel_stages g
              ORDER BY g.stage_number`);
        res.json(result.rows.map((r) => ({
            stageNumber: r.stage_number,
            // Имя этапа по-прежнему живёт в строках статусов, а не здесь:
            // разбор — в схеме, у объявления таблицы.
            stageName: r.stage_name,
            description: r.description,
            // Системный этап — тот, в котором лежат системные статусы. Отдельного
            // признака у этапа нет: два места, отвечающих на один вопрос,
            // разошлись бы на первой же правке.
            isSystem: r.is_system,
            editable: r.is_system
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить этапы воронки' });
    }
});

// PUT /api/lead-funnel-statuses/stages/:number { description }
//
// ПРАВКУ РАЗРЕШАЕТ СЕРВЕР, А НЕ ТОЛЬКО ЭКРАН (требование куратора). Проверка,
// живущая в разметке кнопки, — это не запрет, а просьба: тот же адрес доступен
// из адресной строки, и «правится только у системного этапа» обязано держаться
// при любом пути сюда.
//
// ОПИСАНИЕ ОБЯЗАТЕЛЬНО, ПРЕДЕЛА ДЛИНЫ НЕТ. Пустое описание означало бы этап без
// объяснения, то есть поле без причины, — а `maxlength` в проекте нет ни в
// одном разделе, и заводить его здесь ради единственного поля значит придумать
// правило, которого не существует.
router.put('/stages/:number', async (req, res) => {
    const stageNumber = Number(req.params.number);
    const description = String((req.body && req.body.description) || '').trim();
    if (!Number.isInteger(stageNumber)) {
        return res.status(400).json({ error: 'Не указан этап' });
    }
    if (!description) {
        return res.status(400).json({ error: 'Опишите этап: без описания непонятно, что делают его статусы' });
    }
    try {
        const stage = await pool.query(
            `SELECT g.stage_number, ${stageIsSystemSql('g.stage_number')} AS is_system
               FROM lead_funnel_stages g WHERE g.stage_number = $1`, [stageNumber]);
        if (stage.rows.length === 0) {
            return res.status(404).json({ error: 'Такого этапа нет' });
        }
        if (!stage.rows[0].is_system) {
            return res.status(400).json({
                error: 'Описание правится только у системного этапа: остальные объясняет их состав'
            });
        }
        await pool.query('UPDATE lead_funnel_stages SET description = $1 WHERE stage_number = $2',
            [description, stageNumber]);
        res.json({ stageNumber, description });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить описание этапа' });
    }
});

// POST /api/lead-funnel-statuses { stageNumber, statusName } — завести статус
//
// В КОНЕЦ СВОЕГО ЭТАПА: `max(sort_order) + 1` внутри этапа (ответ куратора 23).
// Дыры от удалённых не заполняем и соседей не перенумеровываем — перенумерация
// правит ЧУЖИЕ строки ради красоты, и каждая такая правка пошла бы в журнал
// изменений отдельной записью. Человек, открывший историю статуса, увидел бы
// десяток правок, которых никто не делал; `sort_order` при этом не показывается
// вовсе и дыр в себе не выдаёт.
//
// ЭТАП НЕ ЗАВОДИТСЯ. Этапы — структура воронки, а не список значений: они
// пришли из документа воронки CPA-сети, и восьмого экран завести не даёт.
//
// ⚠ В СИСТЕМНЫЙ ЭТАП СТАТУС НЕ ЗАВОДИТСЯ ВОВСЕ (К242, решение владельца 106:
// «свой статус в этом этапе пока не заводит»). Запрет стоит НА СЕРВЕРЕ, а не в
// разметке кнопки: проверка, живущая на экране, — это просьба, тот же адрес
// доступен помимо него. Тот же довод, по которому правку описания этапа сторожит
// `PUT /stages/:number`.
//
// ЦЕНА ПРОПУСКА НАЗВАНА ОТДЕЛЬНО, потому что она не в самом заведении. Такой
// статус приехал бы БЕЗ признака `is_system` — то есть лёг бы среди системных,
// выглядел бы как они, а вёл себя как обычный: оператору виден, лиду ставится,
// из очереди не выпадает. Разобрать это потом было бы некому.
router.post('/', async (req, res) => {
    const stageNumber = Number(req.body && req.body.stageNumber);
    const name = String((req.body && req.body.statusName) || '').trim();
    if (!Number.isInteger(stageNumber)) {
        return res.status(400).json({ error: 'Не указан этап' });
    }
    if (!name) {
        return res.status(400).json({ error: 'Укажите название' });
    }
    try {
        const stage = await findStage(pool, stageNumber);
        if (!stage) {
            return res.status(400).json({ error: 'Такого этапа нет' });
        }
        if (await stageIsSystem(pool, stageNumber)) {
            return res.status(400).json({
                error: 'Статусы системного этапа заводит система: вручную сюда не добавляют.'
            });
        }
        if (await nameTaken(pool, stageNumber, name)) {
            return res.status(400).json({
                error: `В этапе «${stageLabel(stage.stage_number, stage.stage_name)}» такой статус уже есть`
            });
        }
        const max = await pool.query(
            'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM lead_funnel_statuses WHERE stage_number = $1',
            [stageNumber]);
        const created = await pool.query(
            `INSERT INTO lead_funnel_statuses (stage_number, stage_name, status_name, sort_order)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [stageNumber, stage.stage_name, name, Number(max.rows[0].max_order) + 1]);
        res.status(201).json({ id: created.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось завести статус' });
    }
});

// PUT /api/lead-funnel-statuses/:id { statusName, requiresCallTime, releasesLead }
//
// Имя и два признака — то, что правится в окне статуса. ЭТАП НЕ МЕНЯЕТСЯ:
// перенести статус между этапами экран не даёт, и маршрут тоже.
//
// ⚠ ТРЕТЬЕГО ПРИЗНАКА ЗДЕСЬ НЕТ. `auto_recall` заморожена заходом 2: список
// статусов для обзвона задаёт событие «Автоперезвон», и колонка доживает до
// отдельного слова владельца о снятии. Писать в неё отсюда значило бы завести
// второй источник правды у того, что уже переехало.
router.put('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const name = String((req.body && req.body.statusName) || '').trim();
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Неверный номер статуса' });
    }
    if (!name) {
        return res.status(400).json({ error: 'Укажите название' });
    }
    try {
        const existing = await pool.query(
            'SELECT id, stage_number, stage_name FROM lead_funnel_statuses WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Статус не найден' });
        }
        const row = existing.rows[0];
        if (await nameTaken(pool, row.stage_number, name, id)) {
            return res.status(400).json({
                error: `В этапе «${stageLabel(row.stage_number, row.stage_name)}» такой статус уже есть`
            });
        }
        await pool.query(
            `UPDATE lead_funnel_statuses
                SET status_name = $1, requires_call_time = $2, releases_lead = $3
              WHERE id = $4`,
            [name, Boolean(req.body.requiresCallTime), Boolean(req.body.releasesLead), id]);
        res.json({ id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить статус' });
    }
});

// PUT /api/lead-funnel-statuses/:id/mark { mark } — пометка «окончательный /
// промежуточный», и пусто — законное третье значение.
//
// СВОЙ МАРШРУТ, А НЕ ЧАСТЬ ПРЕДЫДУЩЕГО. Пометку ставят списком прямо в строке
// справочника, пятьдесят раз подряд, и сохраняется она сразу по выбору —
// кнопки «Сохранить» у вкладки нет. Слать сюда заодно имя и два признака
// значило бы отправлять на сервер всю строку ради одного значения и рисковать
// затереть чужую правку, сделанную в окне между чтением списка и выбором.
router.put('/:id/mark', async (req, res) => {
    const id = Number(req.params.id);
    const raw = req.body ? req.body.mark : undefined;
    const mark = raw === null || raw === undefined || String(raw).trim() === '' ? null : String(raw).trim();
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Неверный номер статуса' });
    }
    if (mark !== null && !MARKS.includes(mark)) {
        return res.status(400).json({ error: 'Неизвестная пометка статуса' });
    }
    try {
        const result = await pool.query(
            'UPDATE lead_funnel_statuses SET mark = $1 WHERE id = $2 RETURNING id', [mark, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Статус не найден' });
        }
        res.json({ id, mark });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить пометку' });
    }
});

// DELETE /api/lead-funnel-statuses/:id
//
// ПЯТЬ ПОМЕХ, А НЕ ДВЕ. Паспорт Р11 знал про лидов и наборы «скрипт + статус»;
// заход 1 завёл правила автоперезвона, а у них ДВЕ ссылки на справочник — сам
// статус и статус после предела, — и обе запрещающие. Чинятся они в разных
// местах, поэтому и называются разными словами (ответ куратора 25).
//
// ⚠ ПЯТАЯ ПРИЕХАЛА ЗАХОДОМ 6 И В ПЕРЕЧЕНЬ НЕ ПОПАЛА (К243): целевой статус
// пост-обработки, `call_events.wrapup_status_id`. Связь запрещающая, база
// удаление не давала — и человек получал ровно то, что абзац ниже обещает не
// показывать: «Произошла ошибка на сервере» с кодом 500. Заведённая связь, не
// названная в перечне помех, хуже отсутствующей: запрет работает, а объяснения
// нет.
//
// ПОЧЕМУ ЭТО НЕ МЕЛОЧЬ. Запрет последнего-в-этапе здесь не спасает: системных
// статусов два, и «Нет результата» удаляется как обычная строка. Не будь связи,
// руководитель снёс бы целевой статус тайм-аута одним нажатием — и
// пост-обработка молча перестала бы ставить статус вовсе.
//
// Помеха одна — строка одна, ноль не пишется: `countBlocker` возвращает null,
// когда считать нечего, а `orderBlockers` такие отсеивает.
//
// ГОЛАЯ ОШИБКА БАЗЫ НАРУЖУ НЕ ВЫХОДИТ. Запреты стоят и в схеме — 23503 дошёл бы
// до человека как «Произошла ошибка на сервере»; здесь он не наступает вовсе,
// потому что до `DELETE` дело не доходит.
//
// ПАРТИЕЙ ЭТО НЕ ОФОРМЛЯЕТСЯ. Партия нужна каскаду — одно нажатие, десятки
// строк журнала; здесь каскада нет ни одного: все пять связей запрещающие, и
// удаление даёт ровно одну запись.
router.delete('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Неверный номер статуса' });
    }
    try {
        const existing = await pool.query(
            'SELECT id, stage_number, stage_name, status_name FROM lead_funnel_statuses WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Статус не найден' });
        }
        const row = existing.rows[0];

        // ⚠ ПОСЛЕДНИЙ СТАТУС ЭТАПА НЕ УДАЛЯЕТСЯ, и это не помеха, а запрет.
        //
        // Этапы закреплены: восьмого экран завести не даёт, и седьмого обратно —
        // тоже. Перечень этапов берётся из самих статусов, другого места он не
        // имеет вовсе. Значит удаление последней строки этапа СНОСИТ ЭТАП
        // НАВСЕГДА — действием, которое называется «удалить статус», и вернуть
        // его будет нечем.
        //
        // У нулевого этапа цена выше: с него начинается каждый лид, очередь
        // ищет статус по НОМЕРУ этапа (`leadDistribution.js:47`), и раздача,
        // загрузка базы и возврат из архива берут его оттуда. Опустеет — всё
        // это перестанет работать молча.
        //
        // Ни паспорт, ни наряд этого случая не называют: дыра открылась ровно
        // тем, что справочник стал правимым.
        const left = await pool.query(
            'SELECT count(*)::int AS n FROM lead_funnel_statuses WHERE stage_number = $1',
            [row.stage_number]);
        if (left.rows[0].n <= 1) {
            const tail = row.stage_number === 0
                ? ' С этого этапа начинается каждый лид.'
                : '';
            return res.status(400).json({
                error: `Статус «${row.status_name}» удалить нельзя: он последний в этапе `
                    + `«${stageLabel(row.stage_number, row.stage_name)}», а этапы закреплены — `
                    + `завести этап заново экран не даёт.${tail}`
            });
        }

        const blockers = orderBlockers(await Promise.all([
            countBlocker(pool, 'leads', 'FROM leads WHERE funnel_status_id = $1 ORDER BY id', [id]),
            // Целевой статус тайм-аута (К243). Стоит в перечне ПЕРВЫМ среди
            // помех статуса — не по числу, а по тому же правилу, что и вся
            // тройка ниже: от того, что чинится дальше от экрана, к тому, что
            // рядом. Это чинится дальше всех — экраном не чинится вовсе, поле
            // задаётся выкаткой (паспорт Р12 редакции 5).
            countBlocker(pool, 'wrapup_target',
                'FROM call_events WHERE wrapup_status_id = $1 ORDER BY id', [id]),
            // У таблицы пар своего `id` нет вовсе — ключ составной. Считаем по
            // лидам, которых это заденет: именно их человек и пойдёт искать.
            countBlocker(pool, 'script_pairs',
                'FROM (SELECT DISTINCT lead_id AS id FROM lead_script_statuses WHERE funnel_status_id = $1) p ORDER BY id',
                [id]),
            countBlocker(pool, 'recall_rules',
                'FROM call_recall_rules WHERE funnel_status_id = $1 ORDER BY id', [id]),
            countBlocker(pool, 'recall_targets',
                'FROM call_recall_rules WHERE after_limit_status_id = $1 ORDER BY id', [id])
        ]));
        if (blockers.length) return refuse(res, blockers);

        await pool.query('DELETE FROM lead_funnel_statuses WHERE id = $1', [id]);
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить статус' });
    }
});

module.exports = router;
