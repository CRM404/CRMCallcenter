// --- routes/leads.js: карточка клиента (лид) для страницы оператора ---
// Видимость строго личная: employeeId передаётся клиентом (нет серверной сессии,
// тот же принцип, что уже принят в проекте) — GET/PUT по :id проверяют, что
// leads.employee_id совпадает с переданным employeeId, и отвечают 403 иначе.
// Это не полноценная защита (клиент технически может передать чужой employeeId),
// но страхует от случайных ошибок — по решению куратора (2026-08-05).

const express = require('express');
const { pool } = require('../db');
const { assignNextLeadForEmployee } = require('../services/leadDistribution');
const { fetchStatusFlags, resolveCallStatusEffects } = require('../services/leadCallRules');
const { resolveWrapupSeconds } = require('../services/callWrapup');
const { withTransaction } = require('../services/dbTx');
const { phoneColumnsFor, findLeadByPhone } = require('../services/phoneFix');

const router = express.Router();

// Порядок должен совпадать со списком колонок в UPDATE ниже. "source" сюда
// намеренно не входит (report_2026-08-01.md, 09.08.2026) — форма оператора
// его больше не показывает (design-решение, риск случайной перезаписи), а
// раз поля нет в форме, PUT присылал бы undefined → normalizeValue превращал
// бы это в null и тихо обнулял source при каждом сохранении карточки — тот
// же баг, что чинили для offerId, только обнаружился по факту удаления поля
// из этой задачи, а не был описан в брифе отдельно.
const EDITABLE_FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['phone', 'phone'],
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

const NUMERIC_FIELDS = new Set(['funnelStatusId', 'priceFrom', 'priceTo', 'areaFrom', 'areaTo', 'downPaymentPercent']);

// «Иной заёмщик» — ТРИ состояния, поэтому отдельно от остальных полей
// (dialog.md H2): null — условие показа не выполнено, поле неприменимо;
// true/false — оператор ответил. Обычная нормализация тут не годится: она
// превращает пустую строку в null (это верно), но строку 'false' из формы
// пропустила бы как непустое значение, и в булеву колонку легло бы true.
const BOOLEAN_FIELDS = new Set(['otherBorrower']);

function rowToLead(row) {
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
        // source и offerId убраны 13.08.2026: обе колонки в leads больше не
        // существуют (source заменён на source_id ещё задачей «Лиды»,
        // offer_id заменён связкой lead_offers этой задачей), поэтому оба
        // поля всегда отдавали undefined. Форма оператора их не показывает и
        // не редактирует — EDITABLE_FIELD_COLUMNS их не содержит.
        employeeId: row.employee_id,
        funnelStatusId: row.funnel_status_id,
        // sourceName приходит только из запроса одной карточки (там есть JOIN);
        // в списке лидов колонки нет, и поле честно остаётся undefined.
        sourceName: row.source_name,
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
        // Рабочий режим оператора (15.08.2026). callAttempts — счётчик СКВОЗНОЙ
        // по всем операторам линии, а не персональный: в интерфейсе это
        // подписано, иначе «Попытка 19 из 20» читается как «мои девятнадцать».
        nextCallAt: row.next_call_at,
        lastCallAt: row.last_call_at,
        callAttempts: row.call_attempts,
        openedAt: row.opened_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

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

// Источник лида для шапки карточки — «Площадка · Корневой источник»
// (формат из макета, dialog.md D1). Собирается на сервере, а не на клиенте:
// иначе странице оператора пришлось бы тянуть весь справочник источников ради
// одной подписи. Только чтение — в EDITABLE_FIELD_COLUMNS поля нет: форма его
// не показывает как поле, а PUT прислал бы undefined и обнулил source_id.
const LEAD_CARD_SELECT = `
    SELECT l.*,
           CASE
               WHEN s.id IS NULL THEN NULL
               -- ИСТОЧНИК ЛИДОВ, А НЕ КОРНЕВОЙ (25.08.2026). До правки данных
               -- номер лежал в root_source вместе со словом в скобках, и
               -- подпись была осмысленной. Теперь номер в lead_source, а в
               -- root_source у всех 916 записей одно и то же «ДОМ.РФ» —
               -- подпись стала одинаковой у всех лидов. COALESCE держит
               -- случай пустого поля: колонка nullable, обязательность
               -- проверяется маршрутом, а не базой.
               ELSE COALESCE(p.name || ' · ', '') || COALESCE(NULLIF(s.lead_source, ''), s.root_source)
           END AS source_name
    FROM leads l
    LEFT JOIN sources s ON s.id = l.source_id
    LEFT JOIN ad_platforms p ON p.id = s.platform_id
`;

// GET /api/leads?employeeId=... — список своих лидов, новые сверху
router.get('/', async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        // Слитые лиды оператору не показываются (часть 4): такой лид влит в
        // другого, работать с ним нечего, а рядом со старшим он читался бы как
        // тот же дубль, ради устранения которого слияние и делалось.
        const result = await pool.query(
            'SELECT * FROM leads WHERE employee_id = $1 AND merged_into_id IS NULL AND archived_at IS NULL'
            + ' ORDER BY created_at DESC',
            [employeeId]
        );
        res.json(result.rows.map(rowToLead));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список лидов' });
    }
});

// Поля карточки без статуса воронки: статус на сохранении проходит через
// правила звонка (services/leadCallRules.js) и пишется вместе с ними, а не как
// обычное поле формы.
const CARD_FIELD_COLUMNS = EDITABLE_FIELD_COLUMNS.filter(([key]) => key !== 'funnelStatusId');

async function fetchLeadCard(db, leadId) {
    const result = await db.query(`${LEAD_CARD_SELECT} WHERE l.id = $1`, [leadId]);
    if (!result.rows[0]) return null;
    const lead = rowToLead(result.rows[0]);
    // ПРЕДЕЛ ПОСТ-ОБРАБОТКИ ЕДЕТ ВМЕСТЕ С КАРТОЧКОЙ (часть 9, заход 5). Считает
    // его сервер: длительность задана парой «линия + скрипт», и собирать её на
    // экране значило бы завести там второй экземпляр правила. `null` — законное
    // значение: пары нет, пост-обработка не кончается сама.
    lead.wrapupSeconds = await resolveWrapupSeconds(db, {
        leadId,
        funnelStatusId: result.rows[0].funnel_status_id,
        lineType: result.rows[0].line_type
    });
    return lead;
}

// Серверное «сейчас» уходит клиенту вместе с карточкой: счётчик пост-обработки
// тикает в браузере, но считается от разницы серверных значений, а не от
// Date.now() — иначе уехавшие часы браузера соврут (dialog.md G5).
async function serverNow(db) {
    const result = await db.query('SELECT NOW() AS now');
    return result.rows[0].now;
}

// GET /api/leads/next?employeeId=... — очередь оператора: карточка, с которой он
// должен работать прямо сейчас, либо null (экран «Нет активных лидов»).
// Этот же запрос разбирает очередь под запросившего оператора — полный проход
// раздачи он не запускает (dialog.md D3): при пяти ожидающих операторах опрос
// раз в 15 секунд означал бы 20 полных проходов в минуту.
//
// Объявлен ДО '/:id' — иначе Express прочитает «next» как идентификатор лида.
router.get('/next', async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        const { leadId, reason } = await assignNextLeadForEmployee(pool, employeeId);
        const lead = leadId === null ? null : await fetchLeadCard(pool, leadId);
        res.json({ lead, reason, now: await serverNow(pool) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить следующего лида' });
    }
});

// POST /api/leads/:id/complete — «Сохранить»: сохраняет карточку, применяет
// правила статуса звонка и сразу отдаёт следующего лида. Одним запросом, а не
// парой «сохранить» + «дай следующего»: между двумя запросами лид успевает
// уйти другому оператору.
router.post('/:id/complete', async (req, res) => {
    const { employeeId, nextCallAt } = req.body || {};
    if (!employeeId) {
        return res.status(400).json({ error: 'Не передан employeeId' });
    }

    let outcome;
    try {
        outcome = await withTransaction(pool, async (client) => {
            const existing = await client.query(
                'SELECT id, employee_id, call_attempts FROM leads WHERE id = $1 FOR UPDATE',
                [req.params.id]
            );
            if (existing.rows.length === 0) {
                return { code: 404, error: 'Лид не найден' };
            }
            const lead = existing.rows[0];

            // Лид успел уйти по времени или его перехватили. Правки НЕ сохраняем
            // — он уже не этого оператора, — но следующего лида всё равно
            // отдадим, чтобы человек не залип на мёртвой карточке (dialog.md D2).
            if (String(lead.employee_id) !== String(employeeId)) {
                return { code: 409, error: 'Лид уже не закреплён за вами — введённые данные не сохранены' };
            }

            const statusId = normalizeValue('funnelStatusId', req.body.funnelStatusId);

            // Пустой статус запрещён (правка куратора при приёмке, 15.08.2026).
            // Раньше статус был обычным полем формы, и лид без него оставался
            // виден в списке оператора. Списка больше нет, а условие очереди —
            // «статус „Новый“ ИЛИ наступил перезвон»: лид с funnel_status_id =
            // NULL не подходит ни под одну ветку, не отдаётся никому и не
            // отцепляется правилом освобождения. Один клик по «— не выбран —»
            // молча терял бы лида навсегда.
            if (statusId === null) {
                return { code: 400, error: 'Выберите статус звонка — без него лид не вернётся в очередь' };
            }

            const statusFlags = await fetchStatusFlags(client, statusId);

            let callTime = null;
            if (statusFlags && statusFlags.requires_call_time) {
                callTime = nextCallAt ? new Date(nextCallAt) : null;
                if (!callTime || Number.isNaN(callTime.getTime())) {
                    return { code: 400, error: 'Для статуса «Перезвон» укажите дату и время следующего звонка' };
                }
                if (callTime.getTime() <= Date.now()) {
                    return { code: 400, error: 'Время перезвона уже прошло — выберите будущее время' };
                }
            }

            const nowRow = await client.query('SELECT NOW() AS now');
            const effects = await resolveCallStatusEffects(client, {
                currentAttempts: lead.call_attempts || 0,
                statusId,
                statusFlags,
                nextCallAt: callTime,
                now: nowRow.rows[0].now
            });

            const values = CARD_FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
            const setClauses = CARD_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
            const push = (clause, value) => {
                values.push(value);
                setClauses.push(clause.replace('$?', `$${values.length}`));
            };
            push('funnel_status_id = $?', effects.funnel_status_id);
            // ПОМЕТКА СНИМАЕТСЯ ЛЮБЫМ СОХРАНЕНИЕМ, а не «когда дописано
            // недостающее»: списка обязательных полей в проекте нет вовсе,
            // маршрут требует ровно статус, и придумать такой список сейчас
            // значило бы завести правило, которого никто не принимал, — и оно
            // немедленно начало бы отбивать сохранения на бою (ответ куратора 12).
            push('partially_filled = $?::boolean', false);
            push('opened_at = $?::timestamptz', effects.opened_at);
            push('next_call_at = $?::timestamptz', effects.next_call_at);
            // Кем назначен перезвон — вместе со временем и только вместе с ним
            // (ловушка 7 наряда, часть 9). Признак и время, записанные порознь,
            // однажды разойдутся, а миграция пересчёта интервала верит признаку.
            push('next_call_source = $?', effects.next_call_source);
            push('call_attempts = $?::int', effects.call_attempts);
            if (effects.last_call_at !== undefined) push('last_call_at = $?::timestamptz', effects.last_call_at);
            if (effects.employee_id !== undefined) push('employee_id = $?::int', effects.employee_id);

            values.push(req.params.id);
            await client.query(
                `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
                values
            );
            return { code: 200 };
        });
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указан несуществующий статус воронки' });
        }
        console.error(err);
        return res.status(500).json({ error: 'Не удалось сохранить лида' });
    }

    if (outcome.code === 404 || outcome.code === 400) {
        return res.status(outcome.code).json({ error: outcome.error });
    }

    // Следующего лида берём ОТДЕЛЬНОЙ транзакцией, уже после того как сохранение
    // зафиксировано: иначе выборка кандидата с FOR UPDATE SKIP LOCKED увидела бы
    // ещё не закоммиченного текущего лида как свободного и вернула бы его же.
    try {
        const { leadId } = await assignNextLeadForEmployee(pool, employeeId);
        const next = leadId === null ? null : await fetchLeadCard(pool, leadId);
        const now = await serverNow(pool);
        if (outcome.code === 409) {
            return res.status(409).json({ error: outcome.error, saved: false, next, now });
        }
        res.json({ saved: true, next, now });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Данные сохранены, но следующего лида получить не удалось' });
    }
});

// POST /api/leads/:id/wrapup-timeout — пост-обработка кончилась по времени.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ «Сохранить». `/complete` требует статус: без него лид не
// вернётся в очередь, и один щелчок по «— не выбран —» терял бы его навсегда.
// Здесь статуса нет и быть не может — время вышло, оператор его не поставил, — и
// требовать его значило бы не закрыть карточку вовсе.
//
// ЧТО ВСЁ-ТАКИ СОХРАНЯЕТСЯ: набранные поля карточки. Пометка «заполнена
// частично» говорит «работа сделана, просто не вся»; выбросить набранное и
// поставить эту пометку значило бы соврать — работы не осталось бы никакой.
//
// ⚠ СТАТУС И ПРАВИЛА ЗВОНКА НЕ ПРИМЕНЯЮТСЯ. Счётчик попыток не растёт, перезвон
// не назначается, оператор не отцепляется правилом статуса: ничего этого не
// произошло — разговор не закончен решением, он оборван временем.
router.post('/:id/wrapup-timeout', async (req, res) => {
    const { employeeId } = req.body || {};
    if (!employeeId) {
        return res.status(400).json({ error: 'Не передан employeeId' });
    }

    let outcome;
    try {
        outcome = await withTransaction(pool, async (client) => {
            const existing = await client.query(
                'SELECT id, employee_id FROM leads WHERE id = $1 FOR UPDATE', [req.params.id]);
            if (existing.rows.length === 0) return { code: 404, error: 'Лид не найден' };
            if (String(existing.rows[0].employee_id) !== String(employeeId)) {
                return { code: 409, error: 'Лид уже не закреплён за вами — введённые данные не сохранены' };
            }

            const values = CARD_FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
            const setClauses = CARD_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
            values.push(req.params.id);
            await client.query(
                `UPDATE leads SET ${setClauses.join(', ')},
                        opened_at = NULL, partially_filled = true, updated_at = NOW()
                  WHERE id = $${values.length}`,
                values
            );
            return { code: 200 };
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Не удалось закрыть карточку' });
    }

    if (outcome.code === 404) return res.status(404).json({ error: outcome.error });

    try {
        const { leadId } = await assignNextLeadForEmployee(pool, employeeId);
        const next = leadId === null ? null : await fetchLeadCard(pool, leadId);
        const now = await serverNow(pool);
        if (outcome.code === 409) {
            return res.status(409).json({ error: outcome.error, saved: false, next, now });
        }
        res.json({ saved: true, partiallyFilled: true, next, now });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Карточка закрыта, но следующего лида получить не удалось' });
    }
});

// GET /api/leads/:id?employeeId=... — одна карточка (только своя)
router.get('/:id', async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }
        // ПРОВЕРКА ВЛАДЕЛЬЦА — своим запросом, карточка — ОБЩИМ СБОРЩИКОМ.
        // Здесь стояла вторая сборка карточки, своя: `rowToLead` вызывался прямо
        // отсюда, минуя `fetchLeadCard`. Из-за этого предел пост-обработки,
        // добавленный в сборщик, до этого маршрута не доехал — и не выдал себя
        // ничем: поле просто отсутствовало в ответе. Копий сборки карточки
        // больше нет.
        const owner = await pool.query('SELECT employee_id FROM leads WHERE id = $1', [req.params.id]);
        if (owner.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        if (String(owner.rows[0].employee_id) !== String(employeeId)) {
            return res.status(403).json({ error: 'Этот лид назначен другому оператору' });
        }
        res.json(await fetchLeadCard(pool, req.params.id));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить лида' });
    }
});

// PUT /api/leads/:id — сохранение карточки (employeeId в теле запроса, только свой лид)
router.put('/:id', async (req, res) => {
    try {
        const { employeeId } = req.body;
        if (!employeeId) {
            return res.status(400).json({ error: 'Не передан employeeId' });
        }

        const existing = await pool.query(
            'SELECT employee_id, phone, phone_raw, phone_fix_verdict FROM leads WHERE id = $1',
            [req.params.id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'Лид не найден' });
        }
        if (String(existing.rows[0].employee_id) !== String(employeeId)) {
            return res.status(403).json({ error: 'Этот лид назначен другому оператору' });
        }

        const values = EDITABLE_FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = EDITABLE_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);

        // Приведение номера — то же самое, что в админской карточке (Б1.6):
        // оператор правит телефон прямо в карточке клиента, и его правка обязана
        // подчиняться тем же правилам. Иначе единый формат держался бы ровно до
        // первого исправления «на слух».
        const phoneIdx = EDITABLE_FIELD_COLUMNS.findIndex(([, col]) => col === 'phone');
        if (phoneIdx !== -1) {
            const phoneFix = await phoneColumnsFor(pool, req.body.phone, existing.rows[0]);
            const twin = await findLeadByPhone(pool, phoneFix.phone, Number(req.params.id));
            if (twin) {
                return res.status(409).json({
                    error: `Номер ${phoneFix.phone} уже у другого лида (№${twin.id}). ` +
                        'Сохранить нельзя — скажите руководителю, лидов объединят',
                    duplicateId: twin.id
                });
            }
            values[phoneIdx] = phoneFix.phone;
            values.push(phoneFix.phone_raw, phoneFix.phone_normalized, phoneFix.phone_fix_reason_id, phoneFix.phone_fix_verdict);
            setClauses.push(
                `phone_raw = $${values.length - 3}`,
                `phone_normalized = $${values.length - 2}`,
                `phone_fix_reason_id = $${values.length - 1}`,
                `phone_fix_verdict = $${values.length}`
            );
        }
        values.push(req.params.id);
        await pool.query(
            `UPDATE leads SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
            values
        );
        // Перечитываем тем же запросом, что и GET: RETURNING * не знает про
        // JOIN, и ответ на сохранение приходил бы без source_name — форма
        // обновляет по нему шапку и «Последнее сохранение».
        const result = await pool.query(`${LEAD_CARD_SELECT} WHERE l.id = $1`, [req.params.id]);
        res.json(rowToLead(result.rows[0]));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(400).json({ error: 'Указан несуществующий статус воронки' });
        }
        // Дубль номера, проскочивший мимо предварительной проверки (К176): окно
        // между findLeadByPhone и UPDATE открыто, и без этой ветки оператор
        // получил бы 500 вместо объяснения.
        if (err.code === '23505' && err.constraint === 'idx_leads_phone_unique') {
            return res.status(409).json({
                error: 'Этот номер уже у другого лида. Сохранить нельзя — скажите руководителю, лидов объединят'
            });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить лида' });
    }
});

module.exports = router;
