// --- server.js: точка входа Express-приложения ---

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { runMigrations } = require('./migrate');
const { pool } = require('./db');
const { checkStatusFlagsConfigured } = require('./services/leadCallRules');
const employeesRouter = require('./routes/employees');
const documentsRouter = require('./routes/documents');
const authRouter = require('./routes/auth');
const columnSettingsRouter = require('./routes/columnSettings');
const operatorAuthRouter = require('./routes/operatorAuth');
const leadsRouter = require('./routes/leads');
const leadFunnelStatusesRouter = require('./routes/leadFunnelStatuses');
const scriptsRouter = require('./routes/scripts');
const scriptsAdminRouter = require('./routes/scriptsAdmin');
const organizationRouter = require('./routes/organization');
const cpaNetworksRouter = require('./routes/cpaNetworks');
const departmentsRouter = require('./routes/departments');
const realEstateOffersRouter = require('./routes/realEstateOffers');
const adPlatformsRouter = require('./routes/adPlatforms');
const paramListsRouter = require('./routes/paramLists');
const geoSuggestRouter = require('./routes/geoSuggest');
const sourcesRouter = require('./routes/sources');
const leadsAdminRouter = require('./routes/leadsAdmin');
const scheduleRouter = require('./routes/schedule');

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
app.use('/api/admin', scriptsAdminRouter);
app.use('/api/organization', organizationRouter);
app.use('/api/cpa-networks', cpaNetworksRouter);
app.use('/api/departments', departmentsRouter);
app.use('/api/real-estate-offers', realEstateOffersRouter);
app.use('/api/ad-platforms', adPlatformsRouter);
app.use('/api/param-lists', paramListsRouter);
app.use('/api/geo-suggest', geoSuggestRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/leads-admin', leadsAdminRouter);
app.use('/api/schedule', scheduleRouter);

// Отдаём страницы "Сотрудники", "Оператор", "Скрипт (админ)", "Главная",
// "CPA-сети", "Источники" и "Лиды" тем же сервером — отдельный статический
// хостинг фронтенда не нужен. Все папки лежат внутри Backend/ (а не рядом),
// т.к. Railway собирает только содержимое Root Directory. Файлы внутри
// Operator/, ScriptsAdmin/, Main/, CpaNetworks/, Sources/ и Leads/ названы
// с префиксом operator*/scriptsAdmin*/main*/cpa*/sources*/leads*, чтобы не
// пересекаться по имени с одноимённой структурой Employees/ — все семь
// каталогов монтируются в корень "/".
// Shell/ — общая оболочка и слой элементов (задача «единая оболочка CRM»).
// Смонтирована ПЕРВОЙ намеренно: со временем в ней появится index.html, и
// именно она должна отвечать на корневые пути, а не одна из шести папок
// разделов. Пути /ui/…, /shell/…, /api.js, /ui-catalog.html, /index.html
// проверены на уникальность относительно остальных семи папок — коллизия
// статики не даёт ошибки, она молча отдаёт чужой файл.
// ВНИМАНИЕ на этап 1: как только появится Shell/index.html, express.static
// начнёт отдавать его на «/» раньше, чем сработает app.get('/') ниже, и
// редирект на /main.html умрёт сам собой. Это нужное поведение, но оно должно
// быть снято сознательно, а не обнаружено постфактум.
// Редиректы со старых адресов на маршруты внутри оболочки. Добавляются ПО
// ОДНОМУ на каждом этапе переноса и обязательно ДО express.static — иначе
// статика отдаст старый файл страницы раньше, чем сработает редирект.
//
// Закладки, которые владелец уже раздал, продолжают работать.
//
// /operator.html и /operator-login.html редиректу не подлежат никогда:
// страница оператора в задачу не входит и остаётся отдельной.
app.get('/main.html', (req, res) => res.redirect(301, '/#/requisites'));
app.get('/sources.html', (req, res) => res.redirect(301, '/#/sources'));
app.get('/scripts-admin.html', (req, res) => res.redirect(301, '/#/scripts'));

const shellDir = path.join(__dirname, 'Shell');
const employeesDir = path.join(__dirname, 'Employees');
const operatorDir = path.join(__dirname, 'Operator');
const scriptsAdminDir = path.join(__dirname, 'ScriptsAdmin');
const mainDir = path.join(__dirname, 'Main');
const cpaNetworksDir = path.join(__dirname, 'CpaNetworks');
const sourcesDir = path.join(__dirname, 'Sources');
const leadsDir = path.join(__dirname, 'Leads');
app.use(express.static(shellDir));
app.use(express.static(employeesDir));
app.use(express.static(operatorDir));
app.use(express.static(scriptsAdminDir));
app.use(express.static(mainDir));
app.use(express.static(cpaNetworksDir));
app.use(express.static(sourcesDir));
app.use(express.static(leadsDir));
// Редиректа с «/» на /main.html больше нет: с этапа 1 корень отдаёт
// Shell/index.html — единую точку входа. Строка не удалена «заодно», она
// перестала работать в тот момент, когда появился Shell/index.html:
// express.static отвечает на «/» раньше, чем доходит до app.get('/'), и
// оставленный редирект врал бы читателю кода. Старые адреса разделов
// (/main.html, /leads.html, …) продолжают работать до своего этапа переноса,
// редиректы на них добавляются по одному (бриф, 3.1).

app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

const PORT = process.env.PORT || 3000;

// Флаги поведения статусов (auto_recall / requires_call_time) проставляются
// миграцией ПО НАЗВАНИЮ статуса. Если на бою хоть одно название отличается
// пробелом, флаг молча не встанет и автоперезвон не заработает — без единой
// ошибки в логе. Поэтому проверка при старте: она не мешает серверу подняться,
// но оставляет запись, по которой поломку видно сразу (dialog.md A1).
runMigrations()
    .then(() => checkStatusFlagsConfigured(pool).catch((err) => {
        console.error('Не удалось проверить флаги статусов воронки:', err);
    }))
    .then(() => {
        app.listen(PORT, () => {
            console.log(`API запущен на порту ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Не удалось накатить схему БД при старте:', err);
        process.exit(1);
    });
