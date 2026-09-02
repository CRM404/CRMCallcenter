// --- routes/callEvents.js: три события руководителя ---------------------------
//
// Вкладка «Звонки → События» (паспорт Р12). Числа, стоявшие константами в коде,
// настраивает руководитель: интервал и предел автоперезвона, окно обзвона,
// адресаты перевода и длительность пост-обработки.
//
// СОБЫТИЙ РОВНО ТРИ, И ЧЕТВЁРТОГО НЕ БЫВАЕТ. Каждое отвечает за своё место в
// коде, а «добавить событие» означало бы «добавить поведение». Поэтому маршрута
// «завести событие» здесь нет: есть три адреса по числу видов.
//
// ⚠ БЫЛО ЧЕТЫРЕ. Решение владельца 109 (К259) сняло «Время перевода»: ожидание
// соединения стало полем строки — своим у каждого сотрудника, ровно как у
// оффера. Вместе с событием ушёл и адрес `PUT /transfer-wait`: одно число
// сохраняется теперь тем же запросом, что и вся строка перевода.
//
// СОХРАНЕНИЕ СОБЫТИЯ — РАЗНИЦЕЙ, А НЕ ЗАМЕНОЙ ПЕРЕЧНЯ. Соблазн велик: снести все
// строки и вставить пришедшие. Так нельзя из-за журнала изменений: правка одного
// интервала читалась бы как «удалено пять строк, заведено пять строк», и найти в
// истории, кто поменял именно это число, стало бы невозможно. Строка, у которой
// есть `id`, правится; без `id` — заводится; пропавшая — удаляется.

const express = require('express');
const { pool } = require('../db');
const { withTransaction } = require('../services/dbTx');
const { normalizePhone } = require('../services/phoneFormat');
const { zonedParts } = require('../services/appTime');
const { offerStatusLabel } = require('../services/offerStatus');

const router = express.Router();

// Вид события в адресе — через дефис, в базе — через подчёркивание.
const KIND_BY_SLUG = {
    'auto-recall': 'auto_recall',
    transfer: 'transfer',
    wrapup: 'wrapup'
};

// Линия у пары пост-обработки — та же колонка, что у сотрудника и у лида
// (`employees.line_type`), и те же два значения. Перечень проверяется на API, а
// не CHECK-ом в базе: так живут все три места, где линия встречается.
const LINE_TYPES = ['Входящая', 'Исходящая'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

function isTime(value) {
    return typeof value === 'string' && TIME_RE.test(value.trim());
}

// «HH:MM» из «HH:MM» или «HH:MM:SS» — база отдаёт TIME строкой с секундами, а
// поле формы работает с минутами.
function shortTime(value) {
    return value === null || value === undefined ? null : String(value).slice(0, 5);
}

// Целое в заданных границах. Пусто — НЕ ноль: у события все поля обязательны, и
// «не заполнено» обязано отличаться от «заполнено нулём».
function wholeNumber(value, min, max) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
}

function weekdays(value) {
    if (!Array.isArray(value)) return null;
    const days = value.map((d) => Number(d));
    if (!days.length || days.length > 7) return null;
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return null;
    if (new Set(days).size !== days.length) return null;
    return days.sort((a, b) => a - b);
}

function bad(res, error) {
    return res.status(400).json({ error });
}

/**
 * Отказ, НАЗЫВАЮЩИЙ СТРОКУ.
 *
 * `bad()` общая на весь маршрут, и менять её ради одного случая значит менять
 * всем (ответ куратора 7). Поэтому рядом заведена своя: экран по `offerId`
 * находит строку и подсвечивает её поле.
 *
 * Довод: без номера строки человек читает «этот номер уже стоит у оффера сети
 * „…“» и ищет глазами, В КАКОЙ ИЗ СЕМИ строк. Отказ, не показывающий места,
 * наполовину бесполезен.
 */
function badRow(res, error, offerId) {
    return res.status(400).json({ error, offerId });
}

/**
 * Текст отказа «одна сеть на номер».
 *
 * ⚠ СЛОВО В СЛОВО ТОТ ЖЕ, ЧТО НА ЭКРАНЕ (`Calls/js/modules/callsEvents.js`,
 * `ONE_NETWORK_ERROR`). Двух формулировок одного отказа быть не должно — то же
 * правило, по которому отказ по неразобранному номеру берётся из справочника, а
 * не сочиняется рядом (см. `reasonTitle` выше). Экран и сервер — разные среды
 * (CommonJS против ESM), общего модуля у них нет; связь держится этой пометкой
 * с обеих сторон.
 *
 * НАЗЫВАЕТСЯ ЧУЖАЯ СЕТЬ, А НЕ СВОЯ: своя человеку и так видна в строке.
 */
function oneNetworkError(networkName) {
    return `Этот номер уже стоит у оффера сети «${networkName}» — `
        + 'у одного номера может быть только одна сеть';
}

/**
 * «ОДНА СЕТЬ НА НОМЕР» — ПРАВИЛО ДАННЫХ, А НЕ ЗАПРЕТ ФОРМЫ (К265, решение
 * владельца 118).
 *
 * Строки перевода с одним и тем же `transfer_phone` обязаны принадлежать
 * офферам ОДНОЙ сети. Отказ независим от того, как строки заводили: окном
 * множественного выбора, по одной или запросом мимо экрана.
 *
 * ⚠ ЭТО ШИРЕ РЕШЕНИЯ 108, где сказано «запрещается формой». Запрет жил только в
 * окне выбора (`callsEvents.js`, `pickedNetwork`), и две дыры оставались
 * открытыми: ДВА РАЗДЕЛЬНЫХ ВЫБОРА с одним номером — второй о первом не знает
 * вовсе; и ПРАВКА НОМЕРА в уже стоящей строке — поле правится всегда.
 *
 * ⚠ ПРОВЕРЯЕТСЯ ВЕСЬ ПЕРЕЧЕНЬ, а не только новые строки: правило про данные, а
 * не про действие.
 *
 * ⚠ ВЫКЛЮЧЕННЫЕ СТРОКИ ВХОДЯТ (ответ куратора 11). Строка выключена, а номер в
 * ней лежит; включат — и нарушение оживёт МОЛЧА, без единого действия человека.
 *
 * ⚠ СЕТЬ БЕРЁТСЯ ЗАПРОСОМ, А НЕ ИЗ ТЕЛА: `networkId` шлёт экран, а экран
 * проверяем мы же.
 *
 * ⚠ НОМЕР СРАВНИВАЕТСЯ ПРИВЕДЁННЫЙ — к этому месту он уже прошёл
 * `normalizePhone`. База хранит `+7XXXXXXXXXX`, и сравнивать «как набрали»
 * значило бы противоречить самим себе.
 *
 * НАРУШЕНИЙ В БОЮ НА ДЕНЬ ЗАВЕДЕНИЯ ПРАВИЛА НЕ БЫЛО: строк перевода ноль
 * (замеры куратора 30.08 и 02.09.2026). Миграции нет, потому что чинить нечего,
 * — а не потому, что о ней забыли.
 */
async function oneNetworkPerPhone(db, offers) {
    if (offers.length < 2) return null;
    const { rows } = await db.query(
        `SELECT o.id, o.network_id, n.name AS network_name
           FROM real_estate_offers o
           JOIN cpa_networks n ON n.id = o.network_id
          WHERE o.id = ANY($1::int[])`,
        [offers.map((r) => r.offerId)]);
    const netOf = new Map(rows.map((r) => [r.id, r]));
    // Номер -> первая встреченная строка с ним. Порядок перечня — порядок
    // экрана, и «первая чужая» для человека значит «верхняя».
    const firstByPhone = new Map();
    for (const row of offers) {
        const own = netOf.get(row.offerId);
        // Оффера нет в базе — это не наш случай: связь отобьётся при записи
        // внешним ключом, и сочинять здесь второй отказ незачем.
        if (!own) continue;
        const seen = firstByPhone.get(row.phone);
        if (!seen) { firstByPhone.set(row.phone, own); continue; }
        if (seen.network_id === own.network_id) continue;
        // ⚠ НАЗЫВАЕТСЯ ПЕРВАЯ ЧУЖАЯ СЕТЬ, А НЕ ПЕРЕЧИСЛЯЮТСЯ ВСЕ (ответ 16):
        // отказ должен быть действенным, а не полным. Человек правит одну
        // строку, пересохраняет и видит следующую; перечень трёх сетей в одной
        // фразе не читается.
        return { offerId: row.offerId, error: oneNetworkError(seen.network_name) };
    }
    return null;
}

/**
 * Человеческий текст причины, по которой номер не разобрался.
 *
 * ИЗ СПРАВОЧНИКА `phone_fix_reasons`, а не из константы рядом: ровно этот текст
 * человек видит на экране разбора номеров, и вторая формулировка того же отказа
 * означала бы, что один и тот же номер отвергается «по разным причинам».
 *
 * ОТКАЗ САМ ПО СЕБЕ НЕ ПАДАЕТ ИЗ-ЗА СПРАВОЧНИКА. Не доехало имя — отказ всё
 * равно состоится, просто текст будет беднее: сохранять неразобранный номер
 * нельзя в любом случае, а падение здесь превратило бы отказ проверки в
 * пятисотую ошибку.
 */
async function reasonTitle(code) {
    try {
        const result = await pool.query('SELECT title FROM phone_fix_reasons WHERE code = $1', [code]);
        if (result.rows[0]) return result.rows[0].title;
    } catch (err) {
        console.error(err);
    }
    return 'Номер не разобрался — проверьте, что это городской или мобильный номер';
}

// ---------------------------------------------------------------- чтение

/**
 * Почему строка перевода видна и не работает — ИЛИ null, если работает.
 *
 * СЧИТАЕТ СЕРВЕР, А НЕ ЭКРАН. Причины две из трёх завязаны на «сегодня», а
 * «сегодня» в проекте берётся только с сервера (К198): часы у руководителя
 * могут стоять в другом поясе, и оффер, закончившийся вчера, выглядел бы у него
 * живым. Браузер здесь не решает ничего.
 *
 * ПОРЯДОК ПРИЧИН НЕ АЛФАВИТНЫЙ. Выключенный оффер остаётся выключенным и после
 * продления, поэтому «не активен» называется раньше «закончился»: иначе человек
 * пойдёт продлевать оффер, а перевод всё равно не заработает.
 */
function offerBlock(row, today) {
    if (row.offer_status !== 'active') return 'inactive';
    if (row.date_end && isoDate(row.date_end) < today) return 'expired';
    return null;
}

function employeeBlock(row) {
    if (row.employee_status !== 'active') return 'inactive';
    if (!row.pbx_extension || !String(row.pbx_extension).trim()) return 'no_extension';
    return null;
}

// «Сегодня» в поясе приложения, «ГГГГ-ММ-ДД». База живёт в UTC (паспорт
// установки), и CURRENT_DATE в ней с 21:00 до полуночи по Москве показывает
// вчерашний день.
function todayInAppZone() {
    const p = zonedParts(new Date());
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// DATE ПРИЕЗЖАЕТ СТРОКОЙ, И ЭТО НЕ СЛУЧАЙНОСТЬ ЭТОГО МАРШРУТА: `db.js:7`
// объявляет разбор типа 1082 как `val => val` на весь проект. Здесь остаётся
// только отрезать возможное время — сравнение идёт строками одного вида.
//
// Первая редакция держала ещё ветку с `zonedParts` на случай объекта Date. Ветка
// была мёртвой с самого начала, и в отчёте это было названо «пятым добавлением
// сервера» — неверно. Замер куратора: тип `string`, значение `"2026-08-27"`.
function isoDate(value) {
    return value ? String(value).slice(0, 10) : null;
}

async function readEvents(db) {
    const [events, rules, pairs, offers, employees] = await Promise.all([
        db.query(
            `SELECT e.kind, e.enabled, e.window_from, e.window_to,
                    e.wrapup_status_id, s.status_name AS wrapup_status_name
               FROM call_events e
               LEFT JOIN lead_funnel_statuses s ON s.id = e.wrapup_status_id
              ORDER BY e.kind`),
        db.query(
            `SELECT r.id, r.funnel_status_id, r.interval_minutes, r.max_attempts, r.after_limit_status_id,
                    s.status_name, s.stage_number, s.stage_name,
                    a.status_name AS after_status_name, a.mark AS after_status_mark
               FROM call_recall_rules r
               JOIN lead_funnel_statuses s ON s.id = r.funnel_status_id
               JOIN lead_funnel_statuses a ON a.id = r.after_limit_status_id
              ORDER BY s.stage_number, s.sort_order`),
        db.query(
            `SELECT p.id, p.line_type, p.script_id, p.duration_seconds, sc.title AS script_title
               FROM call_wrapup_rules p
               JOIN scripts sc ON sc.id = p.script_id
              ORDER BY p.line_type, sc.title`),
        // Порядок строк перевода — ПО ПРИОРИТЕТУ ОФФЕРА, затем по номеру записи.
        // Явно и всегда: без второй половины одна и та же выборка возвращает
        // разное между запросами, а после миграции у всех офферов приоритет 1 —
        // то есть неявный порядок сломается сразу, а не когда-нибудь.
        db.query(
            `SELECT t.id, t.offer_id, t.transfer_phone, t.weekdays, t.time_from, t.time_to,
                    t.wait_seconds, t.enabled,
                    o.name AS offer_name, o.priority, o.status AS offer_status, o.date_end,
                    n.name AS network_name
               FROM call_transfer_offers t
               JOIN real_estate_offers o ON o.id = t.offer_id
               JOIN cpa_networks n ON n.id = o.network_id
              ORDER BY o.priority NULLS LAST, o.id`),
        db.query(
            `SELECT e.id, e.employee_id, e.weekdays, e.time_from, e.time_to,
                    e.wait_seconds, e.enabled,
                    p.last_name, p.first_name, p.pbx_extension, p.status AS employee_status
               FROM call_transfer_employees e
               JOIN employees p ON p.id = e.employee_id
              ORDER BY p.last_name, p.first_name`)
    ]);

    const byKind = new Map(events.rows.map((r) => [r.kind, r]));
    const one = (kind) => byKind.get(kind) || { enabled: false, window_from: null, window_to: null };

    const recall = one('auto_recall');
    const today = todayInAppZone();

    return {
        autoRecall: {
            enabled: recall.enabled,
            windowFrom: shortTime(recall.window_from),
            windowTo: shortTime(recall.window_to),
            rules: rules.rows.map((r) => ({
                id: r.id,
                funnelStatusId: r.funnel_status_id,
                statusName: r.status_name,
                stageNumber: r.stage_number,
                stageName: r.stage_name,
                intervalMinutes: r.interval_minutes,
                maxAttempts: r.max_attempts,
                afterLimitStatusId: r.after_limit_status_id,
                afterStatusName: r.after_status_name,
                // Пометка целевого статуса едет вместе с именем: строка-итог
                // события называет не только «куда», но и «что из этого
                // выйдет» — «лид уходит в архив сам». Считать это на экране по
                // второму справочнику значило бы держать два ответа на один
                // вопрос.
                afterStatusMark: r.after_status_mark
            }))
        },
        transfer: {
            enabled: one('transfer').enabled,
            offers: offers.rows.map((r) => ({
                id: r.id,
                offerId: r.offer_id,
                offerName: r.offer_name,
                networkName: r.network_name,
                priority: r.priority,
                // Причины, по которым строка видна и не работает (паспорт Р12).
                // Считает их сервер — экран не решает, что живо; сами значения
                // едут рядом, потому что текст плашки называет и дату, и вид
                // состояния оффера.
                blockedReason: offerBlock(r, today),
                offerStatus: r.offer_status,
                // ПОДПИСЬ, А НЕ КЛЮЧ (К229). Плашка отправляет человека чинить
                // оффер в «CPA-сети» и обязана назвать состояние тем же словом,
                // которым его называют там: он придёт искать «paused», а увидит
                // «На паузе».
                offerStatusLabel: offerStatusLabel(r.offer_status),
                dateEnd: isoDate(r.date_end),
                transferPhone: r.transfer_phone,
                weekdays: r.weekdays,
                timeFrom: shortTime(r.time_from),
                timeTo: shortTime(r.time_to),
                waitSeconds: r.wait_seconds,
                enabled: r.enabled
            })),
            employees: employees.rows.map((r) => ({
                id: r.id,
                employeeId: r.employee_id,
                fullName: `${r.last_name} ${r.first_name}`,
                // Живого состояния сотрудника здесь НЕТ, и это решение паспорта:
                // «занят разговором» протухнет через минуту после открытия окна.
                // Серым показывается только постоянное — снят внутренний номер
                // или выведен из работы.
                blockedReason: employeeBlock(r),
                extension: r.pbx_extension,
                employeeStatus: r.employee_status,
                weekdays: r.weekdays,
                timeFrom: shortTime(r.time_from),
                timeTo: shortTime(r.time_to),
                // Ожидание своё у каждой строки — решение владельца 109 (К259).
                // Поле то же, что у оффера, и приезжает тем же именем: два
                // перечня одного окна не должны называть одно разными словами.
                waitSeconds: r.wait_seconds,
                enabled: r.enabled
            }))
        },
        wrapup: {
            enabled: one('wrapup').enabled,
            // Целевой статус тайм-аута — ПОЛЕ СОБЫТИЯ, а не поиск по имени
            // (решение куратора В-2). Показывается строкой: правку его владелец
            // не заказывал, и открывать её «заодно» значило бы завести
            // поведение, которого никто не просил.
            statusId: one('wrapup').wrapup_status_id || null,
            statusName: one('wrapup').wrapup_status_name || null,
            pairs: pairs.rows.map((r) => ({
                id: r.id,
                lineType: r.line_type,
                scriptId: r.script_id,
                scriptTitle: r.script_title,
                durationSeconds: r.duration_seconds
            }))
        }
    };
}

// GET /api/call-events — все три события со своими перечнями.
router.get('/', async (req, res) => {
    try {
        res.json(await readEvents(pool));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить события' });
    }
});

// GET /api/call-events/directories — справочники ТРЁХ окон одним ответом.
//
// ОДИН ЗАПРОС, А НЕ ЧЕТЫРЕ ЧУЖИХ. Окна события выбирают статус, скрипт, оффер и
// сотрудника; три из четырёх справочников живут в чужих разделах, и брать их
// оттуда значило бы связать вкладку с чужими маршрутами ради выпадающих списков.
// Здесь они собраны в том виде, в каком их показывает паспорт Р12, — и только в
// том: полных карточек ни у оффера, ни у сотрудника вкладке не нужно.
//
// ⚠ ОФФЕРЫ ОТДАЮТСЯ ЦЕЛИКОМ, И ЭТО ВЕРНО ПОКА ИХ ДЕСЯТКИ. Замер боевой базы
// 27.08.2026 — 39 офферов; паспорт говорит «офферов десятки» и рисует обычный
// список. Комментарий в `realEstateOffers.js:301` называет число ≈38 000 —
// это замер другого времени, и если оно вернётся, здесь появится поиск с
// пределом, как у «Лидов» (`GET /real-estate-offers/search`). Молча отдавать
// первые N нельзя: список, потерявший строки без единого слова, читается как
// «такого оффера у нас нет», и человек заведёт второй.
router.get('/directories', async (req, res) => {
    try {
        const [statuses, scripts, offers, employees] = await Promise.all([
            pool.query(
                `SELECT id, stage_number, stage_name, status_name, mark
                   FROM lead_funnel_statuses ORDER BY stage_number, sort_order`),
            pool.query('SELECT id, title FROM scripts ORDER BY title, id'),
            // НОМЕР СЕТИ, А НЕ ТОЛЬКО ИМЯ (К255). Окно «Добавить офферы»
            // сравнивает сети между собой: первый отмеченный оффер выключает
            // офферы чужих сетей. Сравнивать по имени нельзя — `cpa_networks`
            // объявлена без `UNIQUE` на `name` (`schema.sql:401-409`), и две
            // одноимённые сети слились бы в одну молча. Имя тоже едет: его
            // показывают подстрокой и называют им причину выключения.
            pool.query(
                `SELECT o.id, o.name, o.priority, o.network_id, n.name AS network_name
                   FROM real_estate_offers o
                   JOIN cpa_networks n ON n.id = o.network_id
                  ORDER BY o.priority NULLS LAST, o.id`),
            // ТОЛЬКО ТЕ, У КОГО ЗАПОЛНЕН ВНУТРЕННИЙ НОМЕР, и только работающие
            // (паспорт Р12). Переводить на сотрудника без добавочного некуда, а
            // выведенный из работы не возьмёт трубку никогда. Уже заведённые
            // строки при этом остаются видимыми и объясняют себя сами — их
            // отдаёт `GET /` вместе с состоянием сотрудника.
            pool.query(
                `SELECT id, last_name, first_name, pbx_extension
                   FROM employees
                  WHERE status = 'active' AND pbx_extension IS NOT NULL AND btrim(pbx_extension) <> ''
                  ORDER BY last_name, first_name`)
        ]);
        res.json({
            statuses: statuses.rows.map((r) => ({
                id: r.id,
                stageNumber: r.stage_number,
                stageName: r.stage_name,
                statusName: r.status_name,
                // null — не размечен: целевым такой статус выбрать нельзя, но в
                // списке он виден выключенным. Спрятанный читался бы как «такого
                // статуса нет», и человек пошёл бы искать ошибку не туда.
                mark: r.mark
            })),
            scripts: scripts.rows.map((r) => ({ id: r.id, title: r.title })),
            offers: offers.rows.map((r) => ({
                id: r.id,
                name: r.name,
                networkId: r.network_id,
                networkName: r.network_name,
                priority: r.priority
            })),
            employees: employees.rows.map((r) => ({
                id: r.id,
                fullName: `${r.last_name} ${r.first_name}`,
                extension: r.pbx_extension
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить справочники событий' });
    }
});

// PUT /api/call-events/:slug/enabled { enabled } — выключатель на самой вкладке.
//
// СВОЙ АДРЕС, А НЕ ЧАСТЬ СОХРАНЕНИЯ СОБЫТИЯ. Выключатель стоит в строке события,
// а не в окне, и срабатывает сразу; слать вместе с ним весь перечень значило бы
// отправлять настройку целиком ради одной галочки — и затирать правку, сделанную
// в окне между чтением списка и щелчком.
router.put('/:slug/enabled', async (req, res) => {
    const kind = KIND_BY_SLUG[req.params.slug];
    if (!kind) return res.status(404).json({ error: 'Такого события нет' });
    try {
        const result = await pool.query(
            'UPDATE call_events SET enabled = $1, updated_at = NOW() WHERE kind = $2 RETURNING kind',
            [Boolean(req.body && req.body.enabled), kind]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Событие не заведено' });
        res.json({ kind, enabled: Boolean(req.body.enabled) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось переключить событие' });
    }
});

/**
 * Разница между тем, что было, и тем, что пришло.
 *
 * Возвращает три списка: что завести, что поправить, что удалить. Ключ — `id`
 * строки; пришедшая без него считается новой.
 */
function diffRows(existing, incoming) {
    const keep = new Set(incoming.filter((r) => r.id).map((r) => Number(r.id)));
    return {
        insert: incoming.filter((r) => !r.id),
        update: incoming.filter((r) => r.id && existing.has(Number(r.id))),
        remove: [...existing].filter((id) => !keep.has(id))
    };
}

async function idsOf(client, table) {
    const result = await client.query(`SELECT id FROM ${table}`);
    return new Set(result.rows.map((r) => r.id));
}

// PUT /api/call-events/auto-recall
router.put('/auto-recall', async (req, res) => {
    const body = req.body || {};
    const from = isTime(body.windowFrom) ? String(body.windowFrom).trim() : null;
    const to = isTime(body.windowTo) ? String(body.windowTo).trim() : null;
    const rows = Array.isArray(body.rules) ? body.rules : [];

    // ОКНО — ПАРА, И ПОЛОВИНЫ ОКНА НЕ БЫВАЕТ. То же правило, что в базе
    // (`call_events_window_pair_check`), только сказанное человеку словами.
    if (Boolean(from) !== Boolean(to)) {
        return bad(res, 'Рабочее окно задаётся парой: заполните и «с», и «до»');
    }
    if (from && from === to) {
        return bad(res, 'Окно нулевой длины — это «никогда»: время «с» и «до» должны отличаться');
    }

    const clean = [];
    for (const row of rows) {
        const statusId = wholeNumber(row.funnelStatusId, 1, 2147483647);
        const interval = wholeNumber(row.intervalMinutes, 1, 60 * 24 * 30);
        const limit = wholeNumber(row.maxAttempts, 1, 1000);
        const after = wholeNumber(row.afterLimitStatusId, 1, 2147483647);
        if (statusId === null) return bad(res, 'В строке автоперезвона не выбран статус');
        if (interval === null) return bad(res, 'Интервал — целое число минут больше нуля');
        if (limit === null) return bad(res, 'Предел попыток — целое число больше нуля');
        if (after === null) return bad(res, 'В строке автоперезвона не выбран статус после предела');
        clean.push({ id: row.id ? Number(row.id) : null, statusId, interval, limit, after });
    }

    const seen = new Set();
    for (const row of clean) {
        if (seen.has(row.statusId)) return bad(res, 'Один статус — одна строка автоперезвона');
        seen.add(row.statusId);
    }

    try {
        // ЦЕЛЕВЫМ МОЖНО ВЫБРАТЬ ТОЛЬКО РАЗМЕЧЕННЫЙ СТАТУС. Пока у статуса не
        // сказано, окончательный он или промежуточный, система не знает, уходить
        // ли лиду в архив, — и выбор запрещён. Проверка стоит ЗДЕСЬ, а не только
        // на экране: окно заведения статуса обещает это человеку словами, и
        // обещание должно держаться при любом пути к маршруту.
        if (clean.length) {
            const targets = [...new Set(clean.map((r) => r.after))];
            const marks = await pool.query(
                'SELECT id, status_name, mark FROM lead_funnel_statuses WHERE id = ANY($1::int[])', [targets]);
            if (marks.rows.length !== targets.length) return bad(res, 'Выбран статус, которого нет в справочнике');
            const unmarked = marks.rows.find((r) => !r.mark);
            if (unmarked) {
                return bad(res, `Статус «${unmarked.status_name}» не размечен: пока не сказано, `
                    + 'окончательный он или промежуточный, целевым его выбрать нельзя');
            }
        }

        await withTransaction(pool, async (client) => {
            const existing = await idsOf(client, 'call_recall_rules');
            const { insert, update, remove } = diffRows(existing, clean);
            for (const row of insert) {
                await client.query(
                    `INSERT INTO call_recall_rules
                        (funnel_status_id, interval_minutes, max_attempts, after_limit_status_id)
                     VALUES ($1, $2, $3, $4)`,
                    [row.statusId, row.interval, row.limit, row.after]);
            }
            for (const row of update) {
                await client.query(
                    `UPDATE call_recall_rules
                        SET funnel_status_id = $1, interval_minutes = $2, max_attempts = $3,
                            after_limit_status_id = $4
                      WHERE id = $5`,
                    [row.statusId, row.interval, row.limit, row.after, row.id]);
            }
            if (remove.length) {
                await client.query('DELETE FROM call_recall_rules WHERE id = ANY($1::int[])', [remove]);
            }
            await client.query(
                `UPDATE call_events SET window_from = $1::time, window_to = $2::time, updated_at = NOW()
                  WHERE kind = 'auto_recall'`, [from, to]);
        });
        res.json(await readEvents(pool));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить автоперезвон' });
    }
});

// PUT /api/call-events/wrapup
router.put('/wrapup', async (req, res) => {
    const rows = Array.isArray(req.body && req.body.pairs) ? req.body.pairs : [];
    const clean = [];
    for (const row of rows) {
        const line = String(row.lineType || '').trim();
        const scriptId = wholeNumber(row.scriptId, 1, 2147483647);
        const seconds = wholeNumber(row.durationSeconds, 1, 60 * 60 * 12);
        if (!LINE_TYPES.includes(line)) return bad(res, 'В строке пост-обработки не выбрана линия');
        if (scriptId === null) return bad(res, 'В строке пост-обработки не выбран скрипт');
        if (seconds === null) return bad(res, 'Длительность — целое число секунд больше нуля');
        clean.push({ id: row.id ? Number(row.id) : null, line, scriptId, seconds });
    }
    const seen = new Set();
    for (const row of clean) {
        const key = `${row.line}|${row.scriptId}`;
        if (seen.has(key)) return bad(res, 'Одна пара «линия + скрипт» — одна строка');
        seen.add(key);
    }
    try {
        await withTransaction(pool, async (client) => {
            const existing = await idsOf(client, 'call_wrapup_rules');
            const { insert, update, remove } = diffRows(existing, clean);
            // УДАЛЕНИЕ ИДЁТ ПЕРВЫМ. Пара уникальна по (линия, скрипт): перенеся
            // пару со строки на строку, человек получил бы конфликт с самим
            // собой, если бы вставка шла раньше снятия.
            if (remove.length) {
                await client.query('DELETE FROM call_wrapup_rules WHERE id = ANY($1::int[])', [remove]);
            }
            for (const row of update) {
                await client.query(
                    'UPDATE call_wrapup_rules SET line_type = $1, script_id = $2, duration_seconds = $3 WHERE id = $4',
                    [row.line, row.scriptId, row.seconds, row.id]);
            }
            for (const row of insert) {
                await client.query(
                    'INSERT INTO call_wrapup_rules (line_type, script_id, duration_seconds) VALUES ($1, $2, $3)',
                    [row.line, row.scriptId, row.seconds]);
            }
        });
        res.json(await readEvents(pool));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить пост-обработку' });
    }
});

// PUT /api/call-events/transfer — два перечня в одном окне, сохраняются вместе.
router.put('/transfer', async (req, res) => {
    const body = req.body || {};
    const offerRows = Array.isArray(body.offers) ? body.offers : [];
    const employeeRows = Array.isArray(body.employees) ? body.employees : [];

    const offers = [];
    for (const row of offerRows) {
        const offerId = wholeNumber(row.offerId, 1, 2147483647);
        // НОМЕР ПАРТНЁРА ПРИВОДИТСЯ К ЕДИНОМУ ФОРМАТУ ПРОЕКТА, а не кладётся
        // строкой как её набрали (паспорт Р12). Хранится `+7XXXXXXXXXX` — тот
        // же вид, что у номера лида и у номера сотрудника: набирать по нему
        // будет телефония, а «8 (495) 120-45-67» и «+74951204567» для неё
        // разные строки.
        const parsed = normalizePhone(row.transferPhone);
        const phone = parsed.phone;
        const days = weekdays(row.weekdays);
        const wait = wholeNumber(row.waitSeconds, 1, 3600);
        if (offerId === null) return bad(res, 'В строке перевода не выбран оффер');
        if (parsed.reason === 'empty') {
            return bad(res, 'Укажите номер для перевода: без него перевод не сработает');
        }
        // ОТКАЗ ПО НОМЕРУ БЕРЁТСЯ ИЗ СПРАВОЧНИКА, А НЕ СОЧИНЯЕТСЯ (наряд,
        // раздел «Тексты»). Тот же текст стоит на экране разбора номеров: двух
        // формулировок одного отказа быть не должно.
        if (parsed.reason) return bad(res, await reasonTitle(parsed.reason));
        if (!days) return bad(res, 'Отметьте хотя бы один день — иначе перевод не работает никогда');
        if (!isTime(row.timeFrom) || !isTime(row.timeTo)) return bad(res, 'Укажите время «с» и «до»');
        if (String(row.timeFrom).trim() === String(row.timeTo).trim()) {
            return bad(res, 'Окно нулевой длины — это «никогда»: время «с» и «до» должны отличаться');
        }
        if (wait === null) return bad(res, 'Ожидание — целое число секунд больше нуля');
        offers.push({
            id: row.id ? Number(row.id) : null,
            offerId,
            phone,
            days,
            from: String(row.timeFrom).trim(),
            to: String(row.timeTo).trim(),
            wait,
            enabled: row.enabled !== false
        });
    }
    const offerSeen = new Set();
    for (const row of offers) {
        if (offerSeen.has(row.offerId)) return bad(res, 'Одна строка на оффер, второй быть не может');
        offerSeen.add(row.offerId);
    }

    // Место выбрано, а не подвернулось: здесь номер уже приведён, а `offerId`
    // разобран, и до записи ещё не дошло.
    let oneNetwork = null;
    try {
        oneNetwork = await oneNetworkPerPhone(pool, offers);
    } catch (err) {
        // Проверка не состоялась — это ПЯТИСОТАЯ, а не молчаливый пропуск:
        // сохранить перечень, не проверив правило, значит завести нарушение
        // руками системы.
        console.error(err);
        return res.status(500).json({ error: 'Не удалось проверить сети офферов' });
    }
    if (oneNetwork) return badRow(res, oneNetwork.error, oneNetwork.offerId);

    const staff = [];
    for (const row of employeeRows) {
        const employeeId = wholeNumber(row.employeeId, 1, 2147483647);
        const days = weekdays(row.weekdays);
        // Границы те же, что у оффера, и это не совпадение: поле одно и то же,
        // а два перечня одного окна не могут принимать разные числа (К259).
        const wait = wholeNumber(row.waitSeconds, 1, 3600);
        if (employeeId === null) return bad(res, 'В строке перевода не выбран сотрудник');
        if (!days) return bad(res, 'Отметьте хотя бы один день — иначе перевод не работает никогда');
        if (!isTime(row.timeFrom) || !isTime(row.timeTo)) return bad(res, 'Укажите время «с» и «до»');
        if (String(row.timeFrom).trim() === String(row.timeTo).trim()) {
            return bad(res, 'Окно нулевой длины — это «никогда»: время «с» и «до» должны отличаться');
        }
        if (wait === null) return bad(res, 'Ожидание — целое число секунд больше нуля');
        staff.push({
            id: row.id ? Number(row.id) : null,
            employeeId,
            days,
            from: String(row.timeFrom).trim(),
            to: String(row.timeTo).trim(),
            wait,
            enabled: row.enabled !== false
        });
    }
    const staffSeen = new Set();
    for (const row of staff) {
        if (staffSeen.has(row.employeeId)) return bad(res, 'Одна строка на сотрудника');
        staffSeen.add(row.employeeId);
    }

    try {
        await withTransaction(pool, async (client) => {
            const existingOffers = await idsOf(client, 'call_transfer_offers');
            const offerDiff = diffRows(existingOffers, offers);
            if (offerDiff.remove.length) {
                await client.query('DELETE FROM call_transfer_offers WHERE id = ANY($1::int[])',
                    [offerDiff.remove]);
            }
            for (const row of offerDiff.update) {
                await client.query(
                    `UPDATE call_transfer_offers
                        SET offer_id = $1, transfer_phone = $2, weekdays = $3::smallint[],
                            time_from = $4::time, time_to = $5::time, wait_seconds = $6, enabled = $7
                      WHERE id = $8`,
                    [row.offerId, row.phone, row.days, row.from, row.to, row.wait, row.enabled, row.id]);
            }
            for (const row of offerDiff.insert) {
                await client.query(
                    `INSERT INTO call_transfer_offers
                        (offer_id, transfer_phone, weekdays, time_from, time_to, wait_seconds, enabled)
                     VALUES ($1, $2, $3::smallint[], $4::time, $5::time, $6, $7)`,
                    [row.offerId, row.phone, row.days, row.from, row.to, row.wait, row.enabled]);
            }

            const existingStaff = await idsOf(client, 'call_transfer_employees');
            const staffDiff = diffRows(existingStaff, staff);
            if (staffDiff.remove.length) {
                await client.query('DELETE FROM call_transfer_employees WHERE id = ANY($1::int[])',
                    [staffDiff.remove]);
            }
            for (const row of staffDiff.update) {
                await client.query(
                    `UPDATE call_transfer_employees
                        SET employee_id = $1, weekdays = $2::smallint[], time_from = $3::time,
                            time_to = $4::time, wait_seconds = $5, enabled = $6
                      WHERE id = $7`,
                    [row.employeeId, row.days, row.from, row.to, row.wait, row.enabled, row.id]);
            }
            for (const row of staffDiff.insert) {
                await client.query(
                    `INSERT INTO call_transfer_employees
                        (employee_id, weekdays, time_from, time_to, wait_seconds, enabled)
                     VALUES ($1, $2::smallint[], $3::time, $4::time, $5, $6)`,
                    [row.employeeId, row.days, row.from, row.to, row.wait, row.enabled]);
            }
        });
        res.json(await readEvents(pool));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить перевод' });
    }
});

// ⚠ АДРЕСА `PUT /transfer-wait` ЗДЕСЬ БОЛЬШЕ НЕТ, и это не пропуск. Он правил
// одно число на все переводы внутрь; решение владельца 109 (К259) сделало
// ожидание полем строки, и сохраняется оно теперь тем же `PUT /transfer`, что и
// остальные поля строки. Отдельный адрес ради одного поля означал бы два места,
// где сохраняется одна строка, — и правку, потерянную между ними.

module.exports = router;
module.exports.readEvents = readEvents;
