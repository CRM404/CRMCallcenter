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
const { startOfDay, startOfNextDay, zonedParts } = require('../services/appTime');
const { distributePendingLeads, findNewFunnelStatusId } = require('../services/leadDistribution');
const { normalizePhone, normalizeForSearch } = require('../services/phoneFormat');
const { phoneColumnsFor, findLeadByPhone, leadTitle } = require('../services/phoneFix');
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
    ['scriptId', 'script_id'],
    ['repeatScriptId', 'repeat_script_id'],
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

const NUMERIC_FIELDS = new Set(['sourceId', 'employeeId', 'funnelStatusId', 'scriptId', 'repeatScriptId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

// «Иной заёмщик» трёхзначный (NULL / true / false) — та же обработка, что в
// routes/leads.js: без неё строка 'false' из формы легла бы в базу как true.
const BOOLEAN_FIELDS = new Set(['otherBorrower']);

// Ключи, которые разрешено менять через bulk-update. Строгий whitelist, а не
// «всё, что пришло» (требование куратора, dialog.md B1): иначе лёгкий PATCH
// стал бы чёрным ходом мимо обязательной валидации PUT.
const BULK_PATCH_COLUMNS = {
    employeeId: 'employee_id',
    funnelStatusId: 'funnel_status_id',
    scriptId: 'script_id',
    repeatScriptId: 'repeat_script_id'
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
           s.root_source AS source_name,
           CASE WHEN e.id IS NOT NULL THEN e.last_name || ' ' || e.first_name ELSE NULL END AS employee_name,
           fs.status_name, fs.stage_name, fs.stage_number,
           sc.title AS script_title,
           rsc.title AS repeat_script_title,
           COALESCE((SELECT json_agg(json_build_object('id', o.id, 'name', o.name) ORDER BY o.name)
                     FROM lead_offers lo JOIN real_estate_offers o ON o.id = lo.offer_id
                     WHERE lo.lead_id = l.id), '[]'::json) AS offers,
           COALESCE((SELECT json_agg(lss.funnel_status_id ORDER BY lss.funnel_status_id)
                     FROM lead_script_statuses lss WHERE lss.lead_id = l.id), '[]'::json) AS script_status_ids,
           COALESCE((SELECT json_agg(ldp.employee_id ORDER BY ldp.employee_id)
                     FROM lead_distribution_pool ldp WHERE ldp.lead_id = l.id), '[]'::json) AS pool_employee_ids
    FROM leads l
    LEFT JOIN sources s ON s.id = l.source_id
    LEFT JOIN employees e ON e.id = l.employee_id
    LEFT JOIN lead_funnel_statuses fs ON fs.id = l.funnel_status_id
    LEFT JOIN scripts sc ON sc.id = l.script_id
    LEFT JOIN scripts rsc ON rsc.id = l.repeat_script_id
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
        stageName: row.stage_name,
        stageNumber: row.stage_number,
        scriptId: row.script_id,
        scriptTitle: row.script_title,
        repeatScriptId: row.repeat_script_id,
        repeatScriptTitle: row.repeat_script_title,
        offers,
        offerIds: offers.map((o) => o.id),
        scriptStatusIds: row.script_status_ids || [],
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
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

const FK_MESSAGES = {
    leads_source_id_fkey: 'Указанный источник не найден',
    leads_employee_id_fkey: 'Указанный сотрудник не найден',
    leads_funnel_status_id_fkey: 'Указанный статус воронки не найден',
    leads_script_id_fkey: 'Указанный скрипт не найден',
    leads_repeat_script_id_fkey: 'Указанный скрипт для повторных не найден',
    lead_offers_offer_id_fkey: 'Один из выбранных офферов не найден',
    lead_script_statuses_funnel_status_id_fkey: 'Один из выбранных статусов показа не найден',
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

// "Повторные" = этапы воронки 5 и 6 (решение владельца п.2).
async function hasRepeatStages(db, statusIds) {
    if (statusIds.length === 0) return false;
    const result = await db.query(
        'SELECT 1 FROM lead_funnel_statuses WHERE id = ANY($1::int[]) AND stage_number >= 5 LIMIT 1',
        [statusIds]
    );
    return result.rows.length > 0;
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

    const scriptStatusIds = normalizeIdArray(body.scriptStatusIds);
    if (scriptStatusIds === null) return { error: 'Некорректный список статусов показа скрипта' };
    if (scriptStatusIds.length === 0) return { error: 'Выберите хотя бы один статус показа скрипта' };

    const poolEmployeeIds = normalizeIdArray(body.poolEmployeeIds);
    if (poolEmployeeIds === null) return { error: 'Некорректный список сотрудников для пула раздачи' };

    if (!body.scriptId) return { error: 'Заполните обязательное поле: Скрипт' };
    const scriptError = await checkActiveScript(db, body.scriptId, 'Скрипт');
    if (scriptError) return { error: scriptError };

    // Скрипт для повторных обязателен, если среди статусов показа есть этапы
    // 5–6. Если не обязателен, но всё равно передан — сохраняем (лид может
    // дойти до повторного этапа и без такого статуса в списке), но проверяем
    // так же строго.
    const repeatScriptId = body.repeatScriptId ? Number(body.repeatScriptId) : null;
    const needsRepeat = await hasRepeatStages(db, scriptStatusIds);
    if (needsRepeat && !repeatScriptId) {
        return { error: 'Среди статусов показа есть этапы 5–6 — укажите скрипт для повторных' };
    }
    if (repeatScriptId) {
        const repeatError = await checkActiveScript(db, repeatScriptId, 'Скрипт для повторных');
        if (repeatError) return { error: repeatError };
    }

    return { data: { offerIds, scriptStatusIds, poolEmployeeIds, repeatScriptId } };
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
async function replaceLeadLinks(client, leadId, { offerIds, scriptStatusIds, poolEmployeeIds }) {
    await client.query('DELETE FROM lead_offers WHERE lead_id = $1', [leadId]);
    if (offerIds.length > 0) {
        await client.query('INSERT INTO lead_offers (lead_id, offer_id) SELECT $1, unnest($2::int[])', [leadId, offerIds]);
    }
    await client.query('DELETE FROM lead_script_statuses WHERE lead_id = $1', [leadId]);
    if (scriptStatusIds.length > 0) {
        await client.query('INSERT INTO lead_script_statuses (lead_id, funnel_status_id) SELECT $1, unnest($2::int[])', [leadId, scriptStatusIds]);
    }
    await client.query('DELETE FROM lead_distribution_pool WHERE lead_id = $1', [leadId]);
    if (poolEmployeeIds.length > 0) {
        await client.query('INSERT INTO lead_distribution_pool (lead_id, employee_id) SELECT $1, unnest($2::int[])', [leadId, poolEmployeeIds]);
    }
}

// Тот же набор связок сразу на всю партию — одним запросом на связку,
// а не на каждого лида: CROSS JOIN двух unnest'ов даёт декартово
// произведение "все лиды партии × все значения набора".
async function insertBatchLinks(client, leadIds, { offerIds, scriptStatusIds, poolEmployeeIds }) {
    if (leadIds.length === 0) return;
    if (offerIds.length > 0) {
        await client.query(
            `INSERT INTO lead_offers (lead_id, offer_id)
             SELECT l, o FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) o
             ON CONFLICT DO NOTHING`,
            [leadIds, offerIds]
        );
    }
    if (scriptStatusIds.length > 0) {
        await client.query(
            `INSERT INTO lead_script_statuses (lead_id, funnel_status_id)
             SELECT l, s FROM unnest($1::int[]) l CROSS JOIN unnest($2::int[]) s
             ON CONFLICT DO NOTHING`,
            [leadIds, scriptStatusIds]
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

        const result = await pool.query(`
            SELECT
                count(*)::int AS total,
                count(*) FILTER (WHERE employee_id IS NULL)::int AS queue,
                count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS today
            FROM leads
        `, [dayStart, dayEnd]);
        const row = result.rows[0];
        res.json({ total: row.total, queue: row.queue, today: row.today, todayDate });
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
                    l.last_name, l.first_name, l.middle_name, s.root_source, l.created_at
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
            r.root_source || '',
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
        const body = { ...req.body, repeatScriptId: validation.data.repeatScriptId };
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
        const body = { ...req.body, repeatScriptId: validation.data.repeatScriptId };
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
        const result = await client.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
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

// DELETE /api/leads-admin/:id — связки уходят каскадом.
//
// Кроме одного случая: в лида могли влить дубли (часть 4). Тогда удаление
// отбивается связью, и вместо голого 23503 человек обязан получить объяснение —
// сколько лидов в него влито и что они на него ссылаются.
router.delete('/:id', async (req, res) => {
    try {
        const merged = await pool.query(
            'SELECT count(*)::int AS n FROM leads WHERE merged_into_id = $1', [req.params.id]);
        if (merged.rows[0].n > 0) {
            return res.status(400).json({
                error: `Нельзя удалить: в этого лида влито ${merged.rows[0].n} дублей, они на него ссылаются`
            });
        }
        const result = await pool.query('DELETE FROM leads WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить лида' });
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
    const unknown = keys.filter((key) => !Object.prototype.hasOwnProperty.call(BULK_PATCH_COLUMNS, key));
    if (unknown.length > 0) {
        return res.status(400).json({ error: `Это поле нельзя изменить массово: ${unknown.join(', ')}` });
    }

    try {
        for (const key of ['scriptId', 'repeatScriptId']) {
            if (keys.includes(key) && patch[key]) {
                const label = key === 'scriptId' ? 'Скрипт' : 'Скрипт для повторных';
                const scriptError = await checkActiveScript(pool, patch[key], label);
                if (scriptError) return res.status(400).json({ error: scriptError });
            }
        }

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

        const setClauses = keys.map((key, i) => `${BULK_PATCH_COLUMNS[key]} = $${i + 1}`);
        const values = keys.map((key) => normalizeValue(key, patch[key]));
        values.push(ids);
        const result = await pool.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = ANY($${values.length}::int[]) RETURNING id`,
            values
        );
        res.json({ updated: result.rows.length });
    } catch (err) {
        if (handleFkError(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось применить массовое изменение' });
    }
});

// POST /api/leads-admin/bulk-import — массовая загрузка. Парсинг Excel/CSV на
// фронте, сюда приходит готовый JSON: { sourceId, lineType, scriptId,
// repeatScriptId?, offerIds, scriptStatusIds, poolEmployeeIds?, rows }.
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
        const { offerIds, scriptStatusIds, poolEmployeeIds, repeatScriptId } = validation.data;

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
                                    line_type, script_id, repeat_script_id,
                                    phone_raw, phone_normalized, phone_fix_reason_id, phone_fix_verdict)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
                [
                    row.lastName ? String(row.lastName).trim() || null : null,
                    row.firstName ? String(row.firstName).trim() || null : null,
                    row.middleName ? String(row.middleName).trim() || null : null,
                    phoneFix.phone,
                    sourceId,
                    newStatusId,
                    req.body.lineType,
                    req.body.scriptId,
                    repeatScriptId,
                    phoneFix.phone_raw,
                    phoneFix.phone_normalized,
                    phoneFix.phone_fix_reason_id,
                    phoneFix.phone_fix_verdict
                ]
            );
            insertedIds.push(inserted.rows[0].id);
        }

        await insertBatchLinks(client, insertedIds, { offerIds, scriptStatusIds, poolEmployeeIds });
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
