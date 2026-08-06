// --- routes/organization.js: раздел "Реквизиты" (организация + банковские счета + налоги) ---
// GET отдаёт организацию одним запросом с вложенными bankAccounts/taxes (тот же
// паттерн, что routes/scripts.js для узлов скрипта). Фронт на этой итерации
// работает ровно с одной записью организации, но эндпоинты технически не
// запрещают несколько (см. dialog.md, п.1 брифа) — POST не блокирует создание
// второй записи, это просто не покрыто фронтом сейчас.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

const ORG_FIELD_COLUMNS = [
    ['name', 'name'],
    ['legalForm', 'legal_form'],
    ['inn', 'inn'],
    ['kpp', 'kpp'],
    ['ogrn', 'ogrn'],
    ['okved', 'okved'],
    ['authorizedCapital', 'authorized_capital'],
    ['registrationCountry', 'registration_country'],
    ['generalDirector', 'general_director'],
    ['registrationDate', 'registration_date'],
    ['legalAddress', 'legal_address']
];

const BANK_ACCOUNT_FIELD_COLUMNS = [
    ['bankName', 'bank_name'],
    ['checkingAccount', 'checking_account'],
    ['correspondentAccount', 'correspondent_account'],
    ['bik', 'bik'],
    ['currency', 'currency'],
    ['openedAt', 'opened_at']
];

const TAX_FIELD_COLUMNS = [
    ['taxType', 'tax_type'],
    ['rate', 'rate'],
    ['periodicity', 'periodicity']
];

function normalizeValue(value) {
    if (value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

function rowToOrganization(row) {
    return {
        id: row.id,
        name: row.name,
        legalForm: row.legal_form,
        inn: row.inn,
        kpp: row.kpp,
        ogrn: row.ogrn,
        okved: row.okved,
        authorizedCapital: row.authorized_capital,
        registrationCountry: row.registration_country,
        generalDirector: row.general_director,
        registrationDate: row.registration_date,
        legalAddress: row.legal_address
    };
}

function rowToBankAccount(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        bankName: row.bank_name,
        checkingAccount: row.checking_account,
        correspondentAccount: row.correspondent_account,
        bik: row.bik,
        currency: row.currency,
        openedAt: row.opened_at
    };
}

function rowToTax(row) {
    return {
        id: row.id,
        organizationId: row.organization_id,
        taxType: row.tax_type,
        rate: row.rate,
        periodicity: row.periodicity
    };
}

function validateRequired(body, field, label) {
    if (!body[field] || String(body[field]).trim() === '') {
        return `Заполните обязательное поле: ${label}`;
    }
    return null;
}

// Валидация по типу данных (dialog.md, п.7) — источник истины, дублирует
// mainValidation.js на фронте (можно постучаться в API напрямую, мимо формы,
// то же соображение, что для санитайзера rich-text в прошлой задаче). Поля
// остаются опциональными — формат проверяется только когда значение непустое.
function validateDigits(value, exactLengths, label) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const str = String(value);
    if (!exactLengths.some((len) => new RegExp(`^\\d{${len}}$`).test(str))) {
        const lengths = exactLengths.join(' или ');
        return `${label} должен содержать ${lengths} цифр`;
    }
    return null;
}

function validateAuthorizedCapital(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        return 'Уставный капитал должен быть неотрицательным числом';
    }
    return null;
}

function validateOrganizationFormats(body) {
    return validateDigits(body.inn, [10, 12], 'ИНН')
        || validateDigits(body.kpp, [9], 'КПП')
        || validateDigits(body.ogrn, [13, 15], 'ОГРН')
        || validateAuthorizedCapital(body.authorizedCapital);
}

// GET /api/organization — первая организация с вложенными bankAccounts/taxes,
// либо null (телом ответа), если ни одной ещё не создано — это ожидаемое
// состояние "ещё не заполнено", не ошибка.
router.get('/', async (req, res) => {
    try {
        const orgResult = await pool.query('SELECT * FROM organizations ORDER BY id LIMIT 1');
        if (orgResult.rows.length === 0) {
            return res.json(null);
        }
        const org = orgResult.rows[0];

        const [bankAccountsResult, taxesResult] = await Promise.all([
            pool.query('SELECT * FROM organization_bank_accounts WHERE organization_id = $1 ORDER BY id', [org.id]),
            pool.query('SELECT * FROM organization_taxes WHERE organization_id = $1 ORDER BY id', [org.id])
        ]);

        res.json({
            ...rowToOrganization(org),
            bankAccounts: bankAccountsResult.rows.map(rowToBankAccount),
            taxes: taxesResult.rows.map(rowToTax)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить данные организации' });
    }
});

// POST /api/organization — создание
router.post('/', async (req, res) => {
    const validationError = validateRequired(req.body, 'name', 'Название') || validateOrganizationFormats(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = ORG_FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]));
        const columns = ORG_FIELD_COLUMNS.map(([, col]) => col);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO organizations (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
            values
        );
        res.status(201).json({ ...rowToOrganization(result.rows[0]), bankAccounts: [], taxes: [] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать организацию' });
    }
});

// PUT /api/organization/:id — полная замена полей организации (без вложенных
// счетов/налогов) — тот же паттерн, что PUT /api/employees/:id: фронт всегда
// шлёт все текущие значения формы, непереданное поле становится NULL.
router.put('/:id', async (req, res) => {
    const validationError = validateRequired(req.body, 'name', 'Название') || validateOrganizationFormats(req.body);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = ORG_FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]));
        const setClauses = ORG_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id);
        const result = await pool.query(
            `UPDATE organizations SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Организация не найдена' });
        }
        res.json(rowToOrganization(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// POST /api/organization/:id/bank-accounts
router.post('/:id/bank-accounts', async (req, res) => {
    const validationError = validateRequired(req.body, 'bankName', 'Название банка') || validateDigits(req.body.bik, [9], 'БИК');
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = [req.params.id, ...BANK_ACCOUNT_FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]))];
        const columns = ['organization_id', ...BANK_ACCOUNT_FIELD_COLUMNS.map(([, col]) => col)];
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO organization_bank_accounts (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
            values
        );
        res.status(201).json(rowToBankAccount(result.rows[0]));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(404).json({ error: 'Организация не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать банковский счёт' });
    }
});

// PUT /api/organization/:id/bank-accounts/:accountId
router.put('/:id/bank-accounts/:accountId', async (req, res) => {
    const validationError = validateRequired(req.body, 'bankName', 'Название банка') || validateDigits(req.body.bik, [9], 'БИК');
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = BANK_ACCOUNT_FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]));
        const setClauses = BANK_ACCOUNT_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id, req.params.accountId);
        const result = await pool.query(
            `UPDATE organization_bank_accounts SET ${setClauses.join(', ')}
             WHERE organization_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Банковский счёт не найден' });
        }
        res.json(rowToBankAccount(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// DELETE /api/organization/:id/bank-accounts/:accountId
router.delete('/:id/bank-accounts/:accountId', async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM organization_bank_accounts WHERE organization_id = $1 AND id = $2 RETURNING id',
            [req.params.id, req.params.accountId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Банковский счёт не найден' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить банковский счёт' });
    }
});

// POST /api/organization/:id/taxes
router.post('/:id/taxes', async (req, res) => {
    const validationError = validateRequired(req.body, 'taxType', 'Вид налога');
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = [req.params.id, ...TAX_FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]))];
        const columns = ['organization_id', ...TAX_FIELD_COLUMNS.map(([, col]) => col)];
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const result = await pool.query(
            `INSERT INTO organization_taxes (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
            values
        );
        res.status(201).json(rowToTax(result.rows[0]));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(404).json({ error: 'Организация не найдена' });
        }
        console.error(err);
        res.status(500).json({ error: 'Не удалось создать налоговую запись' });
    }
});

// PUT /api/organization/:id/taxes/:taxId
router.put('/:id/taxes/:taxId', async (req, res) => {
    const validationError = validateRequired(req.body, 'taxType', 'Вид налога');
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    try {
        const values = TAX_FIELD_COLUMNS.map(([key]) => normalizeValue(req.body[key]));
        const setClauses = TAX_FIELD_COLUMNS.map(([, col], i) => `${col} = $${i + 1}`);
        values.push(req.params.id, req.params.taxId);
        const result = await pool.query(
            `UPDATE organization_taxes SET ${setClauses.join(', ')}
             WHERE organization_id = $${values.length - 1} AND id = $${values.length} RETURNING *`,
            values
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Налоговая запись не найдена' });
        }
        res.json(rowToTax(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить изменения' });
    }
});

// DELETE /api/organization/:id/taxes/:taxId
router.delete('/:id/taxes/:taxId', async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM organization_taxes WHERE organization_id = $1 AND id = $2 RETURNING id',
            [req.params.id, req.params.taxId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Налоговая запись не найдена' });
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось удалить налоговую запись' });
    }
});

module.exports = router;
