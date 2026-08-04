// --- server.js: точка входа Express-приложения ---

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { runMigrations } = require('./migrate');
const employeesRouter = require('./routes/employees');
const documentsRouter = require('./routes/documents');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.use('/api/employees', employeesRouter);
app.use('/api', documentsRouter);

// Отдаём страницу "Сотрудники" тем же сервером — отдельный статический хостинг фронтенда не нужен.
const employeesDir = path.join(__dirname, '../Employees');
app.use(express.static(employeesDir));
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
