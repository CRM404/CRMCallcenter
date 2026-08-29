// --- routes/calls.js: раздел «Звонки» — две вкладки и всё, что их кормит ---
//
// Маршрут назван по вкладке, которую питает, а не по тому, что внутри
// (ответ куратора И173): `/active` отдаёт операторов на смене, а не звонки, но
// живёт он ради вкладки «Активные». Имя `/operators` спуталось бы с разделом
// «Сотрудники», который про совсем другое.
//
// РАЗДЕЛ ТОЛЬКО ЧИТАЕТ. Ни одного изменяющего запроса здесь нет и не будет:
// звонит оператор из своей панели, руководителю набирать некому (паспорт Р1,
// «чего в шапке нет»). Единственный POST раздела — прослушивание записи — и он
// тоже ничего не меняет у нас: он ходит к оператору связи.
//
// ЧТО СЕГОДНЯ ПУСТО И ПОЧЕМУ ЭТО НОРМА. Телефонии нет: ключи Телфина берёт
// владелец, это этап Е. Значит `calls` пуста, идущих разговоров нет, а колонки,
// которые приходят от станции, показывают прочерк. Раздел от этого не ломается
// — он и задуман работающим на пустых данных (бриф, часть 7).

const express = require('express');
const { pool } = require('../db');
const { normalizeForSearch } = require('../services/phoneFormat');
const { zonedParts } = require('../services/appTime');

const router = express.Router();

// Порция догрузки — та же, что в «Лидах» (паспорт Р1, контрольное число).
const PAGE_SIZE = 30;

// ПОТОЛОК ВЫГРУЗКИ. Файл получает всю выборку, а не показанные тридцать
// (ответ куратора И176), но «вся выборка» за полгода — это сотни тысяч строк,
// которые собираются в браузере той же библиотекой, что у «Лидов». Молча
// отдать половину нельзя, тихо повесить браузер — тоже: сверх потолка приходит
// отказ с числом и предложением сузить период.
//
// ЧИСЛО ОДНО НА ПРОЕКТ, И ЭТО СВЕДЕНО НАМЕРЕННО. В первой редакции здесь стояло
// 20 000, а для журнала изменений куратор назвал 50 000 (ответ И207) — два
// потолка без причины это будущий вопрос «а почему там можно больше». Причины
// нет: библиотека одна, браузер один, файл собирается одинаково. Взято большее
// из двух — меньшее пришлось бы объяснять.
const EXPORT_LIMIT = 50000;

// Исходы нашего перечня. Служебный `lost` ставит сторож зависших, остальные
// приводятся на входе из строки станции (часть 7А, `calls.outcome`).
const OUTCOMES = ['answered', 'busy', 'no_answer', 'cancelled', 'congestion', 'unavailable', 'lost'];

// ---------------------------------------------------------------- телефония
//
// СОСТОЯНИЕ СВЯЗИ СО СТАНЦИЕЙ РАЗЛИЧАЕТ ТРИ ВЕЩИ, А НЕ ДВЕ.
//
//   не настроена — ключей Телфина в переменных нет вовсе. Это сегодняшний день
//                  и весь срок до этапа Е;
//   настроена и отвечает — обычная работа;
//   настроена и молчит — вот это и есть «Нет связи с телефонией», ради чего
//                  паспорт заводит полосу отказа.
//
// РАЗЛИЧАТЬ ОБЯЗАТЕЛЬНО. Полоса «Нет связи с телефонией», висящая круглосуточно
// потому, что телефонии ещё нет в природе, за неделю становится частью фона — и
// в тот день, когда связь действительно оборвётся, её никто не заметит. Тревога,
// которая всегда горит, не тревога.
function pbxState() {
    const configured = Boolean(process.env.TELPHIN_APP_ID && process.env.TELPHIN_APP_SECRET);
    return {
        configured,
        // Клиента станции ещё нет (этап Е). Как только он появится, здесь
        // встанет его настоящий ответ, а `lastKnownAt` — время последнего
        // удачного обмена: полоса называет его человеку.
        available: false,
        lastKnownAt: null
    };
}

// ---------------------------------------------------------------- вкладка «Активные»
//
// СТРОКА — ОПЕРАТОР, А НЕ ЗВОНОК, и состав вкладки — те, у кого СЕГОДНЯ СМЕНА
// ПО ГРАФИКУ, а не те, кто вошёл в систему (паспорт Р1). Разница
// принципиальная: вышедший из системы человек иначе исчез бы из таблицы, и
// увидеть, что он пропал, стало бы нельзя. Поэтому «неактивен» — полноценная
// строка, а не отсутствие строки.
router.get('/active', async (req, res) => {
    try {
        const today = todayIso();

        const result = await pool.query(
            `SELECT e.id,
                    e.last_name, e.first_name, e.middle_name,
                    e.pbx_extension,
                    e.line_type,
                    e.work_state,
                    i.started_at AS state_since,
                    (SELECT max(p.ended_at) FROM employee_state_intervals p
                      WHERE p.employee_id = e.id AND p.ended_at IS NOT NULL) AS last_active_at,
                    c.id AS call_id,
                    c.direction AS call_direction,
                    c.client_phone AS call_phone,
                    c.lead_id AS call_lead_id
               FROM employee_schedule_days d
               JOIN employees e ON e.id = d.employee_id
               -- Открытый интервал ровно один на сотрудника — это гарантия базы
               -- (частичный уникальный индекс), а не только кода.
               LEFT JOIN employee_state_intervals i
                      ON i.employee_id = e.id AND i.ended_at IS NULL
               -- Идущий разговор. Сегодня их не бывает вовсе: строк в calls нет.
               LEFT JOIN LATERAL (
                    SELECT x.id, x.direction, x.client_phone, x.lead_id
                      FROM calls x
                     WHERE x.employee_id = e.id AND x.ended_at IS NULL
                     ORDER BY x.started_at DESC NULLS LAST, x.id DESC
                     LIMIT 1
               ) c ON true
              WHERE d.day = $1::date AND d.state = 'shift'
              ORDER BY e.last_name, e.first_name, e.id`,
            [today]
        );

        const rows = result.rows.map((r) => ({
            employeeId: r.id,
            name: shortName(r),
            extension: r.pbx_extension || null,
            lineType: r.line_type || null,
            state: r.work_state,
            // Длительность тикает в браузере, но ОТСЧИТЫВАЕТСЯ ОТ СЕРВЕРНОГО
            // интервала, а не от момента открытия страницы: обновление вкладки
            // иначе обнуляло бы цифру, и ей было бы незачем верить.
            stateSince: r.state_since || null,
            lastActiveAt: r.last_active_at || null,
            // Три колонки станции. Пока её нет — пусто, и экран рисует прочерк.
            callPhone: r.call_phone || null,
            callLeadId: r.call_lead_id || null,
            direction: r.call_direction || null,
            // ТРУБКА: сегодня это ПРОИЗВОДНОЕ ОТ ДОБАВОЧНОГО, а не ответ станции.
            // Без внутреннего номера оператор к телефонии не привязан вовсе
            // (часть 2, блокирующее условие) — это и есть «не подключена», и
            // утверждать это мы вправе. Обратное — «подключена» — станет
            // настоящим ответом о регистрации, когда появится клиент станции;
            // до тех пор оно означает «номер задан, регистрация неизвестна».
            handset: r.pbx_extension ? 'connected' : 'off'
        }));

        res.json({
            rows,
            count: rows.length,
            // Часы браузера и часы сервера расходятся, а длительность считается
            // от серверного момента. Разницу экран вычтет один раз.
            serverNow: new Date().toISOString(),
            pbx: pbxState()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список операторов на смене' });
    }
});

// ---------------------------------------------------------------- справочники отбора
//
// Операторы и источники — для окна «Фильтры». Списки берутся ЦЕЛИКОМ, а не «те,
// у кого есть звонки»: отбор по оператору, у которого сегодня звонков нет, —
// законный вопрос («почему у него пусто?»), и не найти его в списке значило бы
// не получить ответа.
router.get('/meta', async (req, res) => {
    try {
        const [operators, sources] = await Promise.all([
            // СПИСОК ЦЕЛИКОМ, БЕЗ ОТБОРА, И ЭТО НАРОЧНО (К196).
            //
            // Здесь стояло `WHERE status <> 'Архив'`, и это было условие,
            // которое ДЕЛАЛО ВИД, ЧТО ОТБИРАЕТ. «Архив» — статус ИСТОЧНИКОВ, у
            // них он закрыт ограничением; у сотрудника архив помечается
            // `archive_kind`, а `status` остаётся `active` (routes/employees.js:343).
            // Уволенный сотрудник условие проходил, и в справочнике был виден —
            // то есть поведение совпадало с задуманным СЛУЧАЙНО.
            //
            // Отбирать здесь нечего и не надо: отбор по оператору, у которого
            // сегодня звонков нет, — законный вопрос («почему у него пусто?»), а
            // по уволенному — тем более: его звонки никуда не делись.
            pool.query(
                `SELECT id, last_name, first_name, middle_name, pbx_extension
                   FROM employees
                  ORDER BY last_name, first_name`
            ),
            pool.query(
                `SELECT id, lead_source, city_region FROM sources ORDER BY lead_source, city_region`
            )
        ]);

        res.json({
            operators: operators.rows.map((r) => ({
                id: r.id,
                name: shortName(r),
                extension: r.pbx_extension || null
            })),
            sources: sources.rows.map((r) => ({
                id: r.id,
                title: [r.lead_source, r.city_region].filter(Boolean).join(' · ')
            })),
            outcomes: OUTCOMES,
            pbx: pbxState()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить справочники раздела «Звонки»' });
    }
});

// ---------------------------------------------------------------- вкладка «Завершённые»
//
// СТРОКА — ЗВОНОК, свежие сверху. Входящие живут в этом же журнале: отдельной
// вкладки под них нет, иначе один и тот же лид пришлось бы искать в двух местах
// (паспорт Р1). Отличается только направление.
router.get('/', async (req, res) => {
    try {
        const filters = readFilters(req.query);
        const wantExport = req.query.export === '1';
        // ПЕРИОД — ТОЖЕ ОТБОР, и решает это сервер, а не браузер (К198). Экран
        // по этому признаку выбирает, какую из двух пустот показать, а «сегодня»
        // в проекте берётся только с сервера: часы у руководителя могут стоять в
        // другом поясе (правило Ф7).
        const day = todayIso();
        const periodIsDefault = filters.from === day && filters.to === day;

        const where = [];
        const params = [];
        const add = (sql, value) => { params.push(value); where.push(sql.replace('$$', `$${params.length}`)); };

        // Завершённые — те, у кого есть конец. Идущие живут на другой вкладке, и
        // показать их здесь значило бы посчитать один звонок дважды.
        where.push('c.ended_at IS NOT NULL');

        add('c.started_at >= $$::date', filters.from);
        add('c.started_at < ($$::date + 1)', filters.to);

        if (filters.employeeId) add('c.employee_id = $$', filters.employeeId);
        if (filters.outcome) add('c.outcome = $$', filters.outcome);
        if (filters.direction) add('c.direction = $$', filters.direction);
        if (filters.lineType) add('e.line_type = $$', filters.lineType);
        if (filters.sourceId) add('l.source_id = $$', filters.sourceId);
        if (filters.withRecord) where.push('c.record_id IS NOT NULL');

        // ПОИСК ПО НОМЕРУ идёт по цифрам, а не по строке как есть (ответ
        // куратора И177). Человек вводит «916» или «123-45-67»; в базе номер
        // лежит приведённым, без скобок и дефисов. Сравнивать введённое с
        // хранимым напрямую значит вернуть ту боль, ради которой делалась
        // часть 4.
        if (filters.search) {
            const { exact, digits } = normalizeForSearch(filters.search);
            if (exact) {
                add('c.client_phone = $$', exact);
            } else if (digits) {
                add("regexp_replace(c.client_phone, '\\D', '', 'g') LIKE $$", `%${digits}%`);
            }
        }

        const whereSql = where.join(' AND ');
        const from = `FROM calls c
                      LEFT JOIN employees e ON e.id = c.employee_id
                      LEFT JOIN leads l ON l.id = c.lead_id`;

        // СЧЁТЧИКИ СЧИТАЮТСЯ ТЕМ ЖЕ ОТБОРОМ, ЧТО И ТАБЛИЦА (ответ куратора И175
        // и находка К183). Посчитать чипы одним условием, а строки другим —
        // ровно тот дефект, за который снималась К183: числа в шапке расходятся
        // с тем, что человек видит под ними, и доверие к разделу кончается.
        //
        // ВНУТРЕННИЕ ЗВОНКИ ИЗ СЧЁТЧИКОВ ИСКЛЮЧЕНЫ, а из списка — нет (ответ
        // куратора И159). Внутренний звонок это факт работы, скрывать его
        // нельзя; портить им процент дозвона — тоже.
        const counts = await pool.query(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE NOT c.is_internal)::int AS dialed,
                    count(*) FILTER (WHERE NOT c.is_internal AND c.answered)::int AS answered
             ${from} WHERE ${whereSql}`,
            params
        );
        const total = counts.rows[0].total;
        const dialed = counts.rows[0].dialed;
        const answered = counts.rows[0].answered;

        if (wantExport && total > EXPORT_LIMIT) {
            return res.status(409).json({
                code: 'export_too_large',
                error: `В выборке ${total} звонков — это больше, чем можно выгрузить за раз (${EXPORT_LIMIT}). Сузьте период.`,
                total,
                limit: EXPORT_LIMIT
            });
        }

        const limit = wantExport ? EXPORT_LIMIT : PAGE_SIZE;

        // ПОСТРАНИЧНОСТЬ КУРСОРОМ, А НЕ OFFSET (К197).
        //
        // Список идёт свежими сверху, а журнал пополняется во время чтения —
        // ежеминутно, как только заработает телефония. Новый звонок встаёт
        // наверх и СДВИГАЕТ ОКНО: строка, показанная последней на первой
        // странице, приходит второй раз на второй. Доказано данными: сорок
        // звонков, страница 1 из тридцати, приходит один свежий — и на
        // offset=30 повторяется уже показанная строка.
        //
        // Стенд этого показать не мог: двадцать четыре звонка при порции
        // тридцать — второй страницы не существует, и «повторов нет» означало
        // «повторяться негде».
        //
        // Курсор — пара (started_at, id) последней показанной строки. Порядок и
        // порция те же, меняется только точка отсчёта.
        //
        // NULL В `started_at` УЧТЁН, хотя сегодня таких строк не бывает:
        // колонка допускает пустоту, порядок ставит такие строки в конец
        // (NULLS LAST), и курсор обязан пройти по ним так же, как по остальным.
        // Пустой курсор при заданном номере как раз и значит «мы уже в хвосте
        // из пустых».
        if (!wantExport && req.query.cursorId) {
            const cursorId = Number(req.query.cursorId);
            const cursorAt = String(req.query.cursorAt || '').trim() || null;
            if (Number.isInteger(cursorId) && cursorId > 0) {
                params.push(cursorAt);
                const atIdx = params.length;
                params.push(cursorId);
                const idIdx = params.length;
                where.push(
                    `( ($${atIdx}::timestamp IS NOT NULL AND (`
                    + `(c.started_at IS NOT NULL AND (c.started_at, c.id) < ($${atIdx}::timestamp, $${idIdx}::int))`
                    + ` OR c.started_at IS NULL))`
                    + ` OR ($${atIdx}::timestamp IS NULL AND c.started_at IS NULL AND c.id < $${idIdx}::int) )`
                );
            }
        }

        const listWhere = where.join(' AND ');

        const list = await pool.query(
            `SELECT c.id, c.started_at, c.direction, c.client_phone, c.lead_id,
                    -- КЛЮЧ КУРСОРА — СТРОКА ИЗ САМОЙ БАЗЫ, а не время, прогнанное
                    -- через JS-дату и обратно. Колонка типа timestamp приезжает в
                    -- узел объектом Date, привязанным к поясу МАШИНЫ, и
                    -- toISOString переводит его в UTC: вернувшись параметром с
                    -- приведением к timestamp, он сдвинулся бы ровно на смещение
                    -- пояса, и курсор пропускал бы три часа строк на порции.
                    to_char(c.started_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS started_at_key,
                    c.our_number, c.outcome, c.outcome_raw, c.answered, c.transferred,
                    c.is_internal, c.wait_seconds, c.talk_seconds, c.record_id,
                    c.funnel_status_name, c.notes_snapshot, c.attempt_no,
                    c.operator_extension, c.partially_filled,
                    -- ОФФЕРЫ ПЕРЕВОДА ОДНОЙ СТРОКОЙ — для выгрузки. На экране их
                    -- показывает разворот, отдельным запросом; в файле развернуть
                    -- нечего, и колонка обязана назвать ВСЕ, а не последний:
                    -- переводов у звонка бывает несколько (паспорт Р1 ред. 8).
                    (SELECT string_agg(sg.transfer_offer_name, ', ' ORDER BY sg.position)
                       FROM call_segments sg
                      WHERE sg.call_id = c.id AND sg.transfer_offer_name IS NOT NULL) AS transfer_offers,
                    e.last_name, e.first_name, e.middle_name, e.line_type,
                    -- ПРИЗНАК «СТАТУС ЖДЁТ РЕШЕНИЯ РУКОВОДИТЕЛЯ» ЕДЕТ ВМЕСТЕ С
                    -- ИМЕНЕМ (К246, паспорт Р1 редакции 11, состояние 17в). Тот
                    -- же приём, что в списке лидов (routes/leadsAdmin.js,
                    -- выражение fs.awaits_manager AS status_awaits_manager), и
                    -- по ТОЙ ЖЕ колонке: красным помечается один статус, а не
                    -- оба системных. «Не ответил после N перезвонов» тоже
                    -- системный, и по нему работа кончена — тревоги в нём нет.
                    --
                    -- ⚠ МЕСТО НАЗВАНО ВЫРАЖЕНИЕМ, А НЕ НОМЕРОМ СТРОКИ, и это
                    -- нарочно: номер уедет первым же слиянием. В списке лидов
                    -- признак сперва был is_system — это К245; на awaits_manager
                    -- его перевела К260, и до её вливания там стоит прежнее.
                    -- Комментарий описывает то, что будет в главной, а не то,
                    -- что лежит в ней сейчас.
                    --
                    -- СОЕДИНЕНИЕ ПО ИДЕНТИФИКАТОРУ, А НЕ ПО ИМЕНИ. Имя лежит в
                    -- звонке снимком и переживает переименование статуса; когда
                    -- статус удалён, calls.funnel_status_id обнуляется
                    -- (ON DELETE SET NULL), признак приходит пустым, и пилюля
                    -- остаётся нейтральной — состояние 17б. Красить по имени
                    -- значило бы гадать, ждал ли он тогда руководителя.
                    --
                    -- ⚠ ОБРАТНЫХ КАВЫЧЕК ЗДЕСЬ БЫТЬ НЕ МОЖЕТ: этот текст лежит
                    -- ВНУТРИ шаблонной строки, и первая же закрыла бы её.
                    fs.awaits_manager AS status_awaits_manager
             ${from}
              LEFT JOIN lead_funnel_statuses fs ON fs.id = c.funnel_status_id
              WHERE ${listWhere}
              ORDER BY c.started_at DESC NULLS LAST, c.id DESC
              LIMIT ${limit}`,
            params
        );

        const rows = list.rows.map((r) => ({
            id: r.id,
            startedAt: r.started_at,
            direction: r.direction,
            clientPhone: r.client_phone,
            leadId: r.lead_id,
            attemptNo: r.attempt_no,
            lineType: r.line_type || null,
            operator: r.last_name ? shortName(r) : null,
            // Добавочный — СНИМОК звонка, а не сегодняшний номер сотрудника:
            // номер освобождается при выводе из работы и выдаётся другому.
            operatorExtension: r.operator_extension || null,
            ourNumber: r.our_number,
            outcome: r.outcome,
            outcomeRaw: r.outcome_raw,
            answered: r.answered,
            transferred: r.transferred,
            isInternal: r.is_internal,
            waitSeconds: r.wait_seconds,
            talkSeconds: r.talk_seconds,
            funnelStatus: r.funnel_status_name,
            // Пустым он приходит в двух случаях, и оба законны: статуса у
            // звонка не было вовсе и статус с тех пор удалён (состояние 17б).
            funnelStatusAwaitsManager: r.status_awaits_manager,
            notes: r.notes_snapshot,
            // Пометка — СНИМОК звонка, а не сегодняшнее состояние лида. Иначе
            // запись о прошлом разговоре меняла бы смысл каждый раз, когда
            // карточку дописывают: тот же приём, что у статуса и комментария
            // двумя строками выше.
            partiallyFilled: r.partially_filled,
            transferOffers: r.transfer_offers,
            hasRecord: Boolean(r.record_id)
        }));

        res.json({
            rows,
            total,
            counts: {
                dialed,
                answered,
                // Процент считается ЗДЕСЬ, а не в браузере: доля от нуля — это
                // не ноль процентов, а «нечего делить», и решать это должно одно
                // место, а не каждый экран по-своему.
                rate: dialed > 0 ? Math.round((answered / dialed) * 100) : null
            },
            // «ЕСТЬ ЕЩЁ» СЧИТАЕТСЯ ПО ПОРЦИИ, А НЕ ПО СУММЕ ПОКАЗАННОГО.
            // При курсоре складывать нечего: полная порция означает, что за ней
            // почти наверняка есть строки, неполная — что это конец. Сравнивать
            // с `total` нельзя вовсе: счётчик считается по всему отбору, а
            // курсор уже отрезал прочитанное.
            // Отбор, который сервер на самом деле применил. Экран не
            // пересчитывает его у себя: «сегодня» знает одна сторона.
            filters: { from: filters.from, to: filters.to, periodIsDefault },
            hasMore: !wantExport && rows.length === limit,
            // Точка отсчёта следующей порции. Отдаётся сервером, а не собирается
            // браузером из последней строки: кто задаёт порядок, тот и говорит,
            // где остановились.
            cursor: rows.length
                ? { at: list.rows[list.rows.length - 1].started_at_key, id: list.rows[list.rows.length - 1].id }
                : null,
            serverNow: new Date().toISOString(),
            pbx: pbxState()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить журнал звонков' });
    }
});

// ---------------------------------------------------------------- цепочка перевода
//
// Участники одного звонка по порядку: «Абрамова А. А. 1:20 → перевод → Волков
// П. С. 4:05». Отдельным запросом, а не вместе со списком: перевод бывает у
// доли звонков, и тянуть участки на каждую из тридцати строк значит платить за
// то, чего человек в большинстве строк не откроет.
router.get('/:id/chain', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Неверный номер звонка' });

        const result = await pool.query(
            `SELECT s.position, s.talk_seconds, s.operator_extension,
                    e.last_name, e.first_name, e.middle_name,
                    -- ОФФЕР ПЕРЕВОДА — СНИМКАМИ, а не через связь (часть 9,
                    -- заход 5). Офферы удаляются по-настоящему, и джойн вернул
                    -- бы пусто там, где перевод точно был. Ссылка рядом живёт
                    -- для тех, кто пойдёт от звонка к живому офферу.
                    s.transfer_offer_id, s.transfer_offer_name, s.transfer_network_name
               FROM call_segments s
               LEFT JOIN employees e ON e.id = s.employee_id
              WHERE s.call_id = $1
              ORDER BY s.position, s.id`,
            [id]
        );

        res.json({
            rows: result.rows.map((r) => ({
                position: r.position,
                name: r.last_name ? shortName(r) : null,
                extension: r.operator_extension || null,
                talkSeconds: r.talk_seconds,
                // Звено перевода партнёру: сотрудника у него нет вовсе, вместо
                // фамилии — имя оффера, а сеть подстрокой. Все звенья, а не
                // последнее: переводов у звонка бывает несколько (паспорт Р1).
                transferOfferId: r.transfer_offer_id,
                transferOfferName: r.transfer_offer_name,
                transferNetworkName: r.transfer_network_name
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить цепочку перевода' });
    }
});

// ---------------------------------------------------------------- запись разговора
//
// ЗАПИСЬ ЖИВЁТ У ОПЕРАТОРА СВЯЗИ, а не у нас (план 8.2): мы храним только её
// идентификатор и возвращаем его станции. Значит без станции запись не открыть
// вовсе, и отказ должен быть отличим от «записи не существует»:
//
//   записи нет         — кнопки нет вовсе, `record_id` пуст;
//   запись не хранится — кнопка неактивна с объяснением (срок хранения у
//                        оператора связи истёк), это ответ, а не ошибка;
//   станция молчит     — вот это отказ, и он приходит сюда.
router.get('/:id/recording', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Неверный номер звонка' });

        const found = await pool.query('SELECT record_id FROM calls WHERE id = $1', [id]);
        if (!found.rows.length) return res.status(404).json({ error: 'Звонок не найден' });
        if (!found.rows[0].record_id) {
            return res.status(404).json({ code: 'no_record', error: 'У этого звонка записи нет' });
        }

        const pbx = pbxState();
        if (!pbx.available) {
            return res.status(503).json({
                code: 'pbx_unavailable',
                error: pbx.configured
                    ? 'Нет связи с телефонией — запись сейчас не открыть'
                    : 'Телефония ещё не подключена — записи недоступны'
            });
        }

        // Сюда придёт обращение к Телфину за ссылкой на запись (этап Е).
        res.status(503).json({ code: 'pbx_unavailable', error: 'Нет связи с телефонией — запись сейчас не открыть' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось открыть запись разговора' });
    }
});

// ---------------------------------------------------------------- разбор запроса

function readFilters(query) {
    const toDate = (value, fallback) => {
        const text = String(value || '').trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
    };
    // ПЕРИОД ПО УМОЛЧАНИЮ — СЕГОДНЯ. Звонки смотрят, чтобы видеть, что
    // происходит сейчас; этим они и отличаются от журнала изменений, где
    // умолчание — семь дней (решение куратора по Р5).
    const day = todayIso();
    return {
        from: toDate(query.from, day),
        to: toDate(query.to, day),
        employeeId: intOrNull(query.employeeId),
        outcome: OUTCOMES.includes(query.outcome) ? query.outcome : null,
        direction: ['in', 'out'].includes(query.direction) ? query.direction : null,
        lineType: ['Входящая', 'Исходящая'].includes(query.lineType) ? query.lineType : null,
        sourceId: intOrNull(query.sourceId),
        withRecord: query.withRecord === '1',
        search: String(query.search || '').trim().slice(0, 64)
    };
}

function intOrNull(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// СЕГОДНЯ — ПО ПОЯСУ ПРИЛОЖЕНИЯ, а не по часам контейнера. На бою сервер идёт в
// UTC, и «сегодня», взятое у него напрямую, начиналось бы в три часа ночи по
// Москве: с полуночи до трёх раздел показывал бы вчерашнюю смену как сегодняшнюю
// (та же ловушка, ради которой заведён services/appTime.js).
function todayIso() {
    const p = zonedParts(new Date());
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** «Абрамова А. А.» — тот же вид, что в журнале изменений и в панели оператора. */
function shortName(row) {
    const initials = [row.first_name, row.middle_name]
        .filter(Boolean)
        .map((part) => `${String(part).trim().charAt(0).toUpperCase()}.`)
        .join(' ');
    return [row.last_name, initials].filter(Boolean).join(' ');
}

module.exports = router;
