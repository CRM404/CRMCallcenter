-- Схема БД для раздела "Сотрудники" (employees + employee_documents).
-- Прогоняется автоматически при старте сервера (см. migrate.js) — этот файл
-- держится в репозитории как читаемая документация схемы, синхронизированная
-- с migrate.js вручную.

CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    last_name VARCHAR NOT NULL,
    first_name VARCHAR NOT NULL,
    middle_name VARCHAR,
    email VARCHAR NOT NULL UNIQUE,
    phone VARCHAR NOT NULL UNIQUE,
    whatsapp VARCHAR,
    telegram VARCHAR,
    position VARCHAR,
    department VARCHAR,
    manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    hire_date DATE,
    status VARCHAR NOT NULL DEFAULT 'active',
    password VARCHAR,
    country VARCHAR,
    registration VARCHAR,
    passport_series VARCHAR,
    passport_number VARCHAR,
    issued_by VARCHAR,
    issue_date DATE,
    inn VARCHAR,
    bank VARCHAR,
    account VARCHAR
);

CREATE TABLE IF NOT EXISTS employee_documents (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    document_type VARCHAR NOT NULL,
    file_name VARCHAR,
    file_data TEXT,
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, document_type)
);

-- Персональные настройки видимых колонок таблицы списка сотрудников.
-- hidden_columns — чёрный список: ключи СКРЫТЫХ колонок. Любой ключ, которого
-- нет в массиве (включая колонки, добавленные в будущем), считается видимым —
-- это и есть дефолт "по умолчанию видно всё", без отдельной логики на будущее.
CREATE TABLE IF NOT EXISTS employee_column_settings (
    employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    hidden_columns JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Схема для страницы оператора — только структура (без UI/роутов).
-- Оператор = запись в employees, отдельной сущности нет.
-- ============================================================

-- Скрипты звонков: дерево узлов с ветвлением на возражения клиента.
-- Один скрипт может использоваться сразу несколькими операторами; у одного
-- оператора в моменте — ровно один скрипт (см. employees.script_id ниже).
CREATE TABLE IF NOT EXISTS scripts (
    id SERIAL PRIMARY KEY,
    title VARCHAR NOT NULL
);

-- Минимальная заглушка "оффера" (объект/ЖК недвижимости) — только для связи
-- 1 оффер : много скриптов. НЕ полная структура из database.drawio (Офферы_недвижимость
-- со всеми полями) — та плановая структура появится отдельной будущей задачей.
CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    name VARCHAR NOT NULL
);

-- status/offer_id добавлены отдельно (не в исходном CREATE TABLE). status теперь
-- значит не "показывается всем операторам", а "готов к назначению" — draft
-- нельзя назначить оператору (см. routes/scriptsAdmin.js), но видимость
-- оператору целиком определяется employees.script_id, не статусом. ADD COLUMN
-- IF NOT EXISTS — та же идемпотентность, что и весь этот файл (migrate.js
-- прогоняет schema.sql при каждом старте сервера).
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS status VARCHAR NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active'));
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL;

-- Назначение скрипта оператору — простая ссылка на employees (не таблица-связка):
-- у сотрудника ровно один script_id, а на один scripts.id может ссылаться много
-- сотрудников — этого достаточно для "1 скрипт : много операторов".
ALTER TABLE employees ADD COLUMN IF NOT EXISTS script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS script_nodes (
    id SERIAL PRIMARY KEY,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES script_nodes(id) ON DELETE CASCADE,
    node_type VARCHAR NOT NULL DEFAULT 'statement' CHECK (node_type IN ('statement', 'objection')), -- 'statement' (реплика оператора) | 'objection' (ветка на возражение клиента)
    label VARCHAR,       -- короткое название ветки, например "Возражение: дорого" (для objection-узлов)
    content TEXT NOT NULL, -- сам текст, который видит оператор
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Справочник статусов/этапов воронки лида (структура из CPA_воронка_новостройки_финал.docx).
-- Фиксированный список, не редактируется через интерфейс.
CREATE TABLE IF NOT EXISTS lead_funnel_statuses (
    id SERIAL PRIMARY KEY,
    stage_number INTEGER NOT NULL,
    stage_name VARCHAR NOT NULL,
    status_name VARCHAR NOT NULL,
    sort_order INTEGER NOT NULL,
    UNIQUE (stage_number, status_name)
);

-- Карточка клиента (лид). Консолидированный эквивалент таблиц
-- Лиды/Запрос_лида/География_лида/Покупка_лид из Basedate/database.drawio.
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    last_name VARCHAR,
    first_name VARCHAR,
    middle_name VARCHAR,
    phone VARCHAR NOT NULL,
    source VARCHAR, -- площадка/CPA-сеть, простой текст на этом этапе, без справочника
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    funnel_status_id INTEGER REFERENCES lead_funnel_statuses(id) ON DELETE RESTRICT,
    property_type VARCHAR,
    property_class VARCHAR,
    room_count VARCHAR,
    price_from NUMERIC,
    price_to NUMERIC,
    area_from NUMERIC,
    area_to NUMERIC,
    delivery_deadline VARCHAR,
    region VARCHAR,
    city VARCHAR,
    district VARCHAR,
    locality VARCHAR,
    purchase_method VARCHAR,
    mortgage_type VARCHAR,
    down_payment_percent NUMERIC,
    purchase_timeframe VARCHAR,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- База знаний: статьи с поиском (ILIKE, без спец. индексов на этом этапе),
-- вложениями файлов и видимостью по умолчанию "открыто всем, кроме исключений".
CREATE TABLE IF NOT EXISTS knowledge_articles (
    id SERIAL PRIMARY KEY,
    title VARCHAR NOT NULL,
    content TEXT NOT NULL,
    is_restricted BOOLEAN NOT NULL DEFAULT false,
    author_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_article_attachments (
    id SERIAL PRIMARY KEY,
    article_id INTEGER NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
    file_name VARCHAR NOT NULL,
    file_data TEXT NOT NULL, -- base64, тот же подход, что и в employee_documents
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_article_visibility (
    article_id INTEGER NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, employee_id)
);

-- Сидинг справочника воронки. migrate.js прогоняет этот файл при каждом старте
-- сервера, поэтому сидинг сделан идемпотентным через ON CONFLICT DO NOTHING
-- (конфликт по UNIQUE (stage_number, status_name) выше). sort_order — отдельная
-- нумерация с 1 внутри каждого этапа, не сквозная по всей таблице.
INSERT INTO lead_funnel_statuses (stage_number, stage_name, status_name, sort_order) VALUES
    (1, 'Первичный контакт', 'Номер не существует', 1),
    (1, 'Первичный контакт', 'Ошиблись номером', 2),
    (1, 'Первичный контакт', 'Номер отключен', 3),
    (1, 'Первичный контакт', 'Недоступен', 4),
    (1, 'Первичный контакт', 'Автоответчик / голосовая почта', 5),
    (1, 'Первичный контакт', 'Лид ответил', 6),
    (1, 'Первичный контакт', 'Перезвон', 7),
    (1, 'Первичный контакт', 'Не ответил после N перезвонов', 8),
    (1, 'Первичный контакт', 'Сбросил трубку', 9),
    (1, 'Первичный контакт', 'Номер заблокирован', 10),

    (2, 'Актуальность новостройки', 'Уже купил', 1),
    (2, 'Актуальность новостройки', 'Не интересно / Не актуально', 2),
    (2, 'Актуальность новостройки', 'Интересует аренда', 3),
    (2, 'Актуальность новостройки', 'Риэлтор', 4),
    (2, 'Актуальность новостройки', 'Интересует земельный участок', 5),
    (2, 'Актуальность новостройки', 'Интересует дом / коттедж', 6),
    (2, 'Актуальность новостройки', 'Интересует коммерция', 7),
    (2, 'Актуальность новостройки', 'Интересует вторичное жилье', 8),
    (2, 'Актуальность новостройки', 'Интересует покупка в новостройке', 9),

    (3, 'Скоринг', 'Не прошел скоринг', 1),
    (3, 'Скоринг', 'Не подходит ЖК', 2),
    (3, 'Скоринг', 'Не подходит ГЕО', 3),
    (3, 'Скоринг', 'Не подходит стоимость', 4),
    (3, 'Скоринг', 'Не подходит комнатность', 5),
    (3, 'Скоринг', 'Не подходит площадь', 6),
    (3, 'Скоринг', 'Не подходит отделка', 7),
    (3, 'Скоринг', 'Не подходит способ приобретения', 8),
    (3, 'Скоринг', 'Нет ПВ', 9),
    (3, 'Скоринг', 'Не подходит срок сдачи', 10),
    (3, 'Скоринг', 'Покупка более 3–6 месяцев', 11),
    (3, 'Скоринг', 'Отказался от перевода / передачи данных', 12),
    (3, 'Скоринг', 'Технические причины', 13),
    (3, 'Скоринг', 'Номер в ЧС', 14),
    (3, 'Скоринг', 'Дубль лида', 15),
    (3, 'Скоринг', 'Отказ в переводе «МС»', 16),

    (4, 'Передача лида', 'Анкета заполнена «ЯН»', 1),
    (4, 'Передача лида', 'Лид переведен «ЯН»', 2),
    (4, 'Передача лида', 'Лид переведен «МС»', 3),

    (5, 'Повторный контакт', 'Прилагаемый ЖК подошел (Разговор с застройщиком был)', 1),
    (5, 'Повторный контакт', 'Не получил звонок от партнера «ЯН»', 2),
    (5, 'Повторный контакт', 'Записан на просмотр / консультацию / офис продаж', 3),
    (5, 'Повторный контакт', 'Выбрал другой объект / застройщика', 4),
    (5, 'Повторный контакт', 'Отложил покупку', 5),
    (5, 'Повторный контакт', 'Предложили другой ЖК (так как прошлый не подошел)', 6),
    (5, 'Повторный контакт', 'Не удалось связаться повторно', 7),
    (5, 'Повторный контакт', 'Ожидает решение / звонка', 8),

    (6, 'Повторная передача лида', 'Анкета заполнена «ЯН»', 1),
    (6, 'Повторная передача лида', 'Лид переведен «ЯН»', 2),
    (6, 'Повторная передача лида', 'Лид переведен «МС»', 3)
ON CONFLICT (stage_number, status_name) DO NOTHING;

-- ============================================================
-- Матрица скриптов (оффер × статус воронки) + операторы many-to-many.
-- ============================================================

-- Статус "Новый" — присваивается лиду по умолчанию при загрузке базы (загрузка
-- лидов руководителем — отдельная будущая задача, здесь только сам статус).
-- stage_number = 0, чтобы сортировался раньше "Первичного контакта" (stage 1).
INSERT INTO lead_funnel_statuses (stage_number, stage_name, status_name, sort_order) VALUES
(0, 'Новый', 'Новый', 1)
ON CONFLICT (stage_number, status_name) DO NOTHING;

-- offer_id у лида — для подбора скрипта по паре (оффер, статус). Заполняется
-- будущей загрузкой базы лидов; на этой итерации может быть NULL у старых лидов.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL;

-- Скрипт теперь однозначно определяется парой (оффер, статус воронки) — оба
-- обязательны. Старое поведение "без оффера" (offer_id NULL) отменяется явно
-- по решению владельца проекта (2026-08-05) — оффер был необязателен только
-- пока не стал частью ключа подбора скрипта. Миграция написана "как для чистого
-- случая" — ручная зачистка существующих строк scripts (offer_id/funnel_status_id
-- IS NULL) на бою выполняется куратором вручную перед деплоем, отдельно от
-- этого файла (см. dialog.md, раунд 2) — сюда автоматический бэкофилл не добавляем.
ALTER TABLE scripts ALTER COLUMN offer_id SET NOT NULL;
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS funnel_status_id INTEGER REFERENCES lead_funnel_statuses(id);
ALTER TABLE scripts ALTER COLUMN funnel_status_id SET NOT NULL;
-- WHEN duplicate_object ловит повтор для большинства именованных объектов, но
-- ADD CONSTRAINT ... UNIQUE неявно создаёт ещё и индекс с тем же именем — при
-- повторном прогоне на уже смигрированной БД реально прилетает duplicate_table
-- ("отношение ... уже существует"), проверено эмпирически на локальной dev-БД
-- (голый WHEN duplicate_object ронял второй прогон migrate.js).
DO $$ BEGIN
    ALTER TABLE scripts ADD CONSTRAINT scripts_offer_status_unique UNIQUE (offer_id, funnel_status_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- Один оператор может работать сразу с несколькими скриптами (разными линиями:
-- кто-то только новые, кто-то только повторные) — раньше было employees.script_id
-- (ровно один скрипт на оператора), теперь связка. Паттерн — как у уже
-- существующей knowledge_article_visibility (составной PK).
CREATE TABLE IF NOT EXISTS employee_scripts (
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    PRIMARY KEY (employee_id, script_id)
);

-- Перенос существующих назначений до дропа колонки. ВАЖНО (проверено эмпирически
-- на локальной dev-БД, см. dialog.md раунд про идемпотентность): голый
-- "INSERT ... SELECT script_id FROM employees ... ; ALTER TABLE employees DROP
-- COLUMN script_id;" НЕ идемпотентен, если написать его как два обычных
-- топ-уровневых стейтмента — на ПЕРВОМ прогоне после старта всё отрабатывает,
-- но колонка правда исчезает, а на ВТОРОМ и последующих прогонах (сервер
-- перезапускается, migrate.js гоняет этот файл заново) сам SELECT ... script_id
-- падает с ошибкой "column does not exist" ещё на этапе разбора запроса —
-- ошибка внутри multi-statement пакета обрывает весь прогон миграции и роняет
-- старт сервера НАВСЕГДА после первого успешного деплоя. IF NOT EXISTS на самом
-- DROP COLUMN тут не спасает, т.к. падает более ранний SELECT, а не DROP.
-- Решение: обернуть перенос+дроп в DO-блок с динамическим EXECUTE — тогда текст
-- с SELECT ... script_id лежит внутри строкового литерала и не разбирается
-- парсером заранее, а выполняется только когда IF подтвердил, что колонка
-- реально существует (проверено: второй прогон блока — чистый no-op, без ошибок).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'script_id'
    ) THEN
        EXECUTE '
            INSERT INTO employee_scripts (employee_id, script_id)
            SELECT id, script_id FROM employees WHERE script_id IS NOT NULL
            ON CONFLICT DO NOTHING
        ';
        EXECUTE 'ALTER TABLE employees DROP COLUMN script_id';
    END IF;
END $$;

-- Организация (юрлицо владельца CRM) — справочные данные для будущей генерации
-- документов. Обычная таблица (не singleton) — на этой итерации фронт работает
-- ровно с одной записью (создаёт, если её ещё нет; иначе редактирует), но схема
-- не запрещает несколько строк на будущее (несколько юрлиц), решение куратора.
CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR NOT NULL,
    legal_form VARCHAR,          -- Организационно-правовая форма (ООО, ИП и т.п.)
    inn VARCHAR,
    kpp VARCHAR,
    ogrn VARCHAR,
    okved VARCHAR,
    authorized_capital NUMERIC,
    registration_country VARCHAR,
    general_director VARCHAR,
    registration_date DATE,
    legal_address VARCHAR
);

CREATE TABLE IF NOT EXISTS organization_bank_accounts (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    bank_name VARCHAR NOT NULL,
    checking_account VARCHAR,    -- Расчётный счёт
    correspondent_account VARCHAR,
    bik VARCHAR,
    currency VARCHAR,
    opened_at DATE
);

CREATE TABLE IF NOT EXISTS organization_taxes (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    tax_type VARCHAR NOT NULL,   -- Вид налога — свободный текст, справочника нет
    rate VARCHAR,                -- строка, не число (ставки бывают вида "6%", "15% с разницы")
    periodicity VARCHAR          -- свободный текст, справочника периодов нет
);

-- CPA-сеть — партнёр, которому организация передаёт лиды дальше (не источник
-- входящего трафика, а канал, куда лиды уходят от нас). Справочник из нескольких
-- записей, без вложенных под-сущностей — ближе по духу к employees, чем к
-- organizations. ON DELETE RESTRICT — не даём удалить организацию, пока к ней
-- привязаны сети (у organizations сейчас всё равно нет DELETE-эндпоинта, но
-- схема остаётся корректной сама по себе).
CREATE TABLE IF NOT EXISTS cpa_networks (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    name VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'Активна',
    connected_at DATE,
    payout_currency VARCHAR,
    commission_percent NUMERIC
);

-- Отделы — самостоятельный справочник, ведётся на странице "Сотрудники"
-- (report_2026-08-01.md, п.1). employees.department остаётся свободным текстом
-- без FK на эту таблицу — та же логика поэтапного внедрения, что у leads.source
-- (задача CPA-сети). ON DELETE RESTRICT — не даём удалить организацию, пока к
-- ней привязаны отделы, тот же принцип, что у cpa_networks выше.
CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    name VARCHAR NOT NULL
);

-- ============================================================
-- Офферы недвижимости + объединение с CPA-сетями + рекламные площадки
-- (report_2026-08-01.md, 07.08.2026). Страница cpa-networks.html не меняет
-- URL/пункт хаб-навигации — сети сворачиваются в переключатель+модалку,
-- основной объём страницы теперь офферы. routes/cpaNetworks.js и cpa_networks
-- не меняются, все 6 полей сети уже реализованы 1:1 с макетом.
-- ============================================================

-- Внимание: таблица offers уже существует (заглушка для скриптов звонков,
-- id+name) — не путать и не переиспользовать, здесь отдельная сущность.
-- ON DELETE CASCADE (не RESTRICT, как в исходном черновике брифа) — решение
-- владельца по факту чтения макета (dialog.md, 07.08.2026): подтверждение
-- удаления сети в макете прямо говорит "сеть и связанные с ней офферы будут
-- удалены", т.е. удаление сети должно каскадно чистить её офферы, а не
-- блокироваться существованием офферов.
CREATE TABLE IF NOT EXISTS real_estate_offers (
    id SERIAL PRIMARY KEY,
    network_id INTEGER NOT NULL REFERENCES cpa_networks(id) ON DELETE CASCADE,
    name VARCHAR NOT NULL,
    category VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'paused', 'disabled', 'draft')),
    date_start DATE,
    date_end DATE,
    action_type VARCHAR,
    rate NUMERIC,
    hold_days INTEGER,
    lead_check VARCHAR,
    target_criteria TEXT,
    non_target_criteria TEXT,
    obj_types VARCHAR[] NOT NULL DEFAULT '{}',
    finishes VARCHAR[] NOT NULL DEFAULT '{}',
    rooms VARCHAR[] NOT NULL DEFAULT '{}',
    developer VARCHAR,
    deadline VARCHAR,
    client_type VARCHAR,
    other_borrower BOOLEAN NOT NULL DEFAULT false,
    purchase_term VARCHAR,
    down_payment NUMERIC,
    payment_method VARCHAR,
    mortgage_type VARCHAR,
    priority INTEGER,
    transfer_time VARCHAR,
    lead_limit INTEGER
);

-- Класс объекта переехал с уровня оффера в строку сегмента (report_2026-08-01.md,
-- п.1, 07.08.2026): цена/площадь и так уже зависят от класса, логичнее задавать
-- вместе. Прежний общий obj_classes VARCHAR[] на real_estate_offers — удалён.
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS obj_classes;

-- «Иной заёмщик» (report_2026-08-01.md, п.3, 07.08.2026) — виден в форме только
-- при «Тип клиента» = «Пенсионер», сбрасывается в false при уходе от этого значения.
ALTER TABLE real_estate_offers ADD COLUMN IF NOT EXISTS other_borrower BOOLEAN NOT NULL DEFAULT false;

-- Сегменты цена/площадь (произвольное число на оффер, т.к. диапазон зависит
-- от сочетания типа+класса объекта — не один общий диапазон). Пересобирается
-- целиком (delete+insert в транзакции) при каждом POST/PUT оффера — фронт
-- держит список сегментов как единый массив в форме, отдельных CRUD-ручек
-- на сегмент нет (см. routes/realEstateOffers.js).
CREATE TABLE IF NOT EXISTS real_estate_offer_segments (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES real_estate_offers(id) ON DELETE CASCADE,
    label VARCHAR,
    object_class VARCHAR,
    price_min NUMERIC,
    price_max NUMERIC,
    area_min NUMERIC,
    area_max NUMERIC
);

ALTER TABLE real_estate_offer_segments ADD COLUMN IF NOT EXISTS object_class VARCHAR;

-- География — произвольное число строк (Регион/Город/Район/Нас. пункт) на
-- оффер, отдельно для объекта и для клиента (kind различает их) — тот же
-- приём пересборки целиком, что и у сегментов выше.
CREATE TABLE IF NOT EXISTS real_estate_offer_geo (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES real_estate_offers(id) ON DELETE CASCADE,
    kind VARCHAR NOT NULL CHECK (kind IN ('object', 'client')),
    region VARCHAR,
    city VARCHAR,
    district VARCHAR,
    locality VARCHAR
);

-- Рекламные площадки — самостоятельный справочник (решение куратора
-- 06.08.2026: без FK на оффер, отдельная вкладка той же страницы).
CREATE TABLE IF NOT EXISTS ad_platforms (
    id SERIAL PRIMARY KEY,
    name VARCHAR NOT NULL,
    category VARCHAR,
    type VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'Активна'
);

-- ============================================================
-- Способ покупки / Вид ипотеки → M:N + «Настройка списков»
-- (report_2026-08-01.md, 07.08.2026)
-- ============================================================

-- «Способ покупки» и «Виды ипотеки» стали множественным выбором в макете
-- (chip-select, как у типа/класса объекта) — одиночные VARCHAR-колонки
-- заменяются junction-таблицами, тот же паттерн delete+insert в транзакции,
-- что уже есть у real_estate_offer_segments/geo. Офферов на бою на момент
-- этой миграции 0 — переноса данных не требуется.
CREATE TABLE IF NOT EXISTS real_estate_offer_payment_methods (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES real_estate_offers(id) ON DELETE CASCADE,
    value VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS real_estate_offer_mortgage_types (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL REFERENCES real_estate_offers(id) ON DELETE CASCADE,
    value VARCHAR NOT NULL
);
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS payment_method;
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS mortgage_type;

-- «Настройка списков» — 11 управляемых справочников формы оффера, ведутся
-- прямо из модалки оффера (переключатель в шапке). Одна общая таблица на
-- все списки (архитектурное решение куратора, report_2026-08-01.md) — все
-- 11 списков структурно одинаковы (упорядоченный список строк без
-- доп. метаданных), отдельные таблицы дали бы 11-кратный дублирующийся CRUD
-- без пользы. «Статус» сюда намеренно не входит — от него зависит цвет
-- бейджа/логика фильтра в таблице офферов, произвольные значения там
-- сломают раскраску.
CREATE TABLE IF NOT EXISTS param_lists (
    id SERIAL PRIMARY KEY,
    list_key VARCHAR NOT NULL,
    value VARCHAR NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (list_key, value)
);

-- Сидинг текущих значений (идемпотентно, как lead_funnel_statuses выше в
-- файле) — переносит то, что раньше было хардкодом в HTML/JS, в БД как
-- стартовые данные, дальше редактируется через панель "Настройка списков".
INSERT INTO param_lists (list_key, value, sort_order) VALUES
    ('category', 'Новостройка', 1), ('category', 'Вторичка', 2), ('category', 'Загородная недвижимость', 3), ('category', 'Коммерческая недвижимость', 4),
    ('actionType', 'Целевой лид', 1), ('actionType', 'Лид', 2), ('actionType', 'Заявка на показ', 3),
    ('leadCheck', 'Да, ручная модерация', 1), ('leadCheck', 'Да, автоматическая', 2), ('leadCheck', 'Нет', 3),
    ('objType', 'Квартира', 1), ('objType', 'Апартаменты', 2), ('objType', 'Дом', 3), ('objType', 'Таунхаус', 4), ('objType', 'Участок', 5), ('objType', 'Коммерция', 6),
    ('objClass', 'Эконом', 1), ('objClass', 'Комфорт', 2), ('objClass', 'Комфорт+', 3), ('objClass', 'Бизнес', 4), ('objClass', 'Премиум', 5),
    ('finish', 'Без отделки', 1), ('finish', 'Черновая', 2), ('finish', 'Чистовая', 3),
    ('rooms', 'Студия', 1), ('rooms', '1к', 2), ('rooms', '2к', 3), ('rooms', '3к', 4), ('rooms', '4к+', 5),
    ('clientType', 'Ипотечный заёмщик', 1), ('clientType', 'Наличный покупатель', 2), ('clientType', 'Инвестор', 3), ('clientType', 'Переезд по работе', 4), ('clientType', 'Улучшение жилищных условий', 5), ('clientType', 'Пенсионер', 6),
    ('purchaseTerm', 'До 1 месяца', 1), ('purchaseTerm', '1–3 месяца', 2), ('purchaseTerm', '3–6 месяцев', 3), ('purchaseTerm', 'Более 6 месяцев', 4),
    ('paymentMethod', 'Ипотека', 1), ('paymentMethod', 'Наличные', 2), ('paymentMethod', 'Рассрочка от застройщика', 3), ('paymentMethod', 'Сертификат/субсидия', 4), ('paymentMethod', 'Материнский капитал', 5),
    ('mortgageType', 'Господдержка', 1), ('mortgageType', 'Семейная', 2), ('mortgageType', 'IT-ипотека', 3), ('mortgageType', 'Военная', 4), ('mortgageType', 'От застройщика', 5), ('mortgageType', 'Вторичная', 6)
ON CONFLICT (list_key, value) DO NOTHING;

-- ============================================================
-- Корректировки формы оффера (report_2026-08-01.md, 08.08.2026)
-- ============================================================

-- 1. «Первоначальный взнос»: ₽ → % — переосмысление существующего поля,
-- то же имя, что у leads.down_payment_percent. RENAME COLUMN не идемпотентен
-- сам по себе (второй прогон падает "column does not exist", т.к. down_payment
-- уже переименована) — тот же приём с DO-блоком и проверкой в
-- information_schema.columns, что уже применён выше для employees.script_id.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'real_estate_offers' AND column_name = 'down_payment'
    ) THEN
        ALTER TABLE real_estate_offers RENAME COLUMN down_payment TO down_payment_percent;
    END IF;
END $$;

-- 2. «Тип клиента» → множественный выбор. Обычный VARCHAR[] прямо на
-- real_estate_offers (тот же характер, что у obj_types/finishes — мультиселект
-- без доп. атрибутов на значение), не junction-таблица, как у способа
-- покупки/вида ипотеки — тот паттерн был нужен только под будущие атрибуты
-- на значение, которых тут нет.
ALTER TABLE real_estate_offers ADD COLUMN IF NOT EXISTS client_types VARCHAR[] NOT NULL DEFAULT '{}';
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS client_type;

-- other_borrower — теперь трёхзначное: NULL («Пенсионер» не выбран, поле
-- неприменимо) / true / false (оба — «Пенсионер» выбран, чекбокс отмечен
-- или нет). Раньше был boolean NOT NULL DEFAULT false — с одиночным
-- client_type «неприменимо» и «false» были неразличимы, с массивом это
-- уже реальная разница.
ALTER TABLE real_estate_offers ALTER COLUMN other_borrower DROP NOT NULL;
ALTER TABLE real_estate_offers ALTER COLUMN other_borrower DROP DEFAULT;

-- 3. «Комнатность» — с уровня оффера в строку сегмента (тот же переезд, что
-- уже проделан с «Класс объекта») — один сегмент = одна комнатность, скаляр,
-- не массив: диапазон цена/площадь в сегменте относится к одной конкретной
-- комнатности, множественный выбор снова смешивал бы разнородные диапазоны.
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS rooms;
ALTER TABLE real_estate_offer_segments ADD COLUMN IF NOT EXISTS room_count VARCHAR;
