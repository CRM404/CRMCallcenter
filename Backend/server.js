// --- server.js: точка входа Express-приложения ---

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { runMigrations } = require('./migrate');
const auditContext = require('./services/auditContext');
const { pool } = require('./db');
const { checkAutoRecallConfigured } = require('./services/leadCallRules');
const { runPhoneNormalization } = require('./services/phoneMigration');
const { runRecallRecalc } = require('./services/recallMigration');
const scheduler = require('./services/scheduler');
const eventChannel = require('./services/eventChannel');
const pbxClient = require('./services/pbxClient');
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
const tunnelPageRouter = require('./routes/tunnelPage');
const pbxEventsRouter = require('./routes/pbxEvents');
const callsRouter = require('./routes/calls');
const auditRouter = require('./routes/audit');
const callEventsRouter = require('./routes/callEvents');
const settingsRouter = require('./routes/settings');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ЧТЕНИЕ ФОРМАТА ВЕБХУКОВ (часть 6, В1). Телфин шлёт события в
// `application/x-www-form-urlencoded` — и при GET, и при POST. До этой строки
// сервер умел только JSON, и тела событий приходили бы ПУСТЫМИ И БЕЗ ОШИБКИ:
// приложение отвечало бы «принято», записывало пустой звонок и не жаловалось.
// Ловить такое потом мучительно (план 7.6).
//
// `extended: false` — вложенности в событиях станции нет, поля плоские.
// Свой лимит, а не общие десять мегабайт: событие станции не бывает большим, а
// десять мегабайт на открытом наружу адресе — это приглашение.
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// ПРИЁМ СОБЫТИЙ ОТ АТС СТОИТ ДО КОНТЕКСТА АУДИТА (ответ куратора И130).
// Событие станции — не правка записи человеком: автора у него нет и взяться ему
// неоткуда, а подписка контекста на каждый такой запрос вешала бы на журнал
// работу, у которой нет ни автора, ни страницы.
//
// Адрес не под /api намеренно: его прописывают на стороне станции, и он к
// нашему API отношения не имеет — как и страница выдачи ключа туннеля ниже.
app.use('/ext-event', pbxEventsRouter);

// ЖИВОЙ КАНАЛ СЕРВЕР → БРАУЗЕР (часть 6, В3). Не под /api и ДО контекста аудита
// по той же причине, что и приёмник событий, только сильнее: подписка живёт
// часами, и контекст аудита провисел бы ровно столько же на запросе, который
// ничего не меняет (ответ куратора И136).
//
// Потребителя в браузере пока нет — вкладка «Активные» приходит частью 7.
// Разбор канала и его границ — в шапке services/eventChannel.js.
app.get('/events', (req, res) => eventChannel.subscribe(req, res));

// КОНТЕКСТ АУДИТА СТАВИТСЯ ДО ВСЕХ МАРШРУТОВ и охватывает запрос целиком —
// включая то, что маршрут делает после await. Стоит на каждом запросе, а не
// только на изменяющем: отличить чтение от записи по глаголу нельзя, у нас
// `GET /api/leads/next` и `GET /api/employees/:id/work-state` пишут в базу.
app.use(auditContext.middleware(pool));

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
app.use('/api/calls', callsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/call-events', callEventsRouter);
app.use('/api/settings', settingsRouter);

// СТРАНИЦА ВЫДАЧИ НАСТРОЙКИ ТУННЕЛЯ — не под /api: её открывает человек в
// браузере, и она отдаёт разметку, а не JSON. Стоит ДО express.static по той
// же причине, что и редиректы ниже: статика ответила бы раньше, если бы в
// какой-нибудь из восьми папок однажды завёлся каталог k/.
//
// Адрес короткий намеренно: ссылку иногда придётся диктовать голосом.
app.use('/k', tunnelPageRouter);

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
// Код 302, а не 301: миграция ещё идёт, и откат раздела возможен. Постоянный
// редирект браузеры кэшируют надолго — откатив раздел, мы не смогли бы
// вернуть людей на старую страницу, пока они не почистят кэш вручную.
// На 301 переведём в конце задачи, если это вообще понадобится.
//
// Решение владельца 19.08.2026: все шесть — 302. В половине исполнителя стояло
// 301; на бой оно не выкатывалось, поэтому ни один браузер его не закэшировал.
app.get('/main.html', (req, res) => res.redirect(302, '/#/requisites'));
app.get('/emploees.html', (req, res) => res.redirect(302, '/#/employees'));
app.get('/leads.html', (req, res) => res.redirect(302, '/#/leads'));
app.get('/sources.html', (req, res) => res.redirect(302, '/#/sources'));
app.get('/cpa-networks.html', (req, res) => res.redirect(302, '/#/cpa'));
app.get('/scripts-admin.html', (req, res) => res.redirect(302, '/#/scripts'));

const shellDir = path.join(__dirname, 'Shell');
const employeesDir = path.join(__dirname, 'Employees');
const operatorDir = path.join(__dirname, 'Operator');
const scriptsAdminDir = path.join(__dirname, 'ScriptsAdmin');
const mainDir = path.join(__dirname, 'Main');
const cpaNetworksDir = path.join(__dirname, 'CpaNetworks');
const sourcesDir = path.join(__dirname, 'Sources');
const leadsDir = path.join(__dirname, 'Leads');
const callsDir = path.join(__dirname, 'Calls');
const historyDir = path.join(__dirname, 'History');
const settingsDir = path.join(__dirname, 'Settings');
app.use(express.static(shellDir));
app.use(express.static(employeesDir));
app.use(express.static(operatorDir));
app.use(express.static(scriptsAdminDir));
app.use(express.static(mainDir));
app.use(express.static(cpaNetworksDir));
app.use(express.static(sourcesDir));
app.use(express.static(leadsDir));
app.use(express.static(callsDir));
app.use(express.static(historyDir));
app.use(express.static(settingsDir));
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

// Сторож при старте: он не мешает серверу подняться, но оставляет в логе
// запись, по которой поломку видно сразу (dialog.md A1).
//
// СМОТРИТ НА СОБЫТИЕ, А НЕ НА ФЛАГ (часть 9, заход 2). Список статусов для
// обзвона задаёт руководитель на вкладке «Звонки → События», и погасить обзвон
// целиком стало легче, чем было: достаточно снять галочку. Причины называются
// порознь — события нет, выключено, без окна, без строк, — потому что чинятся
// они в разных местах.
//
// Половина про `requires_call_time` снята заходом 4 вместе с тем, что делало
// её осмысленной: признак ставит владелец в окне статуса, и «ровно у одного»
// перестало быть утверждением о правильности.
runMigrations()
    .then(() => checkAutoRecallConfigured(pool).catch((err) => {
        console.error('Не удалось проверить настройку автоперезвона:', err);
    }))
    // Приведение номеров к единому формату (часть 4, Б1.2). Идёт ПОСЛЕ схемы, а
    // не внутри неё: правила приведения обязаны быть в проекте одни, и живут они
    // в services/phoneFormat.js — разбор в шапке services/phoneMigration.js.
    // Свой замок (applied_migrations) там же, поэтому прогон разовый, а попытка
    // включить уникальность номера повторяется при каждом старте.
    .then(() => runPhoneNormalization(pool).catch((err) => {
        console.error('Не удалось привести номера к единому формату:', err);
    }))
    // Засев признака перезвона и пересчёт назначенных перезвонов (часть 9,
    // заход 7; засев — К240). Здесь же и по той же причине, что приведение
    // номеров: правило времени живёт в `services/appTime.js`, и вторым разом на
    // plpgsql его не пишут. Замка два, по одному на проход, и порядок
    // обязателен: пересчёт читает то, что записал засев. Если событие
    // «Автоперезвон» ещё не настроено, замок ПЕРЕСЧЁТА не ставится — он
    // дождётся настройки, а не отметится выполненным над пустотой; засев от
    // настройки не зависит и проходит в любом случае.
    .then(() => runRecallRecalc(pool).catch((err) => {
        console.error('Не удалось пересчитать назначенные перезвоны:', err);
    }))
    .then(() => {
        const server = app.listen(PORT, () => {
            console.log(`API запущен на порту ${PORT}`);
        });

        // РАБОТА ПО РАСПИСАНИЮ (часть 6, В2). Стартует ПОСЛЕ накатки схемы: его
        // первая же задача — раздача, а она читает статусы воронки, которых на
        // пустой базе до миграций ещё нет.
        //
        // По умолчанию выключен, включается переменной SCHEDULER_ENABLED —
        // разбор в шапке services/scheduler.js.
        scheduler.start(pool);

        // СВЕРКА С АТС ПРИ СТАРТЕ (этап Е0, план 7.2). Идёт ПОСЛЕ подъёма
        // слушателя и НЕ ожидается: станция может отвечать секунды, а порт
        // обязан открыться сразу. Своих исключений наружу не выпускает — вся
        // обработка внутри, старт от недоступной АТС не падает.
        pbxClient.checkAtStart(pool);

        // Сердцебиение канала — СВОИМ таймером (ответ куратора И139):
        // планировщик по умолчанию выключен, а канал обязан жить и без него.
        eventChannel.start();

        // ОСТАНОВКА ПО СИГНАЛУ. Служба перезапускается выкаткой
        // (/usr/local/bin/crm-deploy.sh), systemd шлёт SIGTERM. Без этого
        // обработчика тик оборвался бы посередине раздачи (ответ куратора И134).
        //
        // SIGINT здесь по той же причине: на стенде сервер останавливают
        // Ctrl+C, и вести себя при этом иначе, чем на бою, он не должен.
        const shutdown = async (signal) => {
            console.log(`Получен ${signal}: останавливаюсь`);
            await scheduler.stop();
            eventChannel.stop();
            server.close(() => process.exit(0));
        };
        process.on('SIGTERM', () => { shutdown('SIGTERM'); });
        process.on('SIGINT', () => { shutdown('SIGINT'); });
    })
    .catch(err => {
        console.error('Не удалось накатить схему БД при старте:', err);
        process.exit(1);
    });
