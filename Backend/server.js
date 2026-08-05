// --- server.js: точка входа Express-приложения ---

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { runMigrations } = require('./migrate');
const employeesRouter = require('./routes/employees');
const documentsRouter = require('./routes/documents');
const authRouter = require('./routes/auth');
const columnSettingsRouter = require('./routes/columnSettings');
const operatorAuthRouter = require('./routes/operatorAuth');
const leadsRouter = require('./routes/leads');
const leadFunnelStatusesRouter = require('./routes/leadFunnelStatuses');
const scriptsRouter = require('./routes/scripts');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.use('/api/employees', employeesRouter);
app.use('/api', documentsRouter);
app.use('/api/auth', authRouter);
app.use('/api', columnSettingsRouter);
app.use('/api/auth', operatorAuthRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/lead-funnel-statuses', leadFunnelStatusesRouter);
app.use('/api/scripts', scriptsRouter);

// Отдаём страницы "Сотрудники" и "Оператор" тем же сервером — отдельный статический
// хостинг фронтенда не нужен. Обе папки лежат внутри Backend/ (а не рядом), т.к. Railway
// собирает только содержимое Root Directory. Файлы внутри Operator/ названы с префиксом
// operator*, чтобы не пересекаться по имени с одноимённой структурой Employees/ — оба
// каталога монтируются в корень "/".
const employeesDir = path.join(__dirname, 'Employees');
const operatorDir = path.join(__dirname, 'Operator');
app.use(express.static(employeesDir));
app.use(express.static(operatorDir));
app.get('/', (req, res) => {
    res.redirect('/emploees.html');
});

app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

const PORT = process.env.PORT || 3000;

runMigrations()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`API запущен на порту ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Не удалось накатить схему БД при старте:', err);
        process.exit(1);
    });
