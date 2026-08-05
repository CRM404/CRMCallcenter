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
-- Скрипт один, общий для всех операторов, на эту итерацию.
CREATE TABLE IF NOT EXISTS scripts (
    id SERIAL PRIMARY KEY,
    title VARCHAR NOT NULL
);

-- status/employee_id добавлены отдельно (не в исходном CREATE TABLE) — несколько
-- скриптов-черновиков теперь могут существовать одновременно, но операторам
-- показывается только один активный (см. routes/scripts.js). ADD COLUMN IF NOT
-- EXISTS — тот же приём идемпотентности, что и весь этот файл (migrate.js
-- прогоняет schema.sql при каждом старте сервера).
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS status VARCHAR NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active'));
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;

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
