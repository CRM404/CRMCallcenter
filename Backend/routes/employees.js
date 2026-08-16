// --- routes/employees.js: CRUD для сотрудников ---

const express = require('express');
const { pool } = require('../db');
const { distributePendingLeads } = require('../services/leadDistribution');
const {
    SELECTABLE_STATES, isValidState, setWorkState, getWorkState, clearReleasedLeadNotice
} = require('../services/operatorState');
const {
    isBlank, parseWorkDays, parseTimeOfDay, parseShiftTimes, DAYS_FORMAT_ERROR
} = require('../services/scheduleFormat');

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
    return null;
}

function handleUniqueViolation(err, res) {
    if (err.code === '23505') {
        if (err.constraint === 'employees_email_key') {
            return res.status(409).json({ error: 'Сотрудник с таким email уже существует' });
        }
        if (err.constraint === 'employees_phone_key') {
            return res.status(409).json({ error: 'Сотрудник с таким номером телефона уже существует' });
        }
        return res.status(409).json({ error: 'Такая запись уже существует' });
    }
    return null;
}

// GET /api/employees — список с фильтрами
router.get('/', async (req, res) => {
    try {
        const { search, status, department, position, hasWhatsapp, hasTelegram, hireDateFrom, hireDateTo } = req.query;

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
        if (department) {
            params.push(department);
            conditions.push(`e.department = $${params.length}`);
        }
        if (position) {
            params.push(position);
            conditions.push(`e.position = $${params.length}`);
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
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO employees (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
            values
        );
        const row = await fetchEmployeeWithManager(result.rows[0].id);
        res.status(201).json(rowToEmployee(row));
    } catch (err) {
        if (handleUniqueViolation(err, res)) return;
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
        const values = FIELD_COLUMNS.map(([key]) => normalizeValue(key, req.body[key]));
        const setClauses = FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE employees SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING id`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        const row = await fetchEmployeeWithManager(result.rows[0].id);
        res.json(rowToEmployee(row));
    } catch (err) {
        if (handleUniqueViolation(err, res)) return;
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
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
router.put('/:id/work-state', async (req, res) => {
    try {
        const { state } = req.body || {};
        if (!isValidState(state)) {
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

// DELETE /api/employees/:id
router.delete('/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM employees WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить сотрудника' });
    }
});

module.exports = router;
