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

-- УСТАРЕЛО (13.08.2026): здесь была колонка employees.script_id — назначение
-- скрипта оператору, позже вытесненная таблицей-связкой employee_scripts (её
-- CREATE и миграция стояли ниже по файлу). Обе убраны вместе с самой идеей
-- ручной привязки операторов к скриптам: скрипт теперь принадлежит ЛИДУ
-- (leads.script_id / leads.repeat_script_id, см. конец файла). Сам ADD COLUMN
-- удалён, а не оставлен "на всякий случай": migrate.js гоняет schema.sql при
-- каждом старте, поэтому колонка пересоздавалась бы пустой на каждом рестарте,
-- а дропающего её DO-блока в файле больше нет. Явный DROP COLUMN — в финальной
-- секции файла.

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

-- УСТАРЕЛО (13.08.2026): здесь заводилась leads.offer_id (один оффер на лида).
-- У лида теперь несколько офферов — связка lead_offers в конце файла, куда
-- старое значение и переносится. ADD COLUMN удалён по той же причине, что и
-- employees.script_id выше: иначе колонка воскресала бы пустой на каждом
-- старте сервера и снова дропалась в конце файла — бесконечный цикл.

-- УСТАРЕЛО (куратор, 10.08.2026): здесь раньше стояла принудительная привязка
-- скрипта к паре (оффер, статус воронки) — offer_id/funnel_status_id NOT NULL +
-- уникальный констрейнт на пару. Решение отменено позже (report_2026-08-01.md,
-- 09.08.2026) — у скрипта больше нет ни оффера, ни статуса воронки, только
-- привязка к оператору (employee_scripts). Обе колонки дропаются ниже
-- ("Скрипты: убрать привязку к офферу/статусу воронки"). Блок удалён целиком —
-- он был БАГОМ, а не просто мёртвым кодом: ALTER COLUMN offer_id SET NOT NULL
-- гонялся на КАЖДОМ старте сервера (migrate.js прогоняет весь файл при каждом
-- боте), и после того как колонка один раз дропалась ниже по файлу, следующий
-- же старт пересоздавал её пустой (ADD COLUMN IF NOT EXISTS выше) и тут же
-- падал на этой самой SET NOT NULL — вечный краш-луп на каждом рестарте
-- (воспроизведено и на бою, и локально: error 23502, "column offer_id of
-- relation scripts contains null values").

-- УСТАРЕЛО (13.08.2026): здесь стояла таблица-связка employee_scripts
-- (оператор ↔ скрипты, многие-ко-многим) и DO-блок, переносивший в неё старую
-- employees.script_id. Ручная привязка операторов к скриптам отменена целиком —
-- скрипт принадлежит лиду. Таблица дропается в финальной секции файла; и CREATE,
-- и блок переноса удалены отсюда, иначе таблица пересоздавалась бы на каждом
-- старте сервера сразу после собственного DROP.
--
-- Приём с DO + EXECUTE, который был в удалённом блоке, никуда не делся — он
-- переиспользован для миграции leads.offer_id → lead_offers (конец файла).
-- Причина, по которой он обязателен, тоже прежняя и проверена на бою: голый
-- "INSERT ... SELECT <колонка> ...; ALTER TABLE ... DROP COLUMN <колонка>;"
-- двумя обычными стейтментами НЕ идемпотентен. Первый прогон отрабатывает и
-- колонку убирает, а на втором (migrate.js гоняет schema.sql при каждом старте)
-- SELECT по уже несуществующей колонке падает "column does not exist", ошибка
-- обрывает весь multi-statement пакет и сервер не поднимается НИКОГДА после
-- первого успешного деплоя. IF NOT EXISTS на DROP не спасает — падает более
-- ранний SELECT. Внутри EXECUTE текст запроса лежит строковым литералом, не
-- разбирается заранее и выполняется только под проверкой information_schema.

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

-- Добавлено 19.08.2026 вместе с переделкой раздела «Реквизиты» по макету.
-- ADD COLUMN IF NOT EXISTS — та же идемпотентность, что и весь файл: migrate.js
-- прогоняет schema.sql при каждом старте сервера.
--
-- actual_address: в макете секция «Адреса» содержит два поля, юридический и
-- фактический; в базе был только юридический.
-- letterhead_*: бланк письма в макете правится своим окном («Шапка», «Подпись»),
-- то есть его текст надо где-то хранить. Пока поля пусты, бланк собирается из
-- реквизитов организации, как и раньше, — прежнее поведение сохраняется.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS actual_address VARCHAR;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS letterhead_header TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS letterhead_signature VARCHAR;

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

-- «Настройка списков» — 13 управляемых справочников форм оффера и лида,
-- ведутся прямо из модалки оффера (переключатель в шапке). Одна общая таблица
-- на все списки (архитектурное решение куратора, report_2026-08-01.md) — все
-- списки структурно одинаковы (упорядоченный список строк без
-- доп. метаданных), отдельные таблицы дали бы 13-кратный дублирующийся CRUD
-- без пользы. Два списка (decisionMaker, deadline) поля в форме оффера не
-- имеют — они нужны карточке лида, но управляются той же панелью (14.08.2026). «Статус» сюда намеренно не входит — от него зависит цвет
-- бейджа/логика фильтра в таблице офферов, произвольные значения там
-- сломают раскраску.
CREATE TABLE IF NOT EXISTS param_lists (
    id SERIAL PRIMARY KEY,
    list_key VARCHAR NOT NULL,
    value VARCHAR NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (list_key, value)
);

-- Сидинг текущих значений — только если таблица ещё полностью пустая
-- (report_2026-08-01.md, 09.08.2026). Раньше был обычный INSERT ... ON
-- CONFLICT DO NOTHING, который гоняется migrate.js при каждом старте сервера
-- — для значений, которые пользователь сам УДАЛИЛ через панель "Настройка
-- списков", это неотличимо от "никогда не создавалось", и удалённая строка
-- молча возвращалась на следующем деплое. IF NOT EXISTS (SELECT 1 ...) делает
-- весь блок одноразовым — срабатывает только на пустой/новой базе, дальнейшие
-- правки пользователя (удаления/добавления) переживают любое число деплоев.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM param_lists) THEN
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
    END IF;
END $$;

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

-- ============================================================
-- Скрипты: убрать привязку к офферу/статусу воронки (report_2026-08-01.md,
-- 09.08.2026) — владелец подтвердил, что подбор по паре (оффер, статус
-- воронки) окончательно отменён (routes/scripts.js, коммит 7ad10bd), скрипт
-- теперь привязан только к оператору (employee_scripts). DROP COLUMN IF
-- EXISTS идемпотентен сам по себе, отдельный DO-блок не нужен.
-- ============================================================

ALTER TABLE scripts DROP CONSTRAINT IF EXISTS scripts_offer_status_unique;
ALTER TABLE scripts DROP COLUMN IF EXISTS offer_id;
ALTER TABLE scripts DROP COLUMN IF EXISTS funnel_status_id;

-- УСТАРЕЛО (13.08.2026): здесь FK leads.offer_id перецеплялся с заглушки
-- offers на real_estate_offers. Сама колонка ниже заменяется связкой
-- lead_offers (у лида несколько офферов), поэтому пересоздавать FK на каждом
-- старте больше не на что — блок удалён вместе с ADD COLUMN выше.

-- ============================================================
-- Источники (report_2026-08-01.md, 11.08.2026) — новая страница «Источники»
-- в навигации. Площадка = упрощённая ad_platforms (category/type больше не
-- используются — таблица и бэкенд были заведены 06.08.2026 под другую версию
-- сущности, потом скрыты из UI 07.08.2026; теперь переиспользуются под
-- "Площадку" в новом виде). Источник — новая сущность, дочерняя к площадке
-- (N:1, обязательна). Источник <-> CPA-сеть — M:N через таблицу-связку.
-- ============================================================

ALTER TABLE ad_platforms DROP COLUMN IF EXISTS category;
ALTER TABLE ad_platforms DROP COLUMN IF EXISTS type;
-- status: было 3 значения (Активна/Приостановлена/Отключена), без DB CHECK
-- (только app-level в routes/adPlatforms.js) — теперь 2 значения
-- (Активна/Неактивна). DB CHECK не добавляем (сохраняем как было —
-- app-level валидация), список допустимых значений обновлён в routes/adPlatforms.js.

CREATE TABLE IF NOT EXISTS sources (
    id SERIAL PRIMARY KEY,
    platform_id INTEGER NOT NULL REFERENCES ad_platforms(id) ON DELETE RESTRICT,
    root_source VARCHAR NOT NULL,
    city_region VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'Актуализация' CHECK (status IN ('Активен', 'Неактивен', 'Архив', 'Актуализация')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_cpa_networks (
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    cpa_network_id INTEGER NOT NULL REFERENCES cpa_networks(id) ON DELETE RESTRICT,
    PRIMARY KEY (source_id, cpa_network_id)
);

-- ============================================================
-- Точечные правки «Источники» + «Сотрудники» (report_2026-08-01.md, 11.08.2026)
-- ============================================================

-- Источники: "Название" -> "Корневой источник" (данные сохраняются). RENAME
-- COLUMN не идемпотентен сам по себе — тот же приём, что у
-- real_estate_offers.down_payment.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sources' AND column_name = 'name'
    ) THEN
        ALTER TABLE sources RENAME COLUMN name TO root_source;
    END IF;
END $$;

-- Новое поле "Источник лидов". NOT NULL на уровне БД не ставим — на проде в
-- sources уже могут быть строки без значения, добавить NOT NULL без
-- бэкофилла нельзя. Обязательность для новых/редактируемых записей — на
-- уровне routes/sources.js (тот же приём, что и у ad_platforms.status).
ALTER TABLE sources ADD COLUMN IF NOT EXISTS lead_source VARCHAR;

-- Сотрудники: три новых поля, все nullable, без CHECK/справочников (свободный
-- ввод, termination_date не связана со status).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS line_type VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_schedule VARCHAR;

-- ============================================================
-- Страница «Лиды» (report_2026-08-01.md, 13.08.2026)
-- ============================================================

-- Источник лида — переход со свободного текста на связь со справочником
-- "Источники". Данные в текущей leads.source не переносим (0 реальных лидов
-- на проде на момент задачи — таблица только что появилась в обороте).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL;
ALTER TABLE leads DROP COLUMN IF EXISTS source;

-- «На линии» — ручной переключатель оператора (задел под будущую АТС).
-- on_line_since — момент, когда сотрудник стал свободен для следующего лида;
-- нужен для очереди автораспределения "кто дольше всех ждёт свободным".
-- NULL, когда сотрудник не на линии.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS on_line BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS on_line_since TIMESTAMP;

-- ============================================================
-- Скрипты: привязка к лиду, раздача по линии
-- (report_2026-08-01.md, 13.08.2026)
-- ============================================================

-- Линия лида и два скрипта: основной и «для повторных» (этапы воронки 5–6).
-- line_type без DB CHECK — валидация на API (routes/leadsAdmin.js), тот же
-- приём, что уже принят для ad_platforms.status и sources.lead_source.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS line_type VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS repeat_script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL;

-- Три связки лида. Все — паттерн «пересборка целиком при каждом POST/PUT»
-- (как real_estate_offer_segments): отдельных CRUD-ручек на строку нет.

-- У лида несколько офферов (решение владельца п.4).
CREATE TABLE IF NOT EXISTS lead_offers (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    offer_id INTEGER NOT NULL REFERENCES real_estate_offers(id) ON DELETE CASCADE,
    PRIMARY KEY (lead_id, offer_id)
);

-- Правило «при каких статусах воронки показывать основной скрипт». Это НЕ
-- текущий статус лида — тот один и лежит в leads.funnel_status_id.
CREATE TABLE IF NOT EXISTS lead_script_statuses (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    funnel_status_id INTEGER NOT NULL REFERENCES lead_funnel_statuses(id) ON DELETE CASCADE,
    PRIMARY KEY (lead_id, funnel_status_id)
);

-- Пул раздачи: есть строки — лид уходит только этим сотрудникам (и только
-- своей линии), пусто — всем подходящим по линии.
CREATE TABLE IF NOT EXISTS lead_distribution_pool (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    PRIMARY KEY (lead_id, employee_id)
);

-- Перенос единственного оффера лида в связку + дроп колонки. DO + EXECUTE
-- здесь обязателен, а не «для красоты»: подробный разбор — в комментарии выше
-- по файлу (там, где раньше стояла employee_scripts). Двумя обычными
-- стейтментами этот перенос роняет сервер на втором старте после деплоя.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'leads' AND column_name = 'offer_id'
    ) THEN
        EXECUTE '
            INSERT INTO lead_offers (lead_id, offer_id)
            SELECT id, offer_id FROM leads WHERE offer_id IS NOT NULL
            ON CONFLICT DO NOTHING
        ';
        EXECUTE 'ALTER TABLE leads DROP COLUMN offer_id';
    END IF;
END $$;

-- Ручная привязка операторов к скриптам отменена: сначала колонка, потом
-- сменившая её таблица. Оба стейтмента идемпотентны сами по себе — DO-блок не
-- нужен, здесь ничего не читается, только дропается.
ALTER TABLE employees DROP COLUMN IF EXISTS script_id;
DROP TABLE IF EXISTS employee_scripts;

-- employees.line_type становится фиксированным списком Входящая/Исходящая
-- (решение владельца п.9). Сначала подтягиваем близкие написания (лишние
-- пробелы, другой регистр) к каноническим и только потом чистим в NULL
-- действительно чужое: голое затирание по точному сравнению съело бы заодно
-- и «входящая», и « Исходящая » (dialog.md, H1).
UPDATE employees SET line_type = 'Входящая'
    WHERE line_type IS NOT NULL AND lower(btrim(line_type)) = lower('Входящая') AND line_type <> 'Входящая';
UPDATE employees SET line_type = 'Исходящая'
    WHERE line_type IS NOT NULL AND lower(btrim(line_type)) = lower('Исходящая') AND line_type <> 'Исходящая';
UPDATE employees SET line_type = NULL
    WHERE line_type IS NOT NULL AND line_type NOT IN ('Входящая', 'Исходящая');

-- TODO (за владельцем, dialog.md A5): таблица-заглушка offers (id+name,
-- объявлена в начале файла) осталась без единой ссылки — leads.offer_id
-- переехал в lead_offers, эндпоинты /api/admin/offers удалены. Куратор был за
-- DROP TABLE с проверкой пустоты, дизайн-сессия — за «не трогать в этой
-- задаче». До решения владельца таблица остаётся как есть.

-- ============================================================
-- Карточка клиента на странице оператора: новый состав полей
-- (report_2026-08-01.md + report_designer.md, 14.08.2026)
-- ============================================================

-- Замок одноразовых правок ДАННЫХ (решение куратора, dialog.md A2).
-- Зачем отдельная таблица: migrate.js гоняет весь этот файл при КАЖДОМ старте
-- сервера, поэтому обычный INSERT ... ON CONFLICT DO NOTHING для справочных
-- значений неотличим от «пользователь его удалил» — удалённая строка молча
-- возвращалась бы на следующем деплое (этот баг уже чинили 09.08 для сидинга
-- param_lists). Для НОВОГО ключа хватает замка «такого list_key ещё нет»
-- (ниже), но для дополнения СУЩЕСТВУЮЩЕГО списка такого признака нет — нужен
-- внешний факт «эта правка уже применялась», он и лежит здесь.
-- Запись замка ставится в том же DO-блоке, что и сама правка: DO-блок
-- атомарен, так что «замок встал, а данные не доехали» невозможно.
CREATE TABLE IF NOT EXISTS applied_migrations (
    id VARCHAR PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Девять новых полей лида. Все значения хранятся ТЕКСТОМ, без FK на
-- param_lists (решение владельца, вариант 1): у офферов те же признаки лежат
-- текстом, и перевод одной стороны на ключи сломал бы будущее сравнение.
-- Гео клиента — плоскими колонками рядом с гео объекта, без отдельной таблицы:
-- у лида гарантированно один адрес каждого вида, таблица дала бы джойн ради
-- связи 1:1 (решение куратора). Колонок под fias-идентификаторы нет и не
-- планируется — они живут только в памяти открытой формы, как у офферов.
-- other_borrower ТРЁХЗНАЧНЫЙ, поэтому без NOT NULL и без DEFAULT:
-- NULL — условие показа не выполнено (поле неприменимо), true/false — оператор
-- ответил. Ровно как real_estate_offers.other_borrower после правки 08.08.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS decision_maker VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_type VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS other_borrower BOOLEAN;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS finish VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS category VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_region VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_city VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_district VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_locality VARCHAR;

-- Два новых справочника. Замок — на КЛЮЧ, а не на пустоту всей таблицы
-- (dialog.md A1): общий замок сидинга выше срабатывает только на полностью
-- пустой param_lists, то есть на боевой базе, где строки давно есть, новые
-- списки не наполнились бы никогда — владелец получил бы два пустых списка.
-- Замок по ключу наполняет каждый список ровно один раз и не воскрешает
-- значения, удалённые владельцем через «Настройку списков».
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM param_lists WHERE list_key = 'decisionMaker') THEN
        INSERT INTO param_lists (list_key, value, sort_order) VALUES
            ('decisionMaker', 'Для себя', 1),
            ('decisionMaker', 'Риэлтор', 2)
        ON CONFLICT (list_key, value) DO NOTHING;
    END IF;
END $$;

-- «Срок сдачи» — АБСОЛЮТНЫЕ кварталы, а не относительные сроки («до полугода»
-- и т.п.): у офферов на бою лежат именно кварталы, и относительный срок с ними
-- не сравнить без пересчёта от текущей даты. sort_order хронологический —
-- будущая сверка «оффер сдаётся не позже, чем нужно клиенту» становится
-- сравнением порядка. Список конечен и однажды устареет; продлевает владелец
-- сам через «Настройку списков».
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM param_lists WHERE list_key = 'deadline') THEN
        INSERT INTO param_lists (list_key, value, sort_order) VALUES
            ('deadline', 'Сдан', 1),
            ('deadline', '1 кв. 2026', 2), ('deadline', '2 кв. 2026', 3), ('deadline', '3 кв. 2026', 4), ('deadline', '4 кв. 2026', 5),
            ('deadline', '1 кв. 2027', 6), ('deadline', '2 кв. 2027', 7), ('deadline', '3 кв. 2027', 8), ('deadline', '4 кв. 2027', 9),
            ('deadline', '1 кв. 2028', 10), ('deadline', '2 кв. 2028', 11), ('deadline', '3 кв. 2028', 12), ('deadline', '4 кв. 2028', 13),
            ('deadline', '1 кв. 2029', 14), ('deadline', '2 кв. 2029', 15), ('deadline', '3 кв. 2029', 16), ('deadline', '4 кв. 2029', 17)
        ON CONFLICT (list_key, value) DO NOTHING;
    END IF;
END $$;

-- Дополнение СУЩЕСТВУЮЩИХ справочников значениями, которые на бою уже стоят у
-- офферов, но в списках отсутствуют: «Стандартный» (вид клиента), «White-box»
-- и «Ремонт под ключ» (отделка). Без них такие офферы не сошлись бы с лидом
-- никогда — как только лид начнёт выбирать значение из справочника, их
-- значений в списке просто не будет.
-- Замок здесь внешний (applied_migrations), потому что ключи уже существуют:
-- «значения нет» и «владелец его удалил» изнутри param_lists неразличимы.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-14-clienttype-finish-values') THEN
        INSERT INTO param_lists (list_key, value, sort_order)
        SELECT 'clientType', 'Стандартный',
               COALESCE((SELECT MAX(sort_order) FROM param_lists WHERE list_key = 'clientType'), 0) + 1
        ON CONFLICT (list_key, value) DO NOTHING;

        INSERT INTO param_lists (list_key, value, sort_order)
        SELECT 'finish', 'White-box',
               COALESCE((SELECT MAX(sort_order) FROM param_lists WHERE list_key = 'finish'), 0) + 1
        ON CONFLICT (list_key, value) DO NOTHING;

        INSERT INTO param_lists (list_key, value, sort_order)
        SELECT 'finish', 'Ремонт под ключ',
               COALESCE((SELECT MAX(sort_order) FROM param_lists WHERE list_key = 'finish'), 0) + 1
        ON CONFLICT (list_key, value) DO NOTHING;

        INSERT INTO applied_migrations (id) VALUES ('2026-08-14-clienttype-finish-values');
    END IF;
END $$;

-- ============================================================
-- Рабочий режим оператора: очередь вместо списка, состояния и
-- таймеры, перезвоны (report_2026-08-01.md + report_designer.md,
-- 15.08.2026)
-- ============================================================

-- Перезвоны и признак «карточка сейчас у оператора».
-- next_call_at — момент, когда лид должен вернуться в очередь. NULL = либо в
-- очереди по общим правилам (статус «Новый»), либо вне очереди совсем.
-- call_attempts — СКВОЗНОЙ счётчик недозвонов, общий по всем операторам линии,
-- а не персональный: лид после каждой попытки уходит в общую очередь и
-- следующую попытку делает уже другой человек.
-- opened_at — момент, когда карточка реально выдана в браузер оператора. От неё
-- считается пост-обработка. Ставит её только тот запрос, который отдал карточку
-- (GET /api/leads/next и ответ /complete), а НЕ раздача: раздача проставляет
-- employee_id и в фоне, и оператор, вышедший на линию и отошедший от стола,
-- вернулся бы к пост-обработке «43 минуты», не увидев карточки (dialog.md 0.3).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_call_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_call_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_leads_next_call ON leads (next_call_at) WHERE next_call_at IS NOT NULL;

-- Признаки поведения статуса. Список «автоперезвонных» статусов НЕ хардкодится
-- в коде по названиям: сравнение строки «Недоступен» сломалось бы молча от
-- одного лишнего пробела. Сам справочник статусов через интерфейс не
-- редактируется (эндпоинтов записи нет, см. routes/leadFunnelStatuses.js),
-- поэтому флаги проставляются по названиям ОДИН раз миграцией ниже — а
-- дальше код работает только с флагами.
ALTER TABLE lead_funnel_statuses ADD COLUMN IF NOT EXISTS auto_recall BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_funnel_statuses ADD COLUMN IF NOT EXISTS requires_call_time BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_funnel_statuses ADD COLUMN IF NOT EXISTS releases_lead BOOLEAN NOT NULL DEFAULT false;

-- Замок внешний (applied_migrations): «флаг не стоит» и «флаг сняли вручную»
-- изнутри таблицы неразличимы, а сидинг статусов гоняется при каждом старте.
-- Фильтр по stage_number = 1 не косметика: 'Перезвон' и четыре недозвона живут
-- только на первичном контакте, а на этапах 5–6 есть похожие по смыслу строки,
-- которые лид отпускать не должны.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-15-funnel-status-flags') THEN
        UPDATE lead_funnel_statuses
        SET auto_recall = true, releases_lead = true
        WHERE stage_number = 1
          AND status_name IN ('Номер отключен', 'Недоступен', 'Автоответчик / голосовая почта', 'Сбросил трубку');

        UPDATE lead_funnel_statuses
        SET requires_call_time = true, releases_lead = true
        WHERE stage_number = 1 AND status_name = 'Перезвон';

        INSERT INTO applied_migrations (id) VALUES ('2026-08-15-funnel-status-flags');
    END IF;
END $$;

-- Состояние оператора: off | on_line | break | lunch | training | review.
-- Проверка значений — в коде (services/operatorState.js), не CHECK-констрейнтом:
-- набор состояний ещё будет меняться при появлении телефонии, а снятие CHECK в
-- идемпотентном журнале требует отдельного guard-блока.
-- on_line/on_line_since ОСТАЮТСЯ и продолжают работать как раньше (их читает
-- раздача), но становятся ПРОИЗВОДНЫМИ от work_state: on_line = (work_state =
-- 'on_line'), и поддерживается это в одном месте — в эндпоинте смены состояния.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_state VARCHAR NOT NULL DEFAULT 'off';

-- Разовое уведомление «лид, который был за вами, вернулся в общую очередь».
-- Лид держится за оператором на перерыве, значит держится и после ухода домой;
-- через HELD_LEAD_RELEASE_HOURS он отцепляется (services/leadDistribution.js).
-- Без этой отметки оператор на следующий день просто не найдёт «своего»
-- клиента и прочитает это как потерю (замечание дизайн-сессии, бриф п.11.2).
-- Снимается сразу после того, как оператор её увидел.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS released_lead_notice BOOLEAN NOT NULL DEFAULT false;

-- Таймеры хранятся интервалами на сервере, а не в браузере: обновление страницы
-- обнуляло бы счётчики и цифры были бы бесполезны.
CREATE TABLE IF NOT EXISTS employee_state_intervals (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    state VARCHAR NOT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_state_intervals_emp ON employee_state_intervals (employee_id, started_at);

-- «Открытый интервал ровно один» — гарантия БД, а не только кода (dialog.md C1):
-- две вкладки одного оператора иначе дадут два открытых интервала и удвоят суммы.
CREATE UNIQUE INDEX IF NOT EXISTS idx_state_intervals_open
    ON employee_state_intervals (employee_id) WHERE ended_at IS NULL;

-- Разовая правка существующих сотрудников: work_state приезжает с DEFAULT 'off',
-- и у тех, кто прямо сейчас on_line = true, это прямое противоречие с их же
-- состоянием. COALESCE на случай, когда on_line = true, а on_line_since пуст —
-- иначе получили бы интервал с пустым started_at (уточнение куратора, dialog.md C2).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-15-work-state-backfill') THEN
        UPDATE employees SET work_state = 'on_line' WHERE on_line = true;

        INSERT INTO employee_state_intervals (employee_id, state, started_at)
        SELECT id, 'on_line', COALESCE(on_line_since, NOW())
        FROM employees
        WHERE on_line = true;

        INSERT INTO applied_migrations (id) VALUES ('2026-08-15-work-state-backfill');
    END IF;
END $$;

-- ============================================================
-- График работы сотрудников — админский экран
-- (report_2026-08-01.md, 17.08.2026)
-- ============================================================

-- День графика: одна строка = один день одного сотрудника. Пустая ячейка в
-- сетке — это ОТСУТСТВИЕ строки, отдельного состояния «не заполнено» в базе
-- нет; пункт «Очистить» = DELETE.
--
-- UNIQUE (employee_id, day) — «у сотрудника в одном дне ровно одно состояние»
-- гарантирует база, а не код: два администратора в двух вкладках иначе дадут
-- две строки на один день, и что покажет таблица — вопрос везения. Этот же
-- индекс обслуживает выборку по одному сотруднику.
--
-- ON DELETE CASCADE (в отличие от leads, где отвязка от сотрудника —
-- нормальная жизненная ситуация): осмысленных строк графика без сотрудника не
-- бывает, уволили и удалили — график уходит вместе с ним.
--
-- state без CHECK-констрейнта — валидация на уровне API
-- (services/scheduleFormat.js), как уже принято в проекте для
-- ad_platforms.status, sources.lead_source, employees.line_type/work_state.
--
-- shift_start/shift_end типа TIME, а не VARCHAR: из них считаются часы, строка
-- потребовала бы разбора при каждом подсчёте. Для state <> 'shift' оба NULL —
-- принудительно на сервере, клиенту тут не доверяем.
--
-- is_extra — признак разовой смены. В ИНТЕРФЕЙСЕ ОН НЕ ИСПОЛЬЗУЕТСЯ: владелец
-- решил, что доп. смена выглядит ровно как обычная. Колонка нужна потому, что
-- этот признак нельзя восстановить задним числом — если он не записан в момент
-- постановки, вернуть различение позже можно будет только вручную по всей
-- истории. Цена колонки нулевая, цена её отсутствия — потерянные данные.
CREATE TABLE IF NOT EXISTS employee_schedule_days (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    state VARCHAR NOT NULL,
    shift_start TIME,
    shift_end TIME,
    is_extra BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (employee_id, day)
);

-- Основная выборка экрана идёт по месяцу сразу для всех сотрудников — ведущий
-- столбец day, а не employee_id (последний покрыт UNIQUE-индексом выше).
CREATE INDEX IF NOT EXISTS idx_schedule_days_day ON employee_schedule_days (day);

-- Личное время смены сотрудника (произвольное, с минутами; shift_end < shift_start
-- означает ночную смену). employees.work_schedule, существующая с 11.08.2026,
-- ПЕРЕИСПОЛЬЗУЕТСЯ под поле «Дни»: новой колонки не заводим, переименования нет,
-- смысл поля не меняется — меняется только строгость формата (проверка в
-- routes/employees.js). Шаблон «5/2» нигде в вычислениях не участвует.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_start TIME;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_end TIME;

-- Разовое обнуление work_schedule (решение владельца): старые свободные значения
-- под новый формат не распознаём, поле чистится и заполняется заново руками.
-- Замок ОБЯЗАТЕЛЕН и внешний: migrate.js перечитывает этот файл при КАЖДОМ
-- старте сервера, и без замка UPDATE затирал бы то, что администратор только что
-- ввёл. Изнутри таблицы «значение ещё не проставлено» и «администратор его
-- стёр» неразличимы — ровно тот случай, ради которого applied_migrations и заведён.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-17-work-schedule-reset') THEN
        UPDATE employees SET work_schedule = NULL;
        INSERT INTO applied_migrations (id) VALUES ('2026-08-17-work-schedule-reset');
    END IF;
END $$;

-- Разовое экранирование текста ВОЗРАЖЕНИЙ, сохранённого до К156.
--
-- До этой правки возражение было обычным текстом: сервер его не санитизировал,
-- клиент выводил через escapeHtml. Теперь у возражения тот же редактор и тот же
-- санитайзер, что у основного текста, и содержимое выводится РАЗМЕТКОЙ — значит
-- старые записи, в которых человек написал «< 3 млн» или «цена > рынка», должны
-- быть экранированы ровно так же, как их экранировал бы санитайзер
-- (escapeTextNode: только < и >, & намеренно не трогаем — иначе уже сохранённые
-- сущности задваивались бы при каждом повторном сохранении).
--
-- Замок ОБЯЗАТЕЛЕН и внешний: файл перечитывается при каждом старте сервера, и
-- без замка второй прогон превратил бы уже экранированное `&lt;` в `&amp;lt;`.
-- Изнутри таблицы «ещё не экранировано» и «человек написал &lt; руками»
-- неразличимы.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-21-escape-objection-content') THEN
        UPDATE script_nodes
           SET content = replace(replace(content, '<', '&lt;'), '>', '&gt;')
         WHERE node_type = 'objection'
           AND (content LIKE '%<%' OR content LIKE '%>%');
        INSERT INTO applied_migrations (id) VALUES ('2026-08-21-escape-objection-content');
    END IF;
END $$;
