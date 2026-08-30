// --- routes/leadsAdmin.js: админский слой для страницы «Лиды»
// (report_2026-08-01.md, 13.08.2026). Отдельный от routes/leads.js файл —
// тот целиком заточен под личный кабинет оператора (обязательный employeeId,
// доступ только к своим лидам), используется Backend/Operator/, ломать нельзя.
// Здесь — полный доступ ко всем лидам, без ограничения по employeeId.
//
// Задача «скрипты: привязка к лиду»: у лида появились линия, основной скрипт,
// скрипт для повторных и три связки многие-ко-многим (офферы, статусы показа
// скрипта, пул раздачи). Связки пересобираются целиком в транзакции при каждом
// POST/PUT — тот же приём, что у real_estate_offer_segments.

const express = require('express');
const { pool } = require('../db');
const auditContext = require('../services/auditContext');
const eventChannel = require('../services/eventChannel');
const { startOfDay, startOfNextDay, zonedParts } = require('../services/appTime');
const { distributePendingLeads, findNewFunnelStatusId, queueCondition, notSystemStatus } = require('../services/leadDistribution');
const { normalizePhone, normalizeForSearch } = require('../services/phoneFormat');
const { phoneColumnsFor, findLeadByPhone, leadTitle } = require('../services/phoneFix');
const guards = require('../services/deleteGuards');
const { mergeLeads } = require('../services/leadMerge');
const { currentCommit } = require('../services/phoneMigration');

// Дата и время по Москве одной строкой — для выгрузки. Московское время потому,
// что всё, что видит человек, показывается московским (решение владельца 47).
//
// С ГОДОМ, в отличие от страницы выдачи ключа (К177, приёмка части 4). Там срок
// живёт сутки и год лишний; здесь файл сам должен говорить, откуда он, а через
// год «5 марта» не значит ничего.
function formatMoscowStamp(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date).replace(', ', ' ');
}

const router = express.Router();

const { MAX_OFFERS_PER_LEAD, MAX_OFFER_LINKS_PER_BATCH, TOO_MANY_OFFERS_HINT } = require('../services/leadOfferLimits');

const LINE_TYPES = ['Входящая', 'Исходящая'];

// Порядок должен совпадать со списком колонок в INSERT/UPDATE ниже.
const FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['phone', 'phone'],
    ['sourceId', 'source_id'],
    ['lineType', 'line_type'],
    ['employeeId', 'employee_id'],
    ['funnelStatusId', 'funnel_status_id'],
    ['decisionMaker', 'decision_maker'],
    ['clientType', 'client_type'],
    ['otherBorrower', 'other_borrower'],
    ['category', 'category'],
    ['propertyType', 'property_type'],
    ['propertyClass', 'property_class'],
    ['roomCount', 'room_count'],
    ['finish', 'finish'],
    ['priceFrom', 'price_from'],
    ['priceTo', 'price_to'],
    ['areaFrom', 'area_from'],
    ['areaTo', 'area_to'],
    ['deliveryDeadline', 'delivery_deadline'],
    ['region', 'region'],
    ['city', 'city'],
    ['district', 'district'],
    ['locality', 'locality'],
    ['clientRegion', 'client_region'],
    ['clientCity', 'client_city'],
    ['clientDistrict', 'client_district'],
    ['clientLocality', 'client_locality'],
    ['purchaseMethod', 'purchase_method'],
    ['mortgageType', 'mortgage_type'],
    ['downPaymentPercent', 'down_payment_percent'],
    ['purchaseTimeframe', 'purchase_timeframe'],
    ['notes', 'notes']
];

const NUMERIC_FIELDS = new Set(['sourceId', 'employeeId', 'funnelStatusId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

// «Иной заёмщик» трёхзначный (NULL / true / false) — та же обработка, что в
// routes/leads.js: без неё строка 'false' из формы легла бы в базу как true.
const BOOLEAN_FIELDS = new Set(['otherBorrower']);

// Ключи, которые разрешено менять через bulk-update. Строгий whitelist, а не
// «всё, что пришло» (требование куратора, dialog.md B1): иначе лёгкий PATCH
// стал бы чёрным ходом мимо обязательной валидации PUT.
// СКРИПТА ЗДЕСЬ БОЛЬШЕ НЕТ, и это не забывчивость. С 25.08.2026 скрипт лида —
// не колонка, а пара «скрипт + его статусы» (решение владельца 82), и заменить
// её присвоением одного значения нельзя. Массовое назначение скриптов идёт
// отдельной веткой того же маршрута, через patch.scriptPairs, и проходит ту же
// проверку, что и карточка.
const BULK_PATCH_COLUMNS = {
    employeeId: 'employee_id',
    funnelStatusId: 'funnel_status_id'
};

function normalizeValue(key, value) {
    if (BOOLEAN_FIELDS.has(key)) {
        if (value === true || value === 'true') return true;
        if (value === false || value === 'false') return false;
        return null; // undefined, null, '' — «неприменимо»
    }
    if (NUMERIC_FIELDS.has(key)) {
        return value === '' || value === undefined || value === null ? null : Number(value);
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

// null — значение вообще не массив (клиент прислал мусор); [] — пустой список.
function normalizeIdArray(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return null;
    const seen = new Set();
    for (const raw of value) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) return null;
        seen.add(n);
    }
    return Array.from(seen);
}

// JOIN на sources/employees/lead_funnel_statuses/scripts для читаемых имён +
// три связки одним json_agg на каждую (без N+1 с фронта, dialog.md H2).
const BASE_SELECT = `
    SELECT l.*,
           -- Колонка «Источник» в таблице: источник лидов, а не корневой
           -- (25.08.2026). После разделения номера и слова в root_source у
           -- всех записей стоит «ДОМ.РФ», и колонка показывала бы одно и то
           -- же во всех строках.
           COALESCE(NULLIF(s.lead_source, ''), s.root_source) AS source_name,
           CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name ELSE NULL END AS employee_name,
           fs.status_name, fs.stage_name, fs.stage_number,
           -- ПРИЗНАК КРАСНОГО ЕДЕТ ВМЕСТЕ С ИМЕНЕМ (К245, исправлено К260).
           -- Решение владельца 106 требует красного в списке лидов, а отличить
           -- такой статус экрану было нечем: наружу уходило одно имя.
           -- Признак, а не сравнение имени: имена статусов стали правимыми
           -- заходом 4, и поиск по названию сломался бы первым же
           -- переименованием.
           --
           -- ⚠ ПРИЗНАК ИМЕННО awaits_manager, А НЕ is_system — это К260,
           -- дефект первой редакции К245. Системных статусов ДВА, красный по
           -- решению 106 — один: тот, по которому лид дальше не двинется, пока
           -- не вмешается руководитель. По is_system красным становился и
           -- «Не ответил после N перезвонов», которого владелец красным не
           -- называл. В services/leadDistribution.js:77 выбор обратный и это
           -- намеренно: раздача пропускает ОБА системных, а красит экран один.
           --
           -- ⚠ ОБРАТНЫХ КАВЫЧЕК ЗДЕСЬ БЫТЬ НЕ МОЖЕТ: весь запрос — шаблонная
           -- строка JS, и кавычка в SQL-комментарии закрывает её. Проверено
           -- падением сервера при первой редакции этой правки.
           fs.awaits_manager AS status_awaits_manager,
           -- Скрипт, который увидит оператор ПРЯМО СЕЙЧАС: тот, чья пара
           -- содержит текущий статус лида. Не leads.script_id — в неё сервер
           -- больше не пишет, она ждёт снятия вместе с экраном (см. schema.sql).
           (SELECT sp.title FROM lead_script_statuses lss2
              JOIN scripts sp ON sp.id = lss2.script_id
             WHERE lss2.lead_id = l.id AND lss2.funnel_status_id = l.funnel_status_id) AS script_title,
           COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name) ORDER BY o.name)
                     FROM lead_offers lo JOIN real_estate_offers o ON o.id = lo.offer_id
                     WHERE lo.lead_id = l.id), '[]'::json) AS offers,
           -- ПАРЫ ОДНИМ ЗАПРОСОМ, СОБРАННЫЕ ИЗ СТРОК. В базе пара разложена по
           -- строкам (одна на статус) — так первичный ключ дарит запрет одного
           -- статуса в двух парах. Экрану же нужна именно пара, поэтому группируем
           -- обратно здесь, а не на фронте: иначе каждый читатель собирал бы её
           -- по-своему.
           COALESCE((SELECT json_agg(pair ORDER BY pair->>'scriptTitle')
                     FROM (SELECT json_build_object(
                                      'scriptId', lss.script_id,
                                      'scriptTitle', max(sp.title),
                                      'statusIds', json_agg(lss.funnel_status_id ORDER BY lss.funnel_status_id)
                                  ) AS pair
                             FROM lead_script_statuses lss
                             JOIN scripts sp ON sp.id = lss.script_id
                            WHERE lss.lead_id = l.id
                            GROUP BY lss.script_id) pairs), '[]'::json) AS script_pairs,
           COALESCE((SELECT json_agg(ldp.employee_id ORDER BY ldp.employee_id)
                     FROM lead_distribution_pool ldp WHERE ldp.lead_id = l.id), '[]'::json) AS pool_employee_ids,
           -- СКОЛЬКО ДУБЛЕЙ В НЕГО ВЛИТО (часть 5Б). Окно «Отправить в архив»
           -- открывается в одном из двух состояний — «удалить можно» и «удалить
           -- нельзя», — и выбрать состояние надо ДО открытия. Спросить об этом
           -- отдельным запросом неоткуда: маршрута предпросмотра у лида нет, а
           -- заводить его ради одного числа дороже, чем посчитать здесь.
           --
           -- Считается по idx_leads_merged_into — частичному индексу части 4,
           -- где лежат только слитые строки; на списке в полсотни лидов это
           -- полсотни обращений к маленькому индексу, а не проход по таблице.
           (SELECT count(*)::int FROM leads m WHERE m.merged_into_id = l.id) AS merged_count
    FROM leads l
    LEFT JOIN sources s ON s.id = l.source_id
    LEFT JOIN employees e ON e.id = l.employee_id
    LEFT JOIN lead_funnel_statuses fs ON fs.id = l.funnel_status_id
`;

function rowToLead(row) {
    const offers = row.offers || [];
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        phone: row.phone,
        // Разбор номера (часть 4). Нужен списку и карточке: у лида,
        // чей номер не приведён, рядом с номером стоит знак — между
        // оператором и набором номера, которого нет, не стоит больше
        // ничего (решение владельца 65).
        phoneNormalized: row.phone_normalized,
        phoneFixVerdict: row.phone_fix_verdict,
        sourceId: row.source_id,
        sourceName: row.source_name,
        lineType: row.line_type,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        funnelStatusId: row.funnel_status_id,
        statusName: row.status_name,
        statusAwaitsManager: row.status_awaits_manager,
        // Пометка «заполнена частично» (часть 9, заход 5). Ставит её система,
        // когда пост-обработка закрыла карточку по времени: работа сделана,
        // просто не вся. Своей колонки в списке у неё нет — подстрокой под
        // статусом: колонка пустовала бы почти во всех строках.
        partiallyFilled: row.partially_filled,
        stageName: row.stage_name,
        stageNumber: row.stage_number,
        // scriptId/repeatScriptId наружу больше не отдаются: пары называют
        // скрипт сами. scriptTitle остался — это ДЕЙСТВУЮЩИЙ скрипт, тот, что
        // оператор увидит при нынешнем статусе, и колонка списка показывает его.
        scriptTitle: row.script_title,
        offers,
        offerIds: offers.map((o) => o.id),
        scriptPairs: row.script_pairs || [],
        poolEmployeeIds: row.pool_employee_ids || [],
        decisionMaker: row.decision_maker,
        clientType: row.client_type,
        otherBorrower: row.other_borrower,
        category: row.category,
        propertyType: row.property_type,
        propertyClass: row.property_class,
        roomCount: row.room_count,
        finish: row.finish,
        priceFrom: row.price_from,
        priceTo: row.price_to,
        areaFrom: row.area_from,
        areaTo: row.area_to,
        deliveryDeadline: row.delivery_deadline,
        region: row.region,
        city: row.city,
        district: row.district,
        locality: row.locality,
        clientRegion: row.client_region,
        clientCity: row.client_city,
        clientDistrict: row.client_district,
        clientLocality: row.client_locality,
        purchaseMethod: row.purchase_method,
        mortgageType: row.mortgage_type,
        downPaymentPercent: row.down_payment_percent,
        purchaseTimeframe: row.purchase_timeframe,
        notes: row.notes,
        // Архив (часть 5). Наружу едут все четыре колонки: пилюля рисуется по
        // archivedAt, а строка под ней — «кто и когда отправил» (паспорт Р7).
        // Имя автора снимком, а не ссылкой на сотрудника: подпись обязана
        // пережить удаление того, кто её поставил.
        archivedAt: row.archived_at,
        archivedActorId: row.archived_actor_id,
        archivedActorKind: row.archived_actor_kind,
        archivedActorName: row.archived_actor_name,
        // Единственная сегодняшняя помеха физическому удалению лида: подобранные
        // объекты ушли из помех (Р7-4), комментарии помехой не считаются (И73),
        // звонки появятся частью 7.
        mergedCount: row.merged_count || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

// Куда попадёт лид, если снять с него архив. Три ответа, а не два (ответ
// куратора И88 и правка Р7-5): «сразу», «позже» и «работы больше нет».
//
// «ПОЗЖЕ» СПРАШИВАЕТ ПРО СИСТЕМНЫЙ СТАТУС ТЕМ ЖЕ ТЕКСТОМ, ЧТО И ОЧЕРЕДЬ (К241).
// Лид, выпавший из раздачи по системному статусу, ждёт руководителя, а не
// времени: пообещать ему «вернётся позже» значило бы назвать сроком то, что
// сроком не является. Такой лид уходит в «работы больше нет» — и это правда:
// работы у ОПЕРАТОРА по нему действительно нет.
//
// Считается ПО ФАКТИЧЕСКОМУ УСЛОВИЮ ОЧЕРЕДИ, взятому из services/
// leadDistribution.js, а не по флагу lead_funnel_statuses.releases_lead.
// Флаг описывает, что делать ПОСЛЕ звонка, а не попадёт ли лид в раздачу: у
// лида со статусом «Перезвон» и временем на завтра флаг стоит, а в сегодняшнюю
// очередь он не попадёт. Обещать ему «вернётся в очередь» значит соврать.
async function queuePlacement(db, leadId) {
    const newStatusId = await findNewFunnelStatusId(db);
    if (newStatusId === null) return 'none';
    const result = await db.query(
        `SELECT ${queueCondition('l', '$2')} AS in_queue,
                (l.next_call_at IS NOT NULL AND l.next_call_at > NOW()
                 AND ${notSystemStatus('l')}) AS later
           FROM leads l WHERE l.id = $1`,
        [leadId, newStatusId]);
    const row = result.rows[0];
    if (!row) return 'none';
    if (row.in_queue) return 'now';
    return row.later ? 'later' : 'none';
}

const FK_MESSAGES = {
    leads_source_id_fkey: 'Указанный источник не найден',
    leads_employee_id_fkey: 'Указанный сотрудник не найден',
    leads_funnel_status_id_fkey: 'Указанный статус воронки не найден',
    lead_offers_offer_id_fkey: 'Один из выбранных офферов не найден',
    lead_script_statuses_funnel_status_id_fkey: 'Один из выбранных статусов показа не найден',
    lead_script_statuses_script_id_fkey: 'Один из выбранных скриптов не найден',
    lead_distribution_pool_employee_id_fkey: 'Один из выбранных сотрудников не найден'
};

// Дубль номера, проскочивший мимо предварительной проверки (К176, приёмка
// части 4). Окно между findLeadByPhone и записью открыто: проверка идёт до
// BEGIN, и двое, сохраняющие один номер одновременно, доходят до индекса. Без
// этой обработки второй получал бы 500 «Не удалось сохранить лида» — то есть
// ровно ту голую ошибку базы, от которой часть 4 и уводит.
function handleDuplicatePhone(err, res, rawPhone) {
    if (err.code !== '23505' || err.constraint !== 'idx_leads_phone_unique') return false;
    const { phone } = normalizePhone(rawPhone);
    res.status(409).json({
        error: `Номер ${phone} уже у другого лида. Сохранить нельзя — лидов можно объединить`
    });
    return true;
}

function handleFkError(err, res) {
    if (err.code !== '23503') return false;
    const message = FK_MESSAGES[err.constraint];
    if (!message) return false;
    res.status(400).json({ error: message });
    return true;
}

// ================= Валидация =================

async function checkActiveScript(db, scriptId, label) {
    const result = await db.query('SELECT status FROM scripts WHERE id = $1', [scriptId]);
    if (result.rows.length === 0) return `${label}: скрипт не найден`;
    if (result.rows[0].status !== 'active') return `${label}: назначить можно только активный скрипт`;
    return null;
}

// ПАРЫ «СКРИПТ + ЕГО СТАТУСЫ» (решения владельца 82–84 от 25.08.2026).
//
// Что здесь проверяется и почему именно здесь:
//   · до пяти пар — потолок владельца, и он не в базе: в базе пара не сущность,
//     а группа строк, и считать группы ограничением накладно;
//   · половин не бывает — ни скрипта без статусов, ни статусов без скрипта;
//   · ОДИН СТАТУС ТОЛЬКО В ОДНОЙ ПАРЕ. Первичный ключ таблицы это тоже отбивает,
//     но отбивает КОДОМ БАЗЫ, а человеку нужно имя статуса. Поэтому проверяем
//     заранее и называем виновника, а ключ остаётся страховкой на случай обхода;
//   · один и тот же скрипт в двух парах РАЗРЕШЁН (решение 84) — предупреждение о
//     нём живёт на экране, сервер молчит.
//
// Прежняя проверка hasRepeatStages снята вместе с полем «повторный скрипт»:
// повторный скрипт теперь просто пара с повторными статусами.
const MAX_SCRIPT_PAIRS = 5;

async function validateScriptPairs(db, raw) {
    if (!Array.isArray(raw)) return { error: 'Некорректный список скриптов лида' };
    if (raw.length === 0) return { error: 'Выберите хотя бы один скрипт и статусы к нему' };
    if (raw.length > MAX_SCRIPT_PAIRS) {
        return { error: `Слишком много скриптов у одного лида: ${raw.length}, максимум ${MAX_SCRIPT_PAIRS}` };
    }

    const pairs = [];
    const statusOwner = new Map();

    for (let i = 0; i < raw.length; i++) {
        const pair = raw[i] || {};
        const place = `Скрипт ${i + 1}`;

        const scriptId = pair.scriptId ? Number(pair.scriptId) : null;
        if (!Number.isInteger(scriptId) || scriptId <= 0) {
            return { error: `${place}: не выбран скрипт` };
        }
        const scriptError = await checkActiveScript(db, scriptId, place);
        if (scriptError) return { error: scriptError };

        const statusIds = normalizeIdArray(pair.statusIds);
        if (statusIds === null) return { error: `${place}: некорректный список статусов` };
        if (statusIds.length === 0) return { error: `${place}: выберите хотя бы один статус показа` };

        for (const statusId of statusIds) {
            if (statusOwner.has(statusId)) {
                const name = await statusName(db, statusId);
                return { error: `Статус «${name}» выбран дважды: у скрипта ${statusOwner.get(statusId)} и у скрипта ${i + 1}. Один статус может открывать только один скрипт` };
            }
            statusOwner.set(statusId, i + 1);
        }

        pairs.push({ scriptId, statusIds });
    }

    return { data: pairs };
}

// Имя статуса нужно ровно в одном месте — в отказе выше. Отдельный запрос вместо
// того, чтобы тянуть весь справочник: отказ случается редко, а справочник в
// полсотни строк ради него грузить незачем.
async function statusName(db, statusId) {
    const result = await db.query('SELECT status_name FROM lead_funnel_statuses WHERE id = $1', [statusId]);
    return result.rows.length > 0 ? result.rows[0].status_name : `№${statusId}`;
}

// Общий набор параметров подбора — одинаков для карточки лида (POST/PUT) и
// для всей партии в bulk-import. Возвращает { error } либо { data }.
async function validateLeadParams(db, body) {
    if (!LINE_TYPES.includes(body.lineType)) {
        return { error: `Укажите линию: ${LINE_TYPES.join(' или ')}` };
    }
    if (!body.sourceId) {
        return { error: 'Заполните обязательное поле: Источник' };
    }

    const offerIds = normalizeIdArray(body.offerIds);
    if (offerIds === null) return { error: 'Некорректный список офферов' };
    if (offerIds.length === 0) return { error: 'Выберите хотя бы один оффер' };
    if (offerIds.length > MAX_OFFERS_PER_LEAD) {
        return { error: `Слишком много офферов на одного лида: ${offerIds.length}, максимум ${MAX_OFFERS_PER_LEAD}. ${TOO_MANY_OFFERS_HINT}` };
    }

    const pairsCheck = await validateScriptPairs(db, body.scriptPairs);
    if (pairsCheck.error) return { error: pairsCheck.error };
    const scriptPairs = pairsCheck.data;

    const poolEmployeeIds = normalizeIdArray(body.poolEmployeeIds);
    if (poolEmployeeIds === null) return { error: 'Некорректный список сотрудников для пула раздачи' };

    return { data: { offerIds, scriptPairs, poolEmployeeIds } };
}

async function validateFullLeadBody(db, body) {
    if (!body.phone || String(body.phone).trim() === '') {
        return { error: 'Заполните обязательное поле: Номер телефона' };
    }
    return validateLeadParams(db, body);
}

// Назначить лиду можно только оператора ЕГО линии — то же правило, по которому
// работает автораздача (services/leadDistribution.js). Проверка нужна и в обход
// интерфейса: эндпоинт доступен напрямую.
//
// Ключевая тонкость: проверяем ТОЛЬКО когда назначение МЕНЯЕТСЯ. У легаси-лида
// уже может стоять оператор другой линии (на бою такие есть), а карточка шлёт
// PUT полным телом — без этого условия правка телефона у такого лида падала бы
// с 400 на операторе, которого пользователь не трогал (dialog.md B1).
// currentEmployeeId === undefined означает «сравнивать не с чем» (создание).
async function checkEmployeeLine(db, { employeeId, lineType, currentEmployeeId }) {
    if (employeeId === null || employeeId === undefined || employeeId === '') return null;
    const nextId = Number(employeeId);
    if (currentEmployeeId !== undefined && currentEmployeeId !== null && Number(currentEmployeeId) === nextId) {
        return null; // назначение не меняется — не наше дело
    }
    if (!lineType) {
        return 'Сначала укажите линию лида — без неё нельзя назначить оператора';
    }
    const result = await db.query('SELECT last_name, first_name, line_type FROM employees WHERE id = $1', [nextId]);
    if (result.rows.length === 0) return 'Указанный сотрудник не найден';
    const employee = result.rows[0];
    if (employee.line_type !== lineType) {
        const employeeLine = employee.line_type ? `«${employee.line_type}»` : 'не указана';
        return `Сотрудник ${employee.last_name} ${employee.first_name}: линия ${employeeLine}, а у лида «${lineType}». Назначить можно только оператора той же линии`;
    }
    return null;
}

// ================= Связки =================

// Пересборка целиком: delete + один INSERT ... SELECT unnest на связку.
// unnest вместо цикла — при 1000 офферов цикл дал бы 1000 round-trip'ов.
async function replaceLeadLinks(client, leadId, { offerIds, scriptPairs, poolEmployeeIds }) {
    await client.query('DELETE FROM lead_offers WHERE lead_id = $1', [leadId]);
    if (offerIds.length > 0) {
        await client.query('INSERT INTO lead_offers (lead_id, offer_id) SELECT $1, unnest($2::int[])', [leadId, offerIds]);
    }
    await client.query('DELETE FROM lead_script_statuses WHERE lead_id = $1', [leadId]);
    // Пары раскладываются в строки: одна на статус. Два массива вместо цикла по
    // парам — тот же довод, что у офферов: пять пар по десять статусов дали бы
    // пятьдесят обращений вместо одного.
    const flatScriptIds = [];
    const flatStatusIds = [];
    for (const pair of scriptPairs) {
        for (const statusId of pair.statusIds) {
            flatScriptIds.push(pair.scriptId);
            flatStatusIds.push(statusId);
        }
    }
    if (flatStatusIds.length > 0) {
        await client.query(
            `INSERT INTO lead_script_statuses (lead_id, script_id, funnel_status_id)
             SELECT $1, sid, stid FROM unnest($2::int[], $3::int[]) AS t(sid, stid)`,
            [leadId, flatScriptIds, flatStatusIds]
        );
    }
    await client.query('DELETE FROM lead_distribution_pool WHERE lead_id = $1', [leadId]);
    if (poolEmployeeIds.length > 0) {
        await client.query('INSERT INTO lead_distribution_pool (lead_id, employee_id) SELECT $1, unnest($2::int[])', [leadId, poolEmployeeIds]);
    }
}

// Тот же набор связок сразу на всю партию — одним запросом на связку,
// а не на каждого лида: CROSS JOIN двух unnest'ов даёт декартово
// произведение "все лиды партии × все значения набора".
async function insertBatchLinks(client, leadIds, { offerIds, scriptPairs, poolEmployeeIds }) {
    if (leadIds.length === 0) return;
    if (offerIds.length > 0) {
        await client.query(
            `INSERT INTO lead_offers (lead_id, offer_id)
             SELECT l, o FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) o
             ON CONFLICT DO NOTHING`,
            [leadIds, offerIds]
        );
    }
    // Пары партии: те же у всех лидов загрузки (решение владельца 85). Пара
    // разложена в две плоские колонки, и CROSS JOIN размножает их по лидам —
    // так тысяча лидов с пятью парами обходится одним обращением, а не пятью
    // тысячами.
    const flatScriptIds = [];
    const flatStatusIds = [];
    for (const pair of scriptPairs) {
        for (const statusId of pair.statusIds) {
            flatScriptIds.push(pair.scriptId);
            flatStatusIds.push(statusId);
        }
    }
    if (flatStatusIds.length > 0) {
        await client.query(
            `INSERT INTO lead_script_statuses (lead_id, script_id, funnel_status_id)
             SELECT l, t.sid, t.stid
               FROM unnest($1::int[]) l
               CROSS JOIN unnest($2::int[], $3::int[]) AS t(sid, stid)
             ON CONFLICT DO NOTHING`,
            [leadIds, flatScriptIds, flatStatusIds]
        );
    }
    if (poolEmployeeIds.length > 0) {
        await client.query(
            `INSERT INTO lead_distribution_pool (lead_id, employee_id)
             SELECT l, e FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) e
             ON CONFLICT DO NOTHING`,
            [leadIds, poolEmployeeIds]
        );
    }
}

async function fetchLeadById(id) {
    const result = await pool.query(`${BASE_SELECT} WHERE l.id = $1`, [id]);
    return result.rows[0] ? rowToLead(result.rows[0]) : null;
}

// ================= Роуты =================

// GET /api/leads-admin — список лидов под фильтры и кнопку «Показать ещё».
//
// ОТВЕТ — ОБЪЕКТ { items, total }, а не массив (часть 2, подвал «Показано N из
// M»). Раньше отдавался голый массив, и «M» фронту взять было неоткуда: он знал
// только длину полученной порции. Считаем total ТЕМ ЖЕ условием, что и выборку,
// — иначе подвал обещал бы одно, а фильтр показывал другое.
//
// Параметр q — общий поиск по ФИО И телефону сразу, под одно поле тулбара
// «Поиск по имени или телефону». Раздельные fio и phone остались: ими
// пользуется окно «Фильтры», где это два разных поля.
router.get('/', async (req, res) => {
    try {
        const { q, fio, phone, sourceId, employeeId, funnelStatusId, limit, offset } = req.query;

        const conditions = [];
        const params = [];

        // --- отбор по критериям подбора (К122) ---
        //
        // До этой правки сервер знал пять условий: поиск, ФИО, номер, источник,
        // сотрудник и статус. Раздача идёт ПО ЛИНИИ, и массовое действие само
        // отказывает, если в выделении лиды разных линий, — а фильтра по линии
        // не было вовсе: однородное выделение приходилось собирать глазами по
        // колонке. Остальные признаки — то, ради чего лид и заводится.
        //
        // ВСЕ УСЛОВИЯ ССЫЛАЮТСЯ ТОЛЬКО НА АЛИАС `l.` — это не случайность, а
        // граница: подсчёт total идёт по одной таблице, без шести джойнов
        // основного запроса (см. комментарий у него ниже). Условие по полю из
        // джойна обязано приехать и туда, иначе упадёт ТОЛЬКО подсчёт, и раздел
        // ответит 500 там, где выборка отработала бы (К-Ф5 куратора).
        const eq = (value, column) => {
            const text = value === undefined || value === null ? '' : String(value).trim();
            if (!text) return;
            params.push(text);
            conditions.push(`${column} = $${params.length}`);
        };
        // Совпадение без оглядки на регистр букв. Нужно там, где значение
        // набирают руками: «московская область» и «Московская область» — одно и
        // то же место, и отбор, который этого не знает, отвечает пустотой на
        // верный запрос. ILIKE тут не годится: «_» и «%» в названии он примет
        // за подстановочные знаки.
        const eqCi = (value, column) => {
            const text = value === undefined || value === null ? '' : String(value).trim();
            if (!text) return;
            params.push(text);
            conditions.push(`lower(${column}) = lower($${params.length})`);
        };
        // Числовое равенство. Нечисловое значение отбрасывается целиком, а не
        // уезжает в запрос: сравнение numeric с мусором — это 500 на ровном
        // месте, притом на эндпоинте, доступном напрямую.
        const eqNumber = (value, column) => {
            const text = value === undefined || value === null ? '' : String(value).trim();
            if (!text) return;
            const number = Number(text);
            if (!Number.isFinite(number)) return;
            params.push(number);
            conditions.push(`${column} = $${params.length}`);
        };
        const like = (value, column) => {
            const text = value === undefined || value === null ? '' : String(value).trim();
            if (!text) return;
            params.push(`%${text}%`);
            conditions.push(`${column} ILIKE $${params.length}`);
        };
        // Диапазон — ПЕРЕСЕЧЕНИЕ, а не вложение: «до 12 млн» обязано находить и
        // лида, готового на 10–14, — он подходит. Пустая граница У ЛИДА
        // означает «не ограничен с этой стороны», а не «не подходит»: молча
        // выкидывать лида, у которого заполнена одна граница из двух, нельзя.
        const overlap = (from, to, columnFrom, columnTo) => {
            const min = from === undefined || from === null || String(from).trim() === '' ? null : Number(from);
            const max = to === undefined || to === null || String(to).trim() === '' ? null : Number(to);
            if (min !== null && Number.isFinite(min)) {
                params.push(min);
                conditions.push(`(${columnTo} IS NULL OR ${columnTo} >= $${params.length})`);
            }
            if (max !== null && Number.isFinite(max)) {
                params.push(max);
                conditions.push(`(${columnFrom} IS NULL OR ${columnFrom} <= $${params.length})`);
            }
        };

        // СЛИТЫЕ ЛИДЫ В СПИСКАХ НЕ ПОЯВЛЯЮТСЯ (часть 4, решение куратора И58).
        // Лид, влитый в другого, существует и находится по идентификатору, но в
        // работе его нет: показывать его рядом со старшим значило бы вернуть тот
        // самый дубль, ради устранения которого слияние и делалось.
        conditions.push('l.merged_into_id IS NULL');

        // АРХИВНЫЕ ЛИДЫ ПО УМОЛЧАНИЮ НЕ ПОКАЗЫВАЮТСЯ, но отбор остаётся за
        // экраном (бриф части 5, пункт 3): значение «archived» приходит
        // параметром, и раздел волен показать архив, только архив или всё
        // вместе. Умолчание именно «скрыть», потому что экрана с переключателем
        // ещё нет: покажи мы архивных сегодня, они молча подмешались бы в общий
        // список, и отличить их было бы нечем.
        const archivedMode = String(req.query.archived || '').trim();
        if (archivedMode === 'only') conditions.push('l.archived_at IS NOT NULL');
        else if (archivedMode !== 'all') conditions.push('l.archived_at IS NULL');

        // ПОИСК ПО ЦИФРАМ, А НЕ ПО СТРОКЕ. Человек набирает «916 123», в базе
        // лежит «+79161234567», а у неразобранного лида — сырая строка
        // «8 (916) 123-45-67». Сравнивая строки, мы не находили ни одного из
        // них. Сравниваем цифры с обеих сторон и смотрим ещё и в исходную
        // строку: лид, чей номер не привёлся, обязан находиться по номеру.
        // Параметр добавляется только когда цифры в запросе есть — иначе в
        // запрос уехал бы лишний, а Postgres на это отвечает ошибкой.
        const byDigits = (rawValue) => {
            const digits = normalizeForSearch(rawValue).digits;
            if (!digits) return null;
            params.push(`%${digits}%`);
            const i = params.length;
            return `regexp_replace(l.phone, '\\D', '', 'g') LIKE $${i}
                    OR regexp_replace(COALESCE(l.phone_raw, ''), '\\D', '', 'g') LIKE $${i}`;
        };

        if (q && q.trim()) {
            params.push(`%${q.trim()}%`);
            const idx = params.length;
            const digitsCondition = byDigits(q);
            conditions.push(`(l.last_name ILIKE $${idx} OR l.first_name ILIKE $${idx}
                              OR l.middle_name ILIKE $${idx} OR l.phone ILIKE $${idx}
                              ${digitsCondition ? 'OR ' + digitsCondition : ''})`);
        }
        if (fio && fio.trim()) {
            params.push(`%${fio.trim()}%`);
            const idx = params.length;
            conditions.push(`(l.last_name ILIKE $${idx} OR l.first_name ILIKE $${idx} OR l.middle_name ILIKE $${idx})`);
        }
        if (phone && phone.trim()) {
            params.push(`%${phone.trim()}%`);
            const idx = params.length;
            const digitsCondition = byDigits(phone);
            conditions.push(`(l.phone ILIKE $${idx} ${digitsCondition ? 'OR ' + digitsCondition : ''})`);
        }
        if (sourceId) {
            params.push(sourceId);
            conditions.push(`l.source_id = $${params.length}`);
        }
        if (employeeId === 'none') {
            conditions.push('l.employee_id IS NULL');
        } else if (employeeId) {
            params.push(employeeId);
            conditions.push(`l.employee_id = $${params.length}`);
        }
        if (funnelStatusId) {
            params.push(funnelStatusId);
            conditions.push(`l.funnel_status_id = $${params.length}`);
        }

        // Пятнадцать полей окна «Фильтры» сверх пяти прежних.
        eq(req.query.lineType, 'l.line_type');
        eq(req.query.propertyType, 'l.property_type');
        eq(req.query.propertyClass, 'l.property_class');
        eq(req.query.roomCount, 'l.room_count');
        eq(req.query.finish, 'l.finish');
        eq(req.query.deliveryDeadline, 'l.delivery_deadline');
        overlap(req.query.priceFrom, req.query.priceTo, 'l.price_from', 'l.price_to');
        overlap(req.query.areaFrom, req.query.areaTo, 'l.area_from', 'l.area_to');
        // Гео объекта, а не клиента: отбирают под оффер, а оффер привязан к
        // месту объекта. Регион — совпадение (значение приходит из подсказок
        // адреса и пишется одинаково), населённый пункт — по вхождению.
        eqCi(req.query.region, 'l.region');
        like(req.query.locality, 'l.locality');
        eq(req.query.clientType, 'l.client_type');
        eq(req.query.mortgageType, 'l.mortgage_type');
        eqNumber(req.query.downPaymentPercent, 'l.down_payment_percent');

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const filterParams = params.slice();

        params.push(Number(limit) > 0 ? Number(limit) : 50);
        const limitIdx = params.length;
        params.push(Number(offset) > 0 ? Number(offset) : 0);
        const offsetIdx = params.length;

        const [rows, totals] = await Promise.all([
            pool.query(
                `${BASE_SELECT} ${whereClause} ORDER BY l.created_at DESC, l.id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
                params
            ),
            // ГРАНИЦА: подсчёт идёт по одной таблице, без шести джойнов основного
        // запроса, — сегодня это верно, потому что все условия фильтра ссылаются
        // только на алиас `l.`. Появится фильтр по полю из джойна (например по
        // названию источника) — джойн обязан приехать и сюда, иначе упадёт
        // ТОЛЬКО подсчёт, и раздел ответит 500 там, где выборка отработала бы
        // (К-Ф5 куратора).
        pool.query(`SELECT count(*)::int AS total FROM leads l ${whereClause}`, filterParams)
        ]);
        res.json({ items: rows.rows.map(rowToLead), total: totals.rows[0].total });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список лидов' });
    }
});

// GET /api/leads-admin/stats — три цифры шапки раздела (всего / без оператора /
// за сегодня), считаются по ВСЕМ лидам, не по текущим фильтрам.
//
// СУТКИ СЧИТАЮТСЯ В ПОЯСЕ ПРИЛОЖЕНИЯ, а не в поясе сессии БД. Раньше здесь
// стояло `created_at::date = CURRENT_DATE`: на Railway контейнер идёт в UTC, и
// с полуночи до трёх ночи по Москве цифра показывала вчерашний день. Это было
// единственное место в routes/* с CURRENT_DATE.
//
// Ответ несёт ещё и само серверное «сегодня» (todayDate, YYYY-MM-DD в поясе
// приложения): подпись раздела «очередь на 19 августа» обязана совпадать с тем
// днём, по которому посчитан счётчик, а часы браузера у оператора могут стоять
// в другом поясе.
router.get('/stats', async (req, res) => {
    try {
        const now = new Date();
        const dayStart = startOfDay(now);
        const dayEnd = startOfNextDay(now);
        const p = zonedParts(now);
        const todayDate = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

        // ТРИ СЧЁТЧИКА СЧИТАЛИ ТО, ЧЕГО В СПИСКЕ НЕТ ВОВСЕ (К183). Запрос шёл
        // `FROM leads` без единого условия, а список отбрасывает двоих:
        // слитых безусловно (`l.merged_into_id IS NULL`, часть 4) и архивных по
        // умолчанию (`l.archived_at IS NULL`, часть 5).
        //
        // Часть 4 в бою с 25.08, и первое же слияние завысило бы «Всего»: дубль
        // ушёл из списка и остался в счётчике. С приходом экрана архива стало
        // бы хуже — завысились бы И «Всего», И «Без оператора»: у архивного
        // лида оператора нет по определению, он попал бы в «Без оператора», а
        // раздача его не берёт (queueCondition отбрасывает архив). Шапка звала
        // бы разбирать очередь, которой нет.
        //
        // Паспорт Р7 говорит это прямо: «Архивный лид не попадает в счётчики
        // шапки», «счётчики шапки, раздача и подбор считают по этому же
        // набору».
        //
        // ЧЕТВЁРТОЕ ЧИСЛО — «В АРХИВЕ» — считается ровно тем набором, что и
        // список при archived=only: архивные, но не слитые. Иначе число в чипе
        // разошлось бы с тем, что человек увидит, щёлкнув по отбору.
        //
        // Место ему здесь, а не в ответе списка: список считает total тем же
        // условием, что и выборку, и число архивных меняло бы значение от
        // каждой набранной в поиске буквы. Отбор так вести себя не должен.
        const result = await pool.query(`
            SELECT
                count(*) FILTER (WHERE merged_into_id IS NULL AND archived_at IS NULL)::int AS total,
                count(*) FILTER (WHERE merged_into_id IS NULL AND archived_at IS NULL
                                   AND employee_id IS NULL)::int AS queue,
                count(*) FILTER (WHERE merged_into_id IS NULL AND archived_at IS NULL
                                   AND created_at >= $1 AND created_at < $2)::int AS today,
                count(*) FILTER (WHERE merged_into_id IS NULL AND archived_at IS NOT NULL)::int AS archived
            FROM leads
        `, [dayStart, dayEnd]);
        const row = result.rows[0];
        res.json({
            total: row.total, queue: row.queue, today: row.today,
            archived: row.archived, todayDate
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить статистику' });
    }
});

// GET /api/leads-admin/check-phone?phone= — фронт вызывает по blur поля
// телефона и показывает предупреждение.
//
// СРАВНИВАЕТСЯ ПРИВЕДЁННЫЙ НОМЕР, а не то, что человек набрал (Б1.6). Иначе
// «8 916 1234567» в форме и «+79161234567» в базе оставались бы для проверки
// разными людьми — ровно та беда, ради которой затевалась часть.
router.get('/check-phone', async (req, res) => {
    try {
        const raw = (req.query.phone || '').trim();
        if (!raw) {
            return res.json({ duplicateId: null });
        }
        const { phone } = normalizePhone(raw);
        const twin = await findLeadByPhone(pool, phone);
        res.json({ duplicateId: twin ? twin.id : null, phone, name: twin ? leadTitle(twin) : null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось проверить номер' });
    }
});

// GET /api/leads-admin/phone-fix/export.csv — список номеров, которые не
// привелись, файлом (Б1.3).
//
// ПОКА ЭКРАНА РАЗБОРА НЕТ, ЭТО ЕДИНСТВЕННЫЙ СПОСОБ УВИДЕТЬ СПИСОК. План 5.3
// требует: что не разобрали — показываем, решает человек. Экран Р10 нарисован,
// но собирается в разделе «Лиды», приведённом к макету; до тех пор работает
// выгрузка — так прямо разрешено брифом.
//
// Объявлен ДО '/:id', иначе Express прочитает «phone-fix» как идентификатор.
router.get('/phone-fix/export.csv', async (req, res) => {
    try {
        const rows = await pool.query(
            `SELECT l.id, l.phone, l.phone_raw, l.phone_fix_verdict, r.title AS reason,
                    l.last_name, l.first_name, l.middle_name,
                    COALESCE(NULLIF(s.lead_source, ''), s.root_source) AS source_label,
                    l.created_at
               FROM leads l
               LEFT JOIN phone_fix_reasons r ON r.id = l.phone_fix_reason_id
               LEFT JOIN sources s ON s.id = l.source_id
              WHERE l.phone_normalized = false AND l.merged_into_id IS NULL
              ORDER BY r.sort_order NULLS LAST, l.id`);
        const total = await pool.query('SELECT count(*)::int AS n FROM leads WHERE merged_into_id IS NULL');

        const VERDICTS = {
            pending: 'на разборе', checked: 'проверен', hopeless: 'безнадёжен', fixed: 'исправлен'
        };
        // Точка с запятой, а не запятая: Excel в русской локали разбирает по
        // ней. Кавычки удваиваются — номер бывает записан как угодно, включая
        // кавычки внутри строки.
        const cell = (value) => `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;
        const line = (cells) => cells.map(cell).join(';');

        // Первая строка — заголовок прогона (требование куратора И71): файл,
        // найденный через месяц, должен сам говорить, откуда он.
        const head = line([
            `Номера на разбор · снято ${formatMoscowStamp(new Date())} · коммит ${currentCommit()}` +
            ` · лидов всего ${total.rows[0].n} · не привелось ${rows.rows.length}`
        ]);
        const header = line(['Лид', 'Исходная строка', 'Что сейчас в базе', 'Причина', 'Вердикт',
            'ФИО', 'Источник', 'Заведён']);
        const body = rows.rows.map((r) => line([
            r.id,
            r.phone_raw || r.phone,
            r.phone,
            r.reason || '',
            VERDICTS[r.phone_fix_verdict] || '',
            [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' '),
            r.source_label || '',
            formatMoscowStamp(r.created_at)
        ]));

        // BOM обязателен: без метки Excel открывает кириллицу мусором, и весь
        // смысл выгрузки пропадает на ровном месте (И71).
        const csv = '﻿' + [head, header, ...body].join('\r\n') + '\r\n';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="phone-fix-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(csv);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось собрать список номеров на разбор' });
    }
});

// GET /api/leads-admin/:id
router.get('/:id', async (req, res) => {
    try {
        const lead = await fetchLeadById(req.params.id);
        if (!lead) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        res.json(lead);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить лида' });
    }
});

// POST /api/leads-admin — создание вручную. Обязательны телефон, линия,
// источник, минимум один оффер, скрипт и минимум один статус показа.
//
// ДУБЛЬ ТЕПЕРЬ БЛОКИРУЕТ, и это часть 4 (Б1.5). Раньше здесь не было ни одной
// сверки: дубль ловил фронт по blur через check-phone, а эндпоинт вставлял
// строку молча. С уникальностью номера на уровне базы такое создание падало бы
// голым 23505 — поэтому номер приводится, существующий ищется, и вместо ошибки
// базы приходит 409 с идентификатором найденного (решение куратора И33).
router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
        const validation = await validateFullLeadBody(client, req.body);
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }
        // Новый лид — сравнивать не с чем, назначение всегда «меняется».
        const lineError = await checkEmployeeLine(client, {
            employeeId: req.body.employeeId,
            lineType: req.body.lineType
        });
        if (lineError) {
            return res.status(400).json({ error: lineError });
        }

        const phoneFix = await phoneColumnsFor(client, req.body.phone, null);
        const twin = await findLeadByPhone(client, phoneFix.phone);
        if (twin) {
            return res.status(409).json({
                error: `Лид с номером ${phoneFix.phone} уже есть: ${leadTitle(twin)} (№${twin.id})`,
                duplicateId: twin.id
            });
        }

        await client.query('BEGIN');
        const body = { ...req.body };
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        // Номер кладётся приведённым, а рядом — что с ним стало: разобрался ли,
        // по какой причине нет и как выглядела исходная строка.
        values[columns.indexOf('phone')] = phoneFix.phone;
        columns.push('phone_raw', 'phone_normalized', 'phone_fix_reason_id', 'phone_fix_verdict');
        values.push(phoneFix.phone_raw, phoneFix.phone_normalized, phoneFix.phone_fix_reason_id, phoneFix.phone_fix_verdict);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await client.query(
            `INSERT INTO leads (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const leadId = result.rows[0].id;
        await replaceLeadLinks(client, leadId, validation.data);
        await client.query('COMMIT');

        res.status(201).json(await fetchLeadById(leadId));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (handleDuplicatePhone(err, res, req.body.phone)) return;
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать лида' });
    } finally {
        client.release();
    }
});

// PUT /api/leads-admin/:id — те же поля и та же валидация, что у POST
// (в отличие от routes/leads.js — без ограничения по employeeId).
router.put('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const validation = await validateFullLeadBody(client, req.body);
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }
        // Текущее назначение нужно, чтобы отличить «пользователь назначил
        // нового оператора» от «легаси-назначение просто приехало обратно».
        // Номер и его разбор — оттуда же: вердикт, вынесенный человеком, не
        // должен стираться сохранением карточки по другому поводу.
        const current = await client.query(
            'SELECT employee_id, phone, phone_raw, phone_fix_verdict FROM leads WHERE id = $1',
            [req.params.id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const lineError = await checkEmployeeLine(client, {
            employeeId: req.body.employeeId,
            lineType: req.body.lineType,
            currentEmployeeId: current.rows[0].employee_id
        });
        if (lineError) {
            return res.status(400).json({ error: lineError });
        }

        const phoneFix = await phoneColumnsFor(client, req.body.phone, current.rows[0]);
        const twin = await findLeadByPhone(client, phoneFix.phone, Number(req.params.id));
        if (twin) {
            return res.status(409).json({
                error: `Номер ${phoneFix.phone} уже у другого лида: ${leadTitle(twin)} (№${twin.id}). ` +
                    'Сохранить нельзя — лидов можно объединить',
                duplicateId: twin.id
            });
        }

        await client.query('BEGIN');
        const body = { ...req.body };
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values[FIELD_COLUMNS.findIndex(([, col]) => col === 'phone')] = phoneFix.phone;
        values.push(phoneFix.phone_raw, phoneFix.phone_normalized, phoneFix.phone_fix_reason_id, phoneFix.phone_fix_verdict);
        setClauses.push(
            `phone_raw = $${values.length - 3}`,
            `phone_normalized = $${values.length - 2}`,
            `phone_fix_reason_id = $${values.length - 1}`,
            `phone_fix_verdict = $${values.length}`
        );
        values.push(req.params.id);
        // ПОМЕТКА «заполнена частично» СНИМАЕТСЯ ЛЮБЫМ СОХРАНЕНИЕМ КАРТОЧКИ, и
        // этот экран стал единственным путём к ней (заход 6). Раньше пометку
        // снимал только оператор: лид оставался в очереди, оператор его брал и
        // дописывал. Теперь лид уходит из очереди со статусом «Нет результата», и
        // первым его открывает руководитель — поставит окончательный статус, и
        // лид к оператору уже не вернётся, а пометка осталась бы на нём навсегда.
        //
        // Снимается БЕЗУСЛОВНО, а не «если что-то дописали»: человек открыл
        // карточку, посмотрел и сохранил — он её и принял. Сравнивать поля до и
        // после значило бы решать за него, достаточно ли он сделал.
        const result = await client.query(
            `UPDATE leads SET ${setClauses.join(', ')}, partially_filled = false, updated_at = NOW()
              WHERE id = $${values.length} RETURNING id`,
            values
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const leadId = result.rows[0].id;
        await replaceLeadLinks(client, leadId, validation.data);
        await client.query('COMMIT');

        res.json(await fetchLeadById(leadId));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (handleDuplicatePhone(err, res, req.body.phone)) return;
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить лида' });
    } finally {
        client.release();
    }
});

// POST /api/leads-admin/:id/merge { otherId } — объединить двух лидов.
//
// ОТДЕЛЬНАЯ ВЫЗЫВАЕМАЯ ОПЕРАЦИЯ, а не шаг миграции: требование паспорта Р10.
// Кнопка «Объединить лидов» на экране разбора зовёт ровно её, и миграция,
// найдя дубли, зовёт её же. Кто из двух старший, решает не вызывающий, а сама
// операция — по дате создания (правило 1 плана 5.4).
router.post('/:id/merge', async (req, res) => {
    try {
        const otherId = Number(req.body && req.body.otherId);
        if (!Number.isInteger(otherId) || otherId <= 0) {
            return res.status(400).json({ error: 'Не указан второй лид для объединения' });
        }
        if (otherId === Number(req.params.id)) {
            return res.status(400).json({ error: 'Лида нельзя объединить с самим собой' });
        }
        const result = await mergeLeads(pool, req.params.id, otherId);
        res.json({
            leadId: result.elderId,
            mergedId: result.juniorId,
            lead: await fetchLeadById(result.elderId)
        });
    } catch (err) {
        // .reason ставит сам механизм слияния: «не найден», «уже влит», «разные
        // номера». Это ответы человеку, а не поломка сервера.
        if (err.reason) {
            return res.status(err.reason === 'not-found' ? 404 : 400).json({ error: err.message });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось объединить лидов' });
    }
});

// DELETE /api/leads-admin/:id — порядок плана 11.4, «Лид».
//
// ФИЗИЧЕСКОЕ УДАЛЕНИЕ ЛИДА ОСТАЁТСЯ РОВНО ДЛЯ ОДНОГО СЛУЧАЯ: «завели не того,
// ни одного звонка не было» (план 11.2). Всё остальное — архив.
//
// Шаг 1 — есть звонки? Запрещено, только архив. Таблицы звонков ещё нет, она
// придёт частью 6; место под эту помеху размечено в deleteGuards (kind
// 'calls'), и добавить её будет одной строкой. Пока не притворяемся, что
// проверяем: помехи нет, потому что нет данных, а не потому что мы решили её
// не смотреть.
//
// Шаг 2 — связи с офферами, статусы скриптов и строка пула уходят каскадом
// (класс А). Связка с офферами оставлена каскадной СО СТОРОНЫ ЛИДА намеренно:
// офферы обязательны при создании (validateLeadParams требует минимум один),
// значит запрет здесь сделал бы удаление невозможным всегда, и правило,
// заведённое ради одного случая, не сработало бы ни разу (ответ куратора И72).
//
// Шаг 3 — сам лид.
//
// Помех две. В лида могли влить дубли (часть 4) — указатель слияния
// запрещающий. И у лида могут быть ЗВОНКИ (часть 7А): «есть звонки — запрещено,
// только архив» (план 11.4). Это главная причина, по которой лида вообще не
// удаляют: физическое удаление остаётся для явных ошибок ввода — «завели не
// того, ни одного звонка не было».
//
// Обе отдаются структурой, а не голым 23503: связь запрещающая, и без этой
// проверки человек получил бы номер ошибки Postgres вместо числа звонков.
//
// ЧЕГО В ПОМЕХАХ НЕТ И НЕ БУДЕТ — заполненного поля notes (ответ куратора
// И73). Текст уезжает в журнал при удалении и восстановим оттуда; отказывать в
// удалении ошибочно заведённого лида из-за непустого поля — придирка, которую
// человек справедливо не поймёт.
router.delete('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const blockers = guards.orderBlockers([
            await guards.countBlocker(pool, 'calls',
                `FROM calls c WHERE c.lead_id = $1 ORDER BY c.id`, [id]),
            await guards.countBlocker(pool, 'merged_leads',
                `FROM leads l WHERE l.merged_into_id = $1 ORDER BY l.id`, [id])
        ]);
        if (blockers.length > 0) return guards.refuse(res, blockers);

        const found = await pool.query(
            'SELECT last_name, first_name, phone FROM leads WHERE id = $1', [id]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        const who = found.rows[0];
        const title = [who.last_name, who.first_name].filter(Boolean).join(' ') || who.phone;
        const removed = await guards.deleteAsBatch(
            pool, `Удаление лида «${title}»`,
            (client) => client.query('DELETE FROM leads WHERE id = $1 RETURNING id', [id]));
        if (removed.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить лида' });
    }
});

// ---------------------------------------------------------------------------
// АРХИВ ЛИДА (часть 5, план 11.2, решения владельца 74 и 75)
// ---------------------------------------------------------------------------
//
// Архив — это ПОМЕТКА, а не удаление, и в журнале она обязана читаться как
// обычная правка поля, а не как отдельный вид операции (паспорт Р7). Поэтому
// здесь нет ни партии на один лид, ни служебного автора: правку делает человек,
// триггер части 3 записывает её сам, с автором и страницей.

/** Общая часть: находит лида и проверяет, что с ним можно это сделать. */
async function loadLeadForArchive(id, res, wantArchived) {
    const found = await pool.query(
        'SELECT id, last_name, first_name, phone, archived_at, merged_into_id FROM leads WHERE id = $1',
        [id]);
    if (found.rows.length === 0) {
        res.status(404).json({ error: 'Лид не найден' });
        return null;
    }
    const lead = found.rows[0];
    if (lead.merged_into_id !== null) {
        // Слитый лид уже вне работы: он влит в старшего и не участвует нигде.
        // Отправлять его в архив нечего — состояние получилось бы двойным, и
        // объяснить, что оно значит, было бы нельзя.
        res.status(409).json({ error: 'Этот лид влит в другого — архив к нему неприменим' });
        return null;
    }
    if (wantArchived && lead.archived_at !== null) {
        res.status(409).json({ error: 'Лид уже в архиве' });
        return null;
    }
    if (!wantArchived && lead.archived_at === null) {
        res.status(409).json({ error: 'Лид не в архиве' });
        return null;
    }
    return lead;
}

// POST /api/leads-admin/:id/archive — отправить лида в архив.
router.post('/:id/archive', async (req, res) => {
    try {
        const lead = await loadLeadForArchive(req.params.id, res, true);
        if (!lead) return;

        const actor = auditContext.currentActor();
        const result = await pool.query(
            `UPDATE leads
                SET archived_at = NOW(),
                    archived_actor_id = $2,
                    archived_actor_kind = $3,
                    archived_actor_name = $4,
                    -- Открытая карточка закрывается, employee_id остаётся. Тот
                    -- же приём, что у слияния (services/leadMerge.js): лид
                    -- уходит из работы, но за кем он числился — остаётся видно.
                    opened_at = NULL,
                    updated_at = NOW()
              WHERE id = $1
          RETURNING id, archived_at, archived_actor_name`,
            [lead.id, actor.id, actor.kind, actor.name]);
        // ЖИВОЙ КАНАЛ (часть 6, В3). Единственное настоящее событие, которое
        // сегодня по нему едет: труба, по которой ни разу не проехал настоящий
        // груз, проверена не будет (ответ куратора И119).
        //
        // Полезной нагрузкой — только идентификатор и время. Канал открыт, и
        // класть в него телефон значит раздавать его всякому, кто открыл адрес.
        eventChannel.publish('lead:archived', {
            id: result.rows[0].id,
            archivedAt: result.rows[0].archived_at
        });
        res.json({
            id: result.rows[0].id,
            archivedAt: result.rows[0].archived_at,
            archivedActorName: result.rows[0].archived_actor_name
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось отправить лида в архив' });
    }
});

// POST /api/leads-admin/:id/unarchive — вернуть лида из архива.
//
// СТАТУС НЕ ТРОГАЕТСЯ (ответ куратора И85). Решение владельца 75: все ранее
// проставленные статусы окончательны, и менять их — работа решения 74, где это
// делает входящий звонок. Поэтому возврат из архива сам по себе НЕ обещает
// очереди: лид со статусом «Отказ» вернётся, а в раздачу не попадёт.
//
// Чтобы окно 5Б не обещало лишнего, ответ несёт признак placement: 'now' |
// 'later' | 'none'. Три значения, а не два — «перезвон на завтра» самый частый
// случай у работающего оператора, и свалить его в любую из крайностей значит
// соврать в том самом окне, по которому человек принимает решение.
router.post('/:id/unarchive', async (req, res) => {
    try {
        const lead = await loadLeadForArchive(req.params.id, res, false);
        if (!lead) return;

        const result = await pool.query(
            `UPDATE leads
                SET archived_at = NULL,
                    archived_actor_id = NULL,
                    archived_actor_kind = NULL,
                    archived_actor_name = NULL,
                    updated_at = NOW()
              WHERE id = $1 RETURNING id`,
            [lead.id]);
        // Считается ПОСЛЕ снятия архива: условие очереди само проверяет
        // archived_at, и на архивном лиде ответ был бы всегда 'none'.
        const placement = await queuePlacement(pool, lead.id);
        // Раздача запускается только когда лид действительно готов работать:
        // гонять полный проход ради лида с окончательным статусом незачем.
        if (placement === 'now') await distributePendingLeads(pool);
        res.json({ id: result.rows[0].id, placement });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось вернуть лида из архива' });
    }
});

// POST /api/leads-admin/bulk-archive { leadIds } — «Отправить в архив» пачкой.
//
// Кнопки этого действия ещё нет (экран — отдельная часть, решение владельца
// 76), но серверная половина делается сейчас (ответ куратора И90): иначе экран
// упрётся в её отсутствие, а партия журнала — механизм части 3, уже в бою.
//
// ОДНОЙ ПАРТИЕЙ: полсотни лидов, отправленных в архив одним нажатием, обязаны
// читаться в журнале как одно действие (Б2.10).
router.post('/bulk-archive', async (req, res) => {
    const ids = normalizeIdArray(req.body && req.body.leadIds);
    if (ids === null) return res.status(400).json({ error: 'Некорректный список лидов' });
    if (ids.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного лида' });

    try {
        // СНАЧАЛА СМОТРИМ, ЕСТЬ ЛИ ЧТО ДЕЛАТЬ. Партия заводится строкой в
        // журнале до самой работы, и без этой проверки повторное нажатие по уже
        // архивным лидам оставляло бы в журнале пустую партию — запись о
        // действии, которого не было. Гонку это не закрывает (кто-то успеет
        // заархивировать между проверкой и правкой), но убирает единственный
        // случай, который случается регулярно: нажали дважды.
        const pending = await pool.query(
            `SELECT id FROM leads
              WHERE id = ANY($1::int[]) AND archived_at IS NULL AND merged_into_id IS NULL`,
            [ids]);
        if (pending.rows.length === 0) {
            return res.json({ archived: 0, skipped: ids.length });
        }

        const actor = auditContext.currentActor();
        const archived = await auditContext.runAsBatch(
            pool, { kind: 'archive', title: 'Отправка лидов в архив', actorName: 'Отправка в архив' },
            () => pool.query(
                `UPDATE leads
                    SET archived_at = NOW(),
                        archived_actor_id = $2,
                        archived_actor_kind = $3,
                        archived_actor_name = $4,
                        opened_at = NULL,
                        updated_at = NOW()
                  WHERE id = ANY($1::int[])
                    AND archived_at IS NULL
                    AND merged_into_id IS NULL
              RETURNING id, archived_at`,
                [ids, actor.id, actor.kind, actor.name]));
        // В КАНАЛ УХОДИТ СОБЫТИЕ НА КАЖДОГО, а не одно на пачку: подписчик
        // следит за строками, а не за нашими кнопками, и разница между «один лид
        // отправили сорок раз» и «сорок лидов ушли разом» ему не видна и не
        // нужна. Отправляется ПОСЛЕ того, как правка закреплена в базе.
        for (const row of archived.rows) {
            eventChannel.publish('lead:archived', { id: row.id, archivedAt: row.archived_at });
        }
        // Пропущенные названы числом, а не молчанием: человек выделил сорок
        // строк, а в архив ушло тридцать восемь — он обязан это увидеть.
        res.json({ archived: archived.rows.length, skipped: ids.length - archived.rows.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось отправить лидов в архив' });
    }
});

// POST /api/leads-admin/script-pairs-preview { leadIds } — сколько из выбранных
// лидов УЖЕ имеют наборы скриптов.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ. Окно массового назначения обязано сказать заранее:
// «У 9 лидов из 24 скрипты уже назначены. Они будут заменены целиком, а не
// дополнены» (паспорт Р11). Посчитать это на клиенте нечем — списки статусов
// лидов на страницу не грузятся, в таблице лежит только название действующего
// скрипта, а его нет как раз у того лида, чей текущий статус не покрыт.
//
// Ничего не меняет: только считает. Поэтому POST, а не GET, — список
// идентификаторов уходит телом, и в адресной строке ему не место.
router.post('/script-pairs-preview', async (req, res) => {
    const ids = normalizeIdArray(req.body && req.body.leadIds);
    if (ids === null) return res.status(400).json({ error: 'Некорректный список лидов' });
    if (ids.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного лида' });
    try {
        const result = await pool.query(
            `SELECT count(DISTINCT lss.lead_id)::int AS with_pairs
               FROM lead_script_statuses lss
              WHERE lss.lead_id = ANY($1::int[])`, [ids]);
        res.json({ total: ids.length, withPairs: result.rows[0].with_pairs });
    } catch (err) {
        console.error('Ошибка подсчёта наборов у выбранных лидов:', err);
        res.status(500).json({ error: 'Не удалось посчитать наборы у выбранных лидов' });
    }
});

// POST /api/leads-admin/bulk-update { leadIds, patch } — лёгкая PATCH-семантика
// под массовые действия списка (dialog.md B1). Полное тело лида не требуется,
// поэтому массово править можно и старых лидов, у которых ещё не заполнены
// обязательные для PUT поля. patch — строгий whitelist из четырёх ключей.
router.post('/bulk-update', async (req, res) => {
    const { leadIds, patch } = req.body;

    const ids = normalizeIdArray(leadIds);
    if (ids === null) return res.status(400).json({ error: 'Некорректный список лидов' });
    if (ids.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного лида' });

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'Не передан набор изменений' });
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) return res.status(400).json({ error: 'Не передан набор изменений' });
    // scriptPairs — не колонка, поэтому в whitelist его нет, а разрешить надо.
    const unknown = keys.filter((key) => key !== 'scriptPairs'
        && !Object.prototype.hasOwnProperty.call(BULK_PATCH_COLUMNS, key));
    if (unknown.length > 0) {
        return res.status(400).json({ error: `Это поле нельзя изменить массово: ${unknown.join(', ')}` });
    }

    let massPairs = null;
    if (keys.includes('scriptPairs')) {
        // Проверка ТА ЖЕ, что у карточки: массовое действие не должно быть
        // чёрным ходом мимо правил — ровно тот довод, по которому у bulk-update
        // вообще появился whitelist.
        const pairsCheck = await validateScriptPairs(pool, patch.scriptPairs);
        if (pairsCheck.error) return res.status(400).json({ error: pairsCheck.error });
        massPairs = pairsCheck.data;
    }

    try {

        // Массовое назначение оператора проверяется по КАЖДОМУ лиду отдельно:
        // линия у них своя, а у части может стоять то же назначение (тогда
        // ничего не меняется и проверять нечего). Всё или ничего — применить
        // к части выбранных нельзя, иначе пользователь не поймёт, что вышло.
        if (keys.includes('employeeId') && patch.employeeId) {
            const leads = await pool.query('SELECT id, employee_id, line_type FROM leads WHERE id = ANY($1::int[])', [ids]);
            for (const lead of leads.rows) {
                const lineError = await checkEmployeeLine(pool, {
                    employeeId: patch.employeeId,
                    lineType: lead.line_type,
                    currentEmployeeId: lead.employee_id
                });
                if (lineError) {
                    return res.status(400).json({ error: `Лид #${lead.id}: ${lineError}` });
                }
            }
        }

        // Колонок может не быть вовсе — когда массово меняют только пары.
        const columnKeys = keys.filter((key) => key !== 'scriptPairs');

        // ОДНОЙ ТРАНЗАКЦИЕЙ, а не двумя запросами подряд: правка колонок и замена
        // пар — одно действие человека, и остановка между ними оставила бы часть
        // лидов с новыми парами и старым оператором.
        const client = await pool.connect();
        let touched;
        try {
            await client.query('BEGIN');

            if (columnKeys.length > 0) {
                const setClauses = columnKeys.map((key, i) => `${BULK_PATCH_COLUMNS[key]} = $${i + 1}`);
                const values = columnKeys.map((key) => normalizeValue(key, patch[key]));
                values.push(ids);
                const result = await client.query(
                    `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = ANY($${values.length}::int[]) RETURNING id`,
                    values
                );
                touched = result.rows.length;
            } else {
                const found = await client.query('SELECT id FROM leads WHERE id = ANY($1::int[])', [ids]);
                touched = found.rows.length;
            }

            if (massPairs) {
                // Замена, а не дополнение: пары лида — набор целиком, и «добавить
                // пятую к четырём чужим» превысило бы потолок молча.
                await client.query('DELETE FROM lead_script_statuses WHERE lead_id = ANY($1::int[])', [ids]);
                await insertBatchLinks(client, ids, { offerIds: [], scriptPairs: massPairs, poolEmployeeIds: [] });
                await client.query('UPDATE leads SET updated_at = NOW() WHERE id = ANY($1::int[])', [ids]);
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        res.json({ updated: touched });
    } catch (err) {
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось применить массовое изменение' });
    }
});

// POST /api/leads-admin/bulk-import — массовая загрузка. Парсинг Excel/CSV на
// фронте, сюда приходит готовый JSON: { sourceId, lineType, scriptId,
// offerIds, scriptPairs, poolEmployeeIds?, rows }.
// Один набор параметров на всю партию. Каждая строка становится лидом со
// статусом "Новый" и без оператора; сразу после вставки запускается
// автораспределение. Дубли по телефону — внутри файла и против существующих
// лидов — с части 4 ПРОПУСКАЮТСЯ и называются в ответе двумя разными
// причинами. Вся вставка + связки + распределение — одной транзакцией.
router.post('/bulk-import', async (req, res) => {
    // fileName пришёл вместе с частью 3: в журнале партия разворачивается в
    // сводку, и «какой файл залили» — первый вопрос при разборе неудачной
    // загрузки. Раньше браузер разбирал файл сам и имя никуда не отдавал.
    const { sourceId, rows, fileName } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'Файл пуст или не содержит строк для загрузки' });
    }

    const client = await pool.connect();
    try {
        const validation = await validateLeadParams(client, req.body);
        if (validation.error) {
            return res.status(400).json({ error: validation.error });
        }
        const { offerIds, scriptPairs, poolEmployeeIds } = validation.data;

        // Потолок на лида (проверен выше) партию не защищает: связки
        // перемножаются, и 5000 строк × 1000 офферов дали бы 5 млн строк в
        // одной транзакции — таймаут прокси с откатом всей загрузки в конце.
        // Считаем по rows.length, а не по числу строк с телефоном: это верхняя
        // граница, и отбить партию нужно ДО того, как начнём вставку.
        const linkCount = rows.length * offerIds.length;
        if (linkCount > MAX_OFFER_LINKS_PER_BATCH) {
            return res.status(400).json({
                error: `Слишком большая партия: ${rows.length} строк × ${offerIds.length} офферов = ${linkCount} связок, максимум ${MAX_OFFER_LINKS_PER_BATCH}. Уменьшите файл или сузьте набор офферов`
            });
        }

        await client.query('BEGIN');

        // ПАРТИЯ. Пять тысяч лидов — одно действие человека, и в журнале оно
        // обязано читаться как одно (Б2.10). Признак ставится на это же
        // соединение, в открытую транзакцию: не состоится загрузка — откатится
        // и он.
        const batchId = await auditContext.startBatch(pool, {
            kind: 'import',
            title: 'Загрузка базы лидов',
            fileName: typeof fileName === 'string' ? fileName.slice(0, 255) : null
        });
        await auditContext.markClientBatch(client, batchId, 'Импорт');

        const newStatusId = await findNewFunnelStatusId(client);
        if (newStatusId === null) {
            await client.query('ROLLBACK');
            return res.status(500).json({ error: 'Не найден системный статус "Новый" — обратитесь к разработчику' });
        }

        const insertedIds = [];
        const duplicates = [];
        // Номера этой партии: дубль внутри файла ловится здесь, а не запросом к
        // базе — вставленных строк в базе ещё нет до конца транзакции только для
        // чужих соединений, но идти к ней за тем, что мы сами только что
        // положили, незачем.
        const seenInFile = new Map();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const raw = row.phone ? String(row.phone).trim() : '';
            if (!raw) continue; // без телефона строку вставить нельзя (leads.phone NOT NULL)

            // Приведение — то же самое, что в карточке и в миграции (Б1.6).
            const phoneFix = await phoneColumnsFor(client, raw, null);

            // ДУБЛЬ ПРОПУСКАЕТСЯ, А НЕ ВСТАВЛЯЕТСЯ (решение куратора И54).
            // Раньше найденный дубль клался в отчёт, после чего INSERT шёл
            // безусловно — с уникальностью номера (Б1.5) это уронило бы всю
            // загрузку посреди тысячи строк. Сливать здесь тоже нельзя: правило
            // «свежие побеждают» писалось про слияние, где решает человек, а не
            // про файл, где не решает никто. Молча переписать карточку, которую
            // ведёт оператор, — это потеря работы без следа.
            //
            // ПРИЧИНЫ ДВЕ, И НАЗЫВАТЬ ИХ ОДНИМ СЛОВОМ НЕЛЬЗЯ (И56): «дубль
            // внутри файла» значит, что файл грязный, «дубль в базе» — что
            // человек уже заведён. По отчёту должно быть понятно, что чинить.
            const twinInFile = seenInFile.get(phoneFix.phone);
            if (twinInFile !== undefined) {
                duplicates.push({ row: i + 1, raw, phone: phoneFix.phone, kind: 'in-file', firstRow: twinInFile });
                continue;
            }
            const existing = await findLeadByPhone(client, phoneFix.phone);
            if (existing) {
                duplicates.push({ row: i + 1, raw, phone: phoneFix.phone, kind: 'in-base', existingLeadId: existing.id });
                continue;
            }
            seenInFile.set(phoneFix.phone, i + 1);

            const inserted = await client.query(
                `INSERT INTO leads (last_name, first_name, middle_name, phone, source_id, funnel_status_id,
                                    line_type,
                                    phone_raw, phone_normalized, phone_fix_reason_id, phone_fix_verdict)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
                [
                    row.lastName ? String(row.lastName).trim() || null : null,
                    row.firstName ? String(row.firstName).trim() || null : null,
                    row.middleName ? String(row.middleName).trim() || null : null,
                    phoneFix.phone,
                    sourceId,
                    newStatusId,
                    req.body.lineType,
                    phoneFix.phone_raw,
                    phoneFix.phone_normalized,
                    phoneFix.phone_fix_reason_id,
                    phoneFix.phone_fix_verdict
                ]
            );
            insertedIds.push(inserted.rows[0].id);
        }

        await insertBatchLinks(client, insertedIds, { offerIds, scriptPairs, poolEmployeeIds });
        await distributePendingLeads(client);

        // Сколько именно из ЭТОЙ партии распределилось/осталось в очереди —
        // считаем по insertedIds отдельно, а не по возвращаемому значению
        // distributePendingLeads(): та разбирает ВСЮ зависшую очередь разом
        // (включая лидов из прошлых загрузок), поэтому её общее число не
        // равно доле именно этой партии.
        const batchStatus = await client.query(
            `SELECT count(*) FILTER (WHERE employee_id IS NOT NULL)::int AS assigned,
                    count(*) FILTER (WHERE employee_id IS NULL)::int AS queued
             FROM leads WHERE id = ANY($1::int[])`,
            [insertedIds]
        );
        const { assigned, queued } = batchStatus.rows[0];

        // Сколько строк партии ушло в разбор — число этой части. Без него
        // загрузка выглядела бы удачной целиком, а часть номеров молча лежала
        // бы неприведённой: ровно то, чего требует не допускать план 5.3.
        const unresolvedRows = await client.query(
            'SELECT count(*)::int AS n FROM leads WHERE id = ANY($1::int[]) AND phone_normalized = false',
            [insertedIds]);

        await client.query('COMMIT');
        res.status(201).json({
            imported: insertedIds.length,
            distributed: assigned,
            queued,
            unresolved: unresolvedRows.rows[0].n,
            duplicates
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505' && err.constraint === 'idx_leads_phone_unique') {
            return res.status(409).json({
                error: 'В файле есть номер, который уже занят другим лидом. Загрузка отменена целиком — ' +
                    'проверьте файл и повторите'
            });
        }
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось загрузить базу' });
    } finally {
        client.release();
    }
});

module.exports = router;
