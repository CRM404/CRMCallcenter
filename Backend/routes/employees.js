// --- routes/employees.js: CRUD для сотрудников ---

const express = require('express');
const { pool } = require('../db');
const { distributePendingLeads } = require('../services/leadDistribution');
const {
    SELECTABLE_STATES, isRequestableState, setWorkState, getWorkState, clearReleasedLeadNotice
} = require('../services/operatorState');
const {
    isBlank, parseWorkDays, parseTimeOfDay, parseShiftTimes, DAYS_FORMAT_ERROR
} = require('../services/scheduleFormat');
const tunnelKeys = require('../services/tunnelKeys');
const archive = require('../services/employeeArchive');
const auditContext = require('../services/auditContext');

const router = express.Router();

const REQUIRED_FIELDS = ['lastName', 'firstName', 'email', 'phone'];

// Линия сотрудника — фиксированный список (тот же, что у лида). Валидация
// только на уровне API, без DB CHECK — как у ad_platforms.status.
const LINE_TYPES = ['Входящая', 'Исходящая'];

// Порядок должен совпадать со списком колонок в INSERT/UPDATE ниже.
const FIELD_COLUMNS = [
    ['lastName', 'last_name'],
    ['firstName', 'first_name'],
    ['middleName', 'middle_name'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['whatsapp', 'whatsapp'],
    ['telegram', 'telegram'],
    ['position', 'position'],
    ['department', 'department'],
    ['managerId', 'manager_id'],
    ['hireDate', 'hire_date'],
    ['status', 'status'],
    ['terminationDate', 'termination_date'],
    ['lineType', 'line_type'],
    ['workSchedule', 'work_schedule'],
    // Блок «График работы»: work_schedule переиспользован под «Дни», время смены
    // приезжает двумя ключами (в форме это одно поле, разбирается на клиенте).
    // ВНИМАНИЕ: любое поле здесь обязано быть и в rowToEmployee ниже —
    // massActions.js отправляет обратно ВЕСЬ объект из rowToEmployee, а PUT
    // перезаписывает все колонки из этого списка. Забытое поле = молчаливое
    // обнуление при массовом переводе в неактивные (dialog.md, Ф2).
    ['shiftStart', 'shift_start'],
    ['shiftEnd', 'shift_end'],
    ['password', 'password'],
    ['pbxExtension', 'pbx_extension'],
    ['country', 'country'],
    ['registration', 'registration'],
    ['passportSeries', 'passport_series'],
    ['passportNumber', 'passport_number'],
    ['issuedBy', 'issued_by'],
    ['issueDate', 'issue_date'],
    ['inn', 'inn'],
    ['bank', 'bank'],
    ['account', 'account']
];

// КОЛОНКИ, КОТОРЫХ В СПИСКЕ ВЫШЕ БЫТЬ НЕ МОЖЕТ, И ЭТО ГЛАВНОЕ В ЧАСТИ 2.
//
// ПРАВИЛО: колонка, для которой нет поля в форме, не имеет права стоять в
// FIELD_COLUMNS. PUT собирает SET по всему списку, а normalizeValue на
// отсутствующий ключ возвращает null (см. ниже) — то есть колонка, которую
// форма не шлёт, ОБНУЛЯЕТСЯ при каждом сохранении карточки.
//
// Таких колонки две, и обе — телефония:
//
//   pbx_password     — наружу не уходит вовсе (rowToEmployee), значит форма и
//       не может его вернуть. Первое же массовое «сменить статус» стёрло бы
//       пароли всем операторам разом, молча.
//   pbx_extension_id — поля в карточке нет и не будет: паспорт Р4 говорит
//       «человеку не показывается». Сегодня колонка пуста и вреда нет, но
//       заполнится она на этапе Е, и это идентификатор, которым делаются
//       обращения вида /extension/{id}/record/{uuid}/storage_url/. Первое же
//       сохранение карточки стёрло бы его, записи разговоров перестали бы
//       доставаться, а искать стали бы в телефонии (находка куратора, 24.08).
//
// Обе обновляются отдельно и только когда ключ РЕАЛЬНО пришёл:
// COALESCE($n, колонка), где $n = null, если ключа нет. Различаем «не
// прислали» и «прислали пустое» по наличию ключа, а не по значению — очистить
// значение руками должно быть можно.
// Третьим стоит признак «обрезать пробелы по краям». У служебного
// идентификатора они мусор, у ПАРОЛЯ — часть значения: формат пароля задаёт
// оператор связи, и срезать у него крайний пробел значит молча испортить вход.
const GUARDED_COLUMNS = [
    ['pbxPassword', 'pbx_password', false],
    ['pbxExtensionId', 'pbx_extension_id', true]
];

function guardedArg(body, key, trim) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, key)) {
        return { sent: false, value: null };
    }
    const raw = body[key];
    // Пустое значение — это очистка руками, а не «не прислали». Пробельная
    // строка считается пустой в обоих случаях: как пароль она бессмысленна.
    if (raw === null || raw === undefined || String(raw).trim() === '') {
        return { sent: true, value: null };
    }
    return { sent: true, value: trim ? String(raw).trim() : String(raw) };
}

function rowToEmployee(row) {
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        email: row.email,
        phone: row.phone,
        whatsapp: row.whatsapp,
        telegram: row.telegram,
        position: row.position,
        department: row.department,
        managerId: row.manager_id,
        managerName: row.manager_name || null,
        hireDate: row.hire_date,
        status: row.status,
        // Архив (часть 5). Две пометки вместо одной «Неактивен»: решение
        // владельца 70. status при этом прежний — на нём висят освобождение
        // добавочного и отзыв ключа туннеля.
        archiveKind: row.archive_kind,
        frozenAt: row.frozen_at,
        terminationDate: row.termination_date,
        lineType: row.line_type,
        workSchedule: row.work_schedule,
        // TIME приезжает из pg как '21:00:00' — секунд в интерфейсе нет нигде,
        // подрезаем здесь, а не в трёх местах фронта.
        shiftStart: parseTimeOfDay(row.shift_start),
        shiftEnd: parseTimeOfDay(row.shift_end),
        onLine: row.on_line,
        onLineSince: row.on_line_since,
        workState: row.work_state,
        password: row.password,
        pbxExtension: row.pbx_extension,
        pbxExtensionId: row.pbx_extension_id,
        // ЗНАЧЕНИЯ ПАРОЛЯ АТС ЗДЕСЬ НЕТ И НЕ БУДЕТ — только признак «задан».
        // Прятать пароль интерфейсом нельзя: он остался бы в исходном коде
        // страницы, и «скрытое» открыл бы любой, кто нажал F12 (паспорт Р4,
        // состояние «скрыт навсегда»). Значение приходит единственной точкой
        // GET /api/employees/:id/pbx-password.
        pbxPasswordSet: Boolean(row.pbx_password),
        // КЛЮЧ ТУННЕЛЯ (часть 1Б). Наружу уходят адрес, даты и кто выдал —
        // по ним человека находят в списке допущенных на сервере. Самих
        // ключей на экране не бывает никогда: открытый человеку ничего не
        // говорит, закрытого у нас нет вовсе.
        //
        // tunnelKeyIssued — «ключ выдан и не отозван». Отдельным признаком, а
        // не сравнением дат на клиенте: правило одно, и живёт оно здесь.
        tunnelAddress: row.tunnel_address,
        // ОТКРЫТЫЙ КЛЮЧ УХОДИТ НАРУЖУ, и это не оплошность. Секрет — закрытая
        // половина, а открытая лежит и в настройке у оператора, и в конфиге
        // сервера. Показывать её надо: впуск в [Peer] делается руками, и тому,
        // кто его делает, нужны ровно две вещи — адрес и открытый ключ. Без
        // ключа выданный ключ некому довести до рабочего состояния, не заходя
        // в базу запросом (находка куратора, паспорт Р1Б редакции 3).
        tunnelPublicKey: row.tunnel_public_key,
        tunnelIssuedAt: row.tunnel_issued_at,
        // Подписи дат считает СЕРВЕР и сразу по Москве. На клиенте это
        // означало бы разбор строки без пояса и показ в поясе браузера:
        // руководитель в Ташкенте увидел бы у пилюли соседний день.
        tunnelIssuedAtLabel: row.tunnel_issued_at ? tunnelKeys.formatDate(row.tunnel_issued_at) : null,
        // Даты две, потому что событий два: ссылку выдали и ключ родился. Между
        // ними проходят часы, и карточка про них говорит разное.
        tunnelKeyAt: row.tunnel_key_at,
        tunnelKeyAtLabel: row.tunnel_key_at ? tunnelKeys.formatDate(row.tunnel_key_at) : null,
        tunnelRevokedAt: row.tunnel_revoked_at,
        tunnelRevokedAtLabel: row.tunnel_revoked_at ? tunnelKeys.formatDate(row.tunnel_revoked_at) : null,
        // «Ссылка выдана и не отозвана». Есть ли уже сама пара — отдельный
        // вопрос, на него отвечает tunnelPublicKey.
        tunnelKeyIssued: Boolean(row.tunnel_address) && !row.tunnel_revoked_at,
        country: row.country,
        registration: row.registration,
        passportSeries: row.passport_series,
        passportNumber: row.passport_number,
        issuedBy: row.issued_by,
        issueDate: row.issue_date,
        inn: row.inn,
        bank: row.bank,
        account: row.account
    };
}

function normalizeValue(key, value) {
    if (key === 'managerId') {
        return value === '' || value === undefined || value === null ? null : Number(value);
    }
    if (key === 'status') {
        return value === undefined || value === null || String(value).trim() === '' ? 'active' : value;
    }
    // Формат этих трёх проверен в validateRequiredFields, здесь только приводим
    // к каноническому виду ('5 / 2' -> '5/2', '9:00' -> '09:00'), чтобы в базе
    // не копились варианты записи одного и того же.
    if (key === 'workSchedule') {
        return parseWorkDays(value);
    }
    if (key === 'shiftStart' || key === 'shiftEnd') {
        return parseTimeOfDay(value);
    }
    // Добавочный приводим к каноническому виду: пробел по краям сделал бы «102»
    // и «102 » разными номерами, и частичный уникальный индекс пропустил бы оба.
    if (key === 'pbxExtension' || key === 'pbxExtensionId') {
        if (value === undefined || value === null) return null;
        const trimmed = String(value).trim();
        return trimmed === '' ? null : trimmed;
    }
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

// Общий SELECT с LEFT JOIN на руководителя — используется и для GET, и как источник
// ответа для POST/PUT (INSERT/UPDATE ... RETURNING * не знает про manager_name).
async function fetchEmployeeWithManager(id) {
    const result = await pool.query(
        `SELECT e.*, CASE WHEN m.id IS NOT NULL THEN m.last_name || ' ' || m.first_name ELSE NULL END AS manager_name
         FROM employees e
         LEFT JOIN employees m ON e.manager_id = m.id
         WHERE e.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

function validateRequiredFields(body) {
    const missing = REQUIRED_FIELDS.filter(f => !body[f] || String(body[f]).trim() === '');
    if (missing.length > 0) {
        return `Заполните обязательные поля: ${missing.join(', ')}`;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
        return 'Введите корректный email';
    }
    // «Тип линии» стал фиксированным списком (решение владельца п.9): в форме
    // это select, но эндпоинт может получить запрос и в обход UI. Пустое
    // значение допустимо — линия у сотрудника необязательна.
    if (body.lineType !== undefined && body.lineType !== null && String(body.lineType).trim() !== ''
        && !LINE_TYPES.includes(body.lineType)) {
        return `Тип линии должен быть одним из: ${LINE_TYPES.join(', ')}`;
    }
    // Блок «График работы». Оба поля необязательные, но заполненное непонятно —
    // не сохраняем: проверка есть и в форме, и здесь, потому что этот эндпоинт
    // доступен в обход формы. Тексты ошибок дословные из макета.
    if (!isBlank(body.workSchedule) && !parseWorkDays(body.workSchedule)) {
        return DAYS_FORMAT_ERROR;
    }
    const shiftTimes = parseShiftTimes(body.shiftStart, body.shiftEnd);
    if (shiftTimes.error) {
        return shiftTimes.error;
    }
    // Добавочный: только цифры, длина не ограничивается (у разных станций она
    // разная). Пустое значение допустимо — звонит не каждый сотрудник.
    if (!isBlank(body.pbxExtension) && !/^\d+$/.test(String(body.pbxExtension).trim())) {
        return 'Внутренний номер состоит только из цифр';
    }
    return null;
}

// Фамилия и инициалы: «Иванов И. И.». Нужны в одном месте — в тексте про
// занятый добавочный, поэтому живут здесь, а не в общем помощнике.
// Фамилия с инициалами живёт в services/employeeArchive.js: она нужна и там —
// отказ при возврате называет, У КОГО теперь добавочный, — а две копии одного
// форматирования расходятся в первый же день правки.
const { shortName } = archive;

// АСИНХРОННАЯ намеренно: ошибка занятого добавочного обязана называть, У КОГО
// номер («Номер 102 уже у Иванова И. И.»), а это второй запрос. «Номер занят»
// заставило бы искать руками по всем карточкам (паспорт Р4).
//
// Проверять занятость заранее нельзя: между SELECT и INSERT успевает вклиниться
// чужая вставка. Полагаемся на индекс, а имя ищем уже после отказа.
async function handleUniqueViolation(err, res, body) {
    if (err.code === '23505') {
        if (err.constraint === 'employees_email_key') {
            return res.status(409).json({ error: 'Сотрудник с таким email уже существует' });
        }
        if (err.constraint === 'employees_phone_key') {
            return res.status(409).json({ error: 'Сотрудник с таким номером телефона уже существует' });
        }
        if (err.constraint === 'idx_employees_pbx_extension') {
            const extension = String((body && body.pbxExtension) || '').trim();
            let owner = null;
            try {
                const found = await pool.query(
                    `SELECT id, last_name, first_name, middle_name FROM employees
                     WHERE pbx_extension = $1 AND status <> 'inactive' LIMIT 1`,
                    [extension]
                );
                owner = found.rows[0] || null;
            } catch (lookupErr) {
                // Само по себе отсутствие имени отказ не отменяет: сохранять
                // всё равно нельзя, просто текст будет беднее.
                console.error(lookupErr);
            }
            return res.status(409).json({
                error: owner
                    ? `Номер ${extension} уже у ${shortName(owner)}`
                    : `Номер ${extension} уже занят`,
                code: 'extension_taken',
                employee: owner ? { id: owner.id, fio: shortName(owner) } : null
            });
        }
        return res.status(409).json({ error: 'Такая запись уже существует' });
    }
    return null;
}

// GET /api/employees — список с фильтрами
router.get('/', async (req, res) => {
    try {
        const { search, status, archiveKind, department, position, lineType,
            hasWhatsapp, hasTelegram, hireDateFrom, hireDateTo } = req.query;

        const conditions = [];
        const params = [];

        if (search && search.trim()) {
            params.push(`%${search.trim().toLowerCase()}%`);
            const idx = params.length;
            conditions.push(`(
                LOWER(e.last_name) LIKE $${idx} OR
                LOWER(e.first_name) LIKE $${idx} OR
                LOWER(e.email) LIKE $${idx} OR
                e.phone LIKE $${idx} OR
                LOWER(e.position) LIKE $${idx} OR
                LOWER(e.department) LIKE $${idx} OR
                CAST(e.id AS TEXT) LIKE $${idx}
            )`);
        }
        if (status) {
            params.push(status);
            conditions.push(`e.status = $${params.length}`);
        }
        // ВИД АРХИВА — ОТДЕЛЬНЫЙ ОТБОР, А НЕ ЧАСТЬ status (И112). «Уволенных
        // нет» и «Замороженных нет» — разные пустые состояния, и различить их
        // можно только настоящим отбором; клиентский тут не годится.
        //
        // СВОДИТЬ ЭТИ ДВА УСЛОВИЯ В ОДНО НЕЛЬЗЯ, и схема предупреждает об этом
        // отдельным абзацем: status держит освобождение добавочного и отзыв
        // ключа туннеля, archive_kind — только слово в карточке. Отбор
        // «Активные» — это status = 'active', а НЕ archive_kind IS NULL.
        if (archiveKind) {
            params.push(archiveKind);
            conditions.push(`e.archive_kind = $${params.length}`);
        }
        if (department) {
            params.push(department);
            conditions.push(`e.department = $${params.length}`);
        }
        if (position) {
            params.push(position);
            conditions.push(`e.position = $${params.length}`);
        }
        // Линия — фильтр тулбара раздела (часть 2). Считается сервером, как и
        // остальные: список сотрудников грузится целиком, но фильтровать его на
        // клиенте значило бы держать два разных набора правил на один экран.
        if (lineType) {
            params.push(lineType);
            conditions.push(`e.line_type = $${params.length}`);
        }
        if (hasWhatsapp === 'true') {
            conditions.push(`e.whatsapp IS NOT NULL AND e.whatsapp <> ''`);
        }
        if (hasTelegram === 'true') {
            conditions.push(`e.telegram IS NOT NULL AND e.telegram <> ''`);
        }
        if (hireDateFrom) {
            params.push(hireDateFrom);
            conditions.push(`e.hire_date >= $${params.length}`);
        }
        if (hireDateTo) {
            params.push(hireDateTo);
            conditions.push(`e.hire_date <= $${params.length}`);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await pool.query(
            `SELECT e.*, CASE WHEN m.id IS NOT NULL THEN m.last_name || ' ' || m.first_name ELSE NULL END AS manager_name
             FROM employees e
             LEFT JOIN employees m ON e.manager_id = m.id
             ${whereClause}
             ORDER BY e.id`,
            params
        );
        res.json(result.rows.map(rowToEmployee));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список сотрудников' });
    }
});

// GET /api/employees/list-for-manager — для выпадающего списка "Руководитель"
router.get('/list-for-manager', async (req, res) => {
    try {
        const excludeId = req.query.excludeId ? Number(req.query.excludeId) : null;
        const params = [];
        let whereClause = `WHERE status = 'active'`;
        if (excludeId) {
            params.push(excludeId);
            whereClause += ` AND id <> $${params.length}`;
        }
        const result = await pool.query(
            `SELECT id, last_name, first_name FROM employees ${whereClause} ORDER BY last_name, first_name`,
            params
        );
        res.json(result.rows.map(r => ({ id: r.id, fullName: `${r.last_name} ${r.first_name}` })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить список руководителей' });
    }
});

// GET /api/employees/archive-preview?ids=1,2,3 — последствия ВЫВОДА ПАЧКОЙ.
//
// ЗАРЕГИСТРИРОВАН ВЫШЕ `/:id` НАМЕРЕННО: иначе тот съест слово
// «archive-preview» как идентификатор и вернёт 404. В этом же файле такой
// образец уже есть — `/list-for-manager` стоит выше по той же причине.
//
// Числа — одним снимком на всех выбранных; почему не N запросов, объяснено в
// services/employeeArchive.js.
router.get('/archive-preview', async (req, res) => {
    try {
        const ids = String(req.query.ids || '')
            .split(',')
            .map((x) => Number(String(x).trim()))
            .filter((x) => Number.isInteger(x) && x > 0);
        if (ids.length === 0) {
            return res.status(400).json({ error: 'Не передан список сотрудников' });
        }
        res.json(await archive.bulkArchivePreview(pool, ids));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось собрать сведения о выводе из работы' });
    }
});

// GET /api/employees/:id
router.get('/:id', async (req, res) => {
    try {
        const row = await fetchEmployeeWithManager(req.params.id);
        if (!row) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        res.json(rowToEmployee(row));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить сотрудника' });
    }
});

// POST /api/employees — создание
router.post('/', async (req, res) => {
    const validationError = validateRequiredFields(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const columns = FIELD_COLUMNS.map(([, col]) => col);
        // Охраняемые колонки — только если прислали. При создании разница
        // невелика, но правило одно на оба маршрута: колонка трогается лишь по
        // запросу.
        GUARDED_COLUMNS.forEach(([key, col, trim]) => {
            const arg = guardedArg(req.body, key, trim);
            if (!arg.sent) return;
            columns.push(col);
            values.push(arg.value);
        });
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO employees (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const row = await fetchEmployeeWithManager(result.rows[0].id);
        res.status(201).json(rowToEmployee(row));
    } catch (err) {
        if (await handleUniqueViolation(err, res, req.body)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать сотрудника' });
    }
});

// PUT /api/employees/:id — редактирование
router.put('/:id', async (req, res) => {
    const validationError = validateRequiredFields(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        // СОСТОЯНИЕ ДО ПРАВКИ. Нужно, чтобы отличить переход от повторного
        // сохранения: «ушёл в архив» и «архивную карточку сохранили ещё раз» —
        // разные события, и лиды открепляются только в первом.
        const before = await pool.query(
            'SELECT status, archive_kind, frozen_at FROM employees WHERE id = $1', [req.params.id]);
        if (before.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        const wasArchived = before.rows[0].status === 'inactive';
        const willBeArchived = normalizeValue('status', req.body.status) === 'inactive';

        // ВОЗВРАТ ИЗ АРХИВА — ТОЛЬКО С ДОБАВОЧНЫМ (решение владельца 71).
        // Старый номер освободился в момент ухода и мог уйти другому, поэтому
        // вернуть человека, не выдав номер, нельзя.
        //
        // ПРАВИЛО УЗКОЕ И РАСШИРЯТЬ ЕГО НЕЛЬЗЯ: оно про ВОЗВРАТ, а не про
        // сотрудника вообще. Сотрудник без добавочного существовать по-прежнему
        // может и должен — первыми туннель понадобился разработчикам в
        // Кыргызстане, добавочного у них нет вовсе, и выдача ключа это
        // учитывает (services/tunnelKeys.js). Глухое NOT NULL на pbx_extension
        // сломало бы им доступ молча, поэтому проверка стоит здесь, а не в базе.
        if (wasArchived && !willBeArchived) {
            const extension = String(req.body.pbxExtension || '').trim();
            if (!extension) {
                const taken = await archive.takenExtensions(pool);
                return res.status(400).json({
                    error: 'Вернуть в работу без внутреннего номера нельзя — прежний мог уйти другому',
                    code: 'extension_required',
                    extensionsTaken: taken
                });
            }
        }

        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        // Ключа нет — приходит null, и COALESCE оставляет прежнее значение.
        // Ключ есть с пустым значением — приходит null, но ветка другая:
        // колонка выставляется в NULL напрямую, то есть значение стёрто руками.
        GUARDED_COLUMNS.forEach(([key, col, trim]) => {
            const arg = guardedArg(req.body, key, trim);
            values.push(arg.value);
            setClauses.push(arg.sent
                ? `${col} = $${values.length}`
                : `${col} = COALESCE($${values.length}, ${col})`);
        });
        // ОТЗЫВ КЛЮЧА ТУННЕЛЯ ПРИ УХОДЕ В АРХИВ. Одно действие сотрудника —
        // два следствия, ровно как с добавочным: уволенный не должен сохранять
        // вход в сеть, а его адрес обязан освободиться (правило Ж7).
        //
        // COALESCE, а не NOW() напрямую: повторное сохранение уже архивной
        // карточки не должно сдвигать дату отзыва — в карточке она показана.
        // Обратного действия нет намеренно: возврат из архива ключ НЕ
        // воскрешает, его выдают заново (паспорт Р1Б, состояние 5).
        //
        // Колонки туннеля не стоят и не могут стоять в FIELD_COLUMNS: форма их
        // не шлёт, а PUT перезаписывает весь список — первое же массовое
        // «перевести в неактивные» стёрло бы выданные ключи всем разом, молча.
        // Это та же мина, что у pbx_password и pbx_extension_id выше.
        values.push(normalizeValue('status', req.body.status));
        setClauses.push(`tunnel_revoked_at = CASE WHEN $${values.length} = 'inactive'`
            + ' AND tunnel_address IS NOT NULL THEN COALESCE(tunnel_revoked_at, NOW())'
            + ' ELSE tunnel_revoked_at END');

        // ВИД АРХИВА И ДАТА ЗАМОРОЗКИ. Считаются здесь, а не в FIELD_COLUMNS, и
        // это не придирка к месту: PUT переписывает ВЕСЬ список FIELD_COLUMNS, а
        // normalizeValue на отсутствующий ключ отдаёт null. Стоял бы archive_kind
        // там — первое же сохранение карточки старым интерфейсом стёрло бы вид
        // архива всем, кого он касается, молча. Та же мина, что у pbx_password и
        // pbx_extension_id (см. GUARDED_COLUMNS выше).
        const archiveSet = archive.archiveColumns(
            willBeArchived, archive.normalizeArchiveKind(req.body.archiveKind), before.rows[0]);
        for (const [col, val] of Object.entries(archiveSet)) {
            values.push(val);
            setClauses.push(`${col} = $${values.length}`);
        }

        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE employees SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id, status, tunnel_revoked_at`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        // Живая ссылка на выдачу у архивного сотрудника — это дверь, которую
        // забыли закрыть: открыть её сможет всякий, у кого она осталась.
        if (result.rows[0].status === 'inactive') {
            await pool.query(
                `UPDATE tunnel_key_tokens SET revoked_at = NOW()
                 WHERE employee_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
                [result.rows[0].id]
            );
        }
        // ЛИДЫ ОТКРЕПЛЯЮТСЯ СРАЗУ (решение владельца 72), а не через полтора
        // суток, как это происходит с лидами ушедшего домой оператора.
        //
        // Только на ПЕРЕХОДЕ в архив: повторное сохранение архивной карточки
        // ничего не откреплять не должно, иначе безобидная правка фамилии
        // уволенного разгоняла бы очередь.
        let detached = 0;
        if (!wasArchived && result.rows[0].status === 'inactive') {
            detached = (await archive.detachLeads(pool, result.rows[0].id)).detached;
        }
        const row = await fetchEmployeeWithManager(result.rows[0].id);
        res.json(Object.assign(rowToEmployee(row), detached > 0 ? { detachedLeads: detached } : {}));
    } catch (err) {
        if (await handleUniqueViolation(err, res, req.body)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// GET /api/employees/:id/archive-preview — числа ДО действия.
//
// Паспорт Р7 требует их от сервера, потому что экран не считает ничего сам: он
// показывает то, что вернули. Здесь и три числа очереди, и владелец прежнего
// добавочного с датой выдачи, и список занятых номеров для подсказки поля.
//
// Запрос НИЧЕГО НЕ МЕНЯЕТ — в отличие от двух других GET проекта
// (/api/leads/next и /api/employees/:id/work-state), которые пишут в базу.
router.get('/:id/archive-preview', async (req, res) => {
    try {
        const preview = await archive.archivePreview(pool, req.params.id);
        if (!preview) return res.status(404).json({ error: 'Сотрудник не найден' });
        res.json(preview);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось собрать сведения о выводе из работы' });
    }
});

// POST /api/employees/bulk-archive { employeeIds, archiveKind } — «Вывести из
// работы» пачкой.
//
// Кнопки ещё нет (экран — отдельная часть, решение владельца 76), но серверная
// половина делается сейчас (ответ куратора И90): иначе экран упрётся в её
// отсутствие. ОДНОЙ ПАРТИЕЙ — одно нажатие обязано читаться как одно действие.
//
// Возврата пачкой НЕТ и быть не может: каждому возвращаемому нужен свой
// добавочный (решение владельца 71), а списка номеров в запросе пачки нет.
router.post('/bulk-archive', async (req, res) => {
    const raw = (req.body && req.body.employeeIds) || [];
    const ids = Array.isArray(raw)
        ? raw.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
        : [];
    if (!Array.isArray(raw)) return res.status(400).json({ error: 'Некорректный список сотрудников' });
    if (ids.length === 0) return res.status(400).json({ error: 'Выберите хотя бы одного сотрудника' });

    const kind = archive.normalizeArchiveKind(req.body && req.body.archiveKind) || 'dismissed';

    try {
        const pending = await pool.query(
            "SELECT id FROM employees WHERE id = ANY($1::int[]) AND status <> 'inactive'", [ids]);
        if (pending.rows.length === 0) {
            return res.json({ archived: 0, skipped: ids.length, detachedLeads: 0 });
        }
        const targets = pending.rows.map((r) => r.id);

        const done = await auditContext.runAsBatch(
            pool, { kind: 'archive', title: 'Вывод сотрудников из работы', actorName: 'Вывод из работы' },
            async () => {
                const updated = await pool.query(
                    `UPDATE employees
                        SET status = 'inactive',
                            -- Приведение типа обязательно: один и тот же $2
                            -- стоит и в присваивании, и в сравнении, а без
                            -- касты Postgres выводит для него два разных типа
                            -- и отказывается разбирать запрос.
                            archive_kind = $2::varchar,
                            frozen_at = CASE WHEN $2::varchar = 'frozen'
                                             THEN COALESCE(frozen_at, CURRENT_DATE) ELSE NULL END,
                            tunnel_revoked_at = CASE WHEN tunnel_address IS NOT NULL
                                                     THEN COALESCE(tunnel_revoked_at, NOW())
                                                     ELSE tunnel_revoked_at END
                      WHERE id = ANY($1::int[]) RETURNING id`,
                    [targets, kind]);
                // Живая ссылка на выдачу у архивного — дверь, которую забыли
                // закрыть. То же, что делает одиночный PUT.
                await pool.query(
                    `UPDATE tunnel_key_tokens SET revoked_at = NOW()
                      WHERE employee_id = ANY($1::int[]) AND used_at IS NULL AND revoked_at IS NULL`,
                    [targets]);
                // Лиды — той же партией: одно нажатие, одно действие.
                const leads = await pool.query(
                    `UPDATE leads SET employee_id = NULL, opened_at = NULL, updated_at = NOW()
                      WHERE employee_id = ANY($1::int[]) RETURNING id`, [targets]);
                return { archived: updated.rows.length, detachedLeads: leads.rows.length };
            });

        res.json({
            archived: done.archived,
            skipped: ids.length - done.archived,
            detachedLeads: done.detachedLeads
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось вывести сотрудников из работы' });
    }
});

// GET /api/employees/:id/pbx-password — ЕДИНСТВЕННОЕ место, где пароль АТС
// покидает сервер. Карточка запрашивает его только по нажатию «показать».
//
// ПОЧЕМУ ОТДЕЛЬНОЙ ТОЧКОЙ, А НЕ ПОЛЕМ В ОТВЕТЕ. Пароль АТС — это деньги: кто
// его знает, тот регистрирует телефон и звонит за счёт компании. В списке
// сотрудников он ехал бы наружу пачкой, при каждом открытии раздела и вообще
// без спроса. Здесь же он уходит по одному, по явному запросу, и в тот день,
// когда в проекте появится вход, права навешиваются ОДНОЙ проверкой в ОДНОМ
// месте, а не ревизией всех ответов.
//
// ЧАСТЬ 3 (аудит): эта точка обязана писать запись «пароль АТС показан» — с
// автором и временем. Аудит вообще про изменения, но здесь единственное место
// во всей системе, где секрет покидает сервер, и молчать об этом нельзя
// (требование куратора, dialog.md И15). Пометка оставлена здесь, чтобы в
// части 3 это место не искать.
router.get('/:id/pbx-password', async (req, res) => {
    try {
        const result = await pool.query('SELECT pbx_password FROM employees WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        res.json({ pbxPassword: result.rows[0].pbx_password || '' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить пароль АТС' });
    }
});

// POST /api/employees/:id/tunnel-key — выдать ключ туннеля и вернуть
// одноразовую ссылку. Единственный раз, когда ссылка существует в ответе;
// ни в карточке, ни в списке её потом нет.
//
// ЧТО ЗДЕСЬ НА САМОМ ДЕЛЕ ПРОИСХОДИТ. Пары ключей здесь НЕ создаётся: она
// родится в момент открытия ссылки, потому что закрытый ключ не сохраняется
// нигде и держать его часами между выдачей и открытием негде (см. шапку
// services/tunnelKeys.js). Здесь назначается адрес в подсети, гасятся прежние
// ссылки этого сотрудника и заводится новая.
//
// ПОЧЕМУ ВЫДАЧА ПО НАЖАТИЮ, А НЕ САМА ПРИ СОХРАНЕНИИ КАРТОЧКИ. Не каждый
// заведённый сотрудник — оператор за границей. Автоматическая выдача означала
// бы, что пропуск в сеть получает и бухгалтерия, и любой заведённый по ошибке,
// а каждый лишний ключ — лишняя дверь, которую надо помнить и закрывать при
// увольнении (бриф, часть 1Б).
//
// ЧАСТЬ 3 (аудит): эта точка обязана писать запись «выдан ключ туннеля» — с
// автором, временем и адресом; открытие ссылки пишет вторую, «настройка
// забрана». Это второе место во всей системе, где секрет покидает сервер
// (первое — показ пароля АТС выше). Пометка оставлена здесь, чтобы в части 3
// её не искать.
router.post('/:id/tunnel-key', async (req, res) => {
    const read = tunnelKeys.readSettings();
    if (read.error) {
        // 503, а не 500: сервер жив, не хватает настройки. Текст уходит в
        // плашку на месте блока со ссылкой — не тостом: тост исчезнет, а
        // разбираться надо здесь (паспорт Р1Б).
        // Текст дословно из ответа куратора (zakaz_maketov.md, ответ 5 по Р1Б):
        // он называет, ЧТО ДЕЛАТЬ, а не только что случилось. Человек у карточки
        // эту поломку сам не починит, и единственное полезное действие — сказать
        // тому, кто настраивал сервер. Подробность про конкретные переменные
        // уходит в журнал сервера, а не на экран: у карточки другой читатель.
        console.error('Ключ туннеля не выдан:', read.error);
        return res.status(503).json({
            error: 'Настройки туннеля не заданы или недоступны. Ключ выдать нельзя, пока они не появятся. Сообщите тому, кто настраивал сервер.',
            code: 'tunnel_not_configured'
        });
    }
    const settings = read.settings;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query(
            'SELECT id, last_name, first_name, middle_name, status, pbx_extension, tunnel_address, tunnel_revoked_at FROM employees WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );
        if (found.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        const employee = found.rows[0];
        if (employee.status === 'inactive') {
            await client.query('ROLLBACK');
            // Кнопка в карточке архивного сотрудника и так неактивна, но
            // эндпоинт открыт в обход формы, а ключ уволенному — это ровно та
            // дверь, которую Ж7 закрывает.
            return res.status(409).json({
                error: 'Сотрудник в архиве: ключ туннеля ему не выдаётся',
                code: 'employee_inactive'
            });
        }

        // Адрес: у кого он уже есть и не отозван — остаётся прежним. Перевыпуск
        // меняет ПАРУ, а не место в подсети: адрес не секрет, а по нему человека
        // находят в списке допущенных, и менять его без нужды значит заставлять
        // руководителя искать заново.
        let address = employee.tunnel_address && !employee.tunnel_revoked_at ? employee.tunnel_address : null;
        if (!address) {
            const taken = await client.query(
                'SELECT tunnel_address FROM employees WHERE tunnel_address IS NOT NULL AND tunnel_revoked_at IS NULL'
            );
            const picked = tunnelKeys.pickFreeAddress(settings.subnet, taken.rows.map((r) => r.tunnel_address));
            if (picked.error) {
                await client.query('ROLLBACK');
                console.error('Ключ туннеля не выдан:', picked.error);
                // Тоже дословно (zakaz_maketov.md, ответ 5 по Р1Б).
                return res.status(409).json({
                    error: 'В подсети туннеля закончились свободные адреса. Сообщите тому, кто настраивал сервер: нужно расширить подсеть или освободить адреса отозванных ключей.',
                    code: 'no_free_address'
                });
            }
            address = picked.address;
        }

        // Прежние ссылки гаснут, не дожидаясь срока: «прежний ключ перестанет
        // работать сразу» — это обещание окна подтверждения, и оно должно быть
        // правдой, а не надеждой на срок.
        await client.query(
            `UPDATE tunnel_key_tokens SET revoked_at = NOW()
             WHERE employee_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
            [employee.id]
        );

        // employees.tunnel_issued_by и tunnel_key_tokens.created_by ЗАВЕДЕНЫ, НО НЕ
        // ЗАПОЛНЯЮТСЯ, и это надо знать вслух. Входа в проекте нет, автора не
        // существует, а имя, которое никто не проверял, хуже честного «не
        // указан». Колонки оставлены готовым местом: их займёт часть 3, когда
        // появится, кому писать. Соединение с ними наружу не выведено намеренно
        // — запрос, способный вернуть только NULL, стоит в договоре API как
        // обещание (находка куратора, 24.08.2026).
        const token = tunnelKeys.generateToken();
        const expiresAt = new Date(Date.now() + settings.ttlHours * 3600 * 1000);
        await client.query(
            `INSERT INTO tunnel_key_tokens (employee_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
            [employee.id, tunnelKeys.hashToken(token), expiresAt]
        );

        // tunnel_public_key обнуляется намеренно: прежняя пара отозвана, а
        // новой ещё нет — она родится при открытии ссылки. Оставленный старый
        // ключ означал бы, что в списке допущенных надо держать мёртвое.
        const saved = await client.query(
            `UPDATE employees
                SET tunnel_address = $1, tunnel_issued_at = NOW(), tunnel_revoked_at = NULL,
                    tunnel_public_key = NULL, tunnel_key_at = NULL
              WHERE id = $2
              RETURNING tunnel_issued_at`,
            [address, employee.id]
        );
        await client.query('COMMIT');

        res.status(201).json({
            // Путь, а не полный адрес: собственного имени сервер не знает —
            // за nginx он видит внутренний адрес, а карточка открыта ровно по
            // тому адресу, который надо отдать человеку. Полную ссылку
            // собирает клиент из своего location.origin.
            linkPath: `/k/${token}`,
            expiresAt,
            expiresLabel: tunnelKeys.formatMoscow(expiresAt).full,
            address,
            issuedAt: saved.rows[0].tunnel_issued_at,
            issuedAtLabel: tunnelKeys.formatDate(saved.rows[0].tunnel_issued_at),
            fileName: tunnelKeys.configFileName(employee)
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // Единственный ожидаемый конфликт — гонка за адрес: два руководителя
        // выдали ключ одновременно, и индекс отбил второго. Просить повторить
        // честнее, чем молча брать следующий адрес: второй выбор мог бы уехать
        // в занятый уже третьим.
        if (err.code === '23505' && err.constraint === 'idx_employees_tunnel_address') {
            return res.status(409).json({
                error: 'Адрес в подсети только что занял другой ключ. Нажмите «Выдать ключ» ещё раз',
                code: 'address_race'
            });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось выдать ключ туннеля' });
    } finally {
        client.release();
    }
});

// GET /api/employees/:id/work-state — текущее состояние оператора, момент его
// начала, серверное «сейчас» и суммы по состояниям за календарные сутки.
// Разовую отметку «лид, который был за вами, вернулся в общую очередь» отдаём
// один раз и сразу снимаем.
router.get('/:id/work-state', async (req, res) => {
    try {
        const state = await getWorkState(pool, req.params.id);
        if (!state) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        if (state.releasedLeadNotice) {
            await clearReleasedLeadNotice(pool, req.params.id);
        }
        res.json({ ...state, states: SELECTABLE_STATES });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить состояние оператора' });
    }
});

// PUT /api/employees/:id/work-state { state } — смена состояния. Заменяет собой
// прежний переключатель «на линии» (да/нет). При выходе на линию сразу пробует
// разобрать очередь зависших лидов (services/leadDistribution).
//
// СИСТЕМНЫЕ СОСТОЯНИЯ ЧЕРЕЗ ЭТОТ АДРЕС НЕ СТАВЯТСЯ (К195). Сюда приходит
// нажатие человека, а «разговор» и «пост-обработка» ставит станция. Отсутствие
// кнопки останавливает того, кто пользуется панелью, и не останавливает больше
// никого — адрес открыт. Проверка при этом не по списку кнопок: выход из
// системы идёт сюда же и шлёт `off`, которого среди кнопок нет.
router.put('/:id/work-state', async (req, res) => {
    try {
        const { state } = req.body || {};
        if (!isRequestableState(state)) {
            return res.status(400).json({ error: 'Недопустимое состояние оператора' });
        }
        const updated = await setWorkState(pool, req.params.id, state);
        if (!updated) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        if (state === 'on_line') {
            await distributePendingLeads(pool);
        }
        const fresh = await getWorkState(pool, req.params.id);
        res.json({ ...fresh, states: SELECTABLE_STATES });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сменить состояние' });
    }
});

// PUT /api/employees/:id/on-line { onLine } — прежний переключатель «На линии».
// Оставлен как совместимость (решение куратора, dialog.md C4) и реализован
// ЧЕРЕЗ новый эндпоинт: писать в on_line/on_line_since вправе только смена
// состояния, второго источника правды нет. Потребителей в интерфейсе у него
// больше не осталось — страница оператора работает через work-state.
router.put('/:id/on-line', async (req, res) => {
    try {
        const { onLine } = req.body;
        if (typeof onLine !== 'boolean') {
            return res.status(400).json({ error: 'Не передан onLine' });
        }
        const updated = await setWorkState(pool, req.params.id, onLine ? 'on_line' : 'off');
        if (!updated) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        if (onLine) {
            await distributePendingLeads(pool);
        }
        res.json({ id: Number(req.params.id), onLine });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось обновить статус "на линии"' });
    }
});

// DELETE /api/employees/:id — СОТРУДНИКОВ НЕ УДАЛЯЮТ. Никогда.
//
// План 11.2: как только появятся журнал звонков и журнал аудита, удаление
// сотрудника оставит в них записи, ссылающиеся в пустоту — «звонил оператор
// №14», а кто это был, уже не узнать. Журнал аудита в бою с части 3, значит
// довод из будущего стал доводом из настоящего.
//
// МАРШРУТ ОСТАВЛЕН, А НЕ УБРАН (ответ куратора И82). Убрать его значило
// ответить старому интерфейсу 404 — «такой ручки нет», — и человек решил бы,
// что сломалось. Отказ обязан объяснять, что делать вместо: вывести из работы.
//
// 405, а не 409: помехи здесь ни при чём и считать нечего, сам способ действия
// к этой сущности неприменим. Структуры помех поэтому тоже нет — окно отказа с
// пустым списком выглядело бы поломкой.
router.delete('/:id', async (req, res) => {
    try {
        const found = await pool.query('SELECT id, status FROM employees WHERE id = $1', [req.params.id]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        res.status(405).json({
            error: 'Сотрудников не удаляют — выведите из работы: «Уволен» или «Заморожен». '
                 + 'Данные останутся на месте, а добавочный и ключ туннеля освободятся.',
            code: 'employee_delete_forbidden'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось обработать запрос' });
    }
});

module.exports = router;
