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

-- Справочник статусов/этапов воронки лида (структура из CPA_воронка_новостройки_финал.docx).
--
-- ЗАКРЕПЛЕНЫ ЭТАПЫ, А НЕ СТРОКИ (часть 9, заход 4). Прежде здесь стояло
-- «фиксированный список, не редактируется через интерфейс» — это перестало быть
-- правдой: статус заводят, переименовывают, размечают и удаляют на вкладке
-- «Скрипты → Статусы воронки». Неизменным осталось разбиение на этапы: они
-- пришли из документа воронки, восьмого экран завести не даёт и перенести
-- статус между этапами тоже.
--
-- СИДИНГ ПОД ЗАМКОМ, А НЕ ПРОСТО ИДЕМПОТЕНТЕН (К227). `ON CONFLICT DO NOTHING`
-- защищает от повтора, но не от ПРАВКИ: удалённая строка возвращалась бы на
-- следующем перезапуске, а переименованная — воскресала бы РЯДОМ со своим новым
-- именем, двойником на том же месте по порядку. Замер: четыре перезапуска
-- подряд давали 51 строку вместо пятидесяти и два `sort_order` на одно место.
--
-- Прежний довод «перечень сидинга — тот минимум, на который опирается код» не
-- держится: сравнений по названию статуса в коде не осталось ни одного (заход 2
-- убрал `findNoAnswerStatusId`, заход 4 — вторую половину сторожа). Единственное,
-- на что код опирается, — что на нулевом этапе есть хотя бы один статус
-- (`leadDistribution.js`), и это защищено запретом на удаление последнего в
-- этапе, а не воскрешением: воскрешение сработало бы только при перезапуске, то
-- есть через часы после того, как очередь уже сломалась бы.
--
-- ⚠ НОВЫЕ СТРОКИ В ПЕРЕЧЕНЬ ПОСЛЕ ЭТОГО ПРИЕЗЖАЮТ ОТДЕЛЬНЫМ БЛОКОМ СО СВОИМ
-- ЗАМКОМ, как любая другая миграция. Дописанный в список ниже статус тихо не
-- доедет: замок уже стоит.
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

-- Сидинг справочника воронки. sort_order — отдельная нумерация с 1 внутри
-- каждого этапа, не сквозная по всей таблице.
--
-- ЗАМОК ВНЕШНИЙ, разбор у объявления таблицы выше. `ON CONFLICT DO NOTHING`
-- оставлен внутри: на боевой базе первый старт после выкатки поставит замок
-- вхолостую — все пятьдесят строк там уже есть, и конфликт не тронет ни одной.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-27-funnel-statuses-seed') THEN

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

    INSERT INTO applied_migrations (id) VALUES ('2026-08-27-funnel-statuses-seed');
    END IF;
END $$;

-- ============================================================
-- Матрица скриптов (оффер × статус воронки) + операторы many-to-many.
-- ============================================================

-- Статус "Новый" — присваивается лиду по умолчанию при загрузке базы (загрузка
-- лидов руководителем — отдельная будущая задача, здесь только сам статус).
-- stage_number = 0, чтобы сортировался раньше "Первичного контакта" (stage 1).
--
-- Свой замок, а не общий с перечнем выше (К227): блоки стоят в разных местах
-- файла и про разное, а замок именует ту правку, рядом с которой лежит.
-- ⚠ Переименовать этот статус человек вправе — код ищет его по НОМЕРУ ЭТАПА, не
-- по имени. Без замка переименование давало бы на нулевом этапе двойника, а
-- очередь выбирала бы из двух.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-27-funnel-status-new-seed') THEN

INSERT INTO lead_funnel_statuses (stage_number, stage_name, status_name, sort_order) VALUES
(0, 'Новый', 'Новый', 1)
ON CONFLICT (stage_number, status_name) DO NOTHING;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-27-funnel-status-new-seed');
    END IF;
END $$;

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
    lead_limit INTEGER
);

-- Класс объекта переехал с уровня оффера в строку сегмента (report_2026-08-01.md,
-- п.1, 07.08.2026): цена/площадь и так уже зависят от класса, логичнее задавать
-- вместе. Прежний общий obj_classes VARCHAR[] на real_estate_offers — удалён.
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS obj_classes;

-- «Время для перевода» снято насовсем — решение владельца 107 от 28.08.2026.
-- Поле было свободной строкой вроде «до 15 минут»: временем его не считать, и в
-- событие «Перевод» переносить было нечего — там своё поле в секундах у каждой
-- строки. ЗАМЕР НА БОЮ 27.08.2026: заполнено у 0 офферов из 39, то есть
-- удаление не потеряло ничего. С экрана и из ответа API поле ушло заходом 5,
-- исполняемого кода на колонку не осталось.
--
-- ЗАМКА НЕТ НАМЕРЕННО, и это образец отсюда же: `IF EXISTS` сам себе замок —
-- второй раз не делает ничего и не падает. Замок нужен там, где повтор изменил
-- бы данные (заполнение приоритета ниже); запись в `applied_migrations`, которая
-- ничего не сторожит, через год читается как имеющая смысл.
ALTER TABLE real_estate_offers DROP COLUMN IF EXISTS transfer_time;

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

-- Таблица замков объявлена ВЫШЕ, у первого сидинга (К227): справочник статусов
-- заводится в начале файла, и замок понадобился раньше, чем стояло это место.
-- Разбор, зачем она вообще, — там же.

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
-- одного лишнего пробела. Миграция ниже проставила их ОДИН раз по названиям —
-- тогда справочник ещё не правился ниоткуда.
--
-- ЧТО ИЗМЕНИЛОСЬ К ЧАСТИ 9. `requires_call_time` и `releases_lead` правит
-- владелец в окне статуса (заход 4): у нового статуса миграция про них ничего
-- не знает, и заводить статус, который нельзя настроить, хуже, чем дать две
-- галочки.
--
-- ⚠ `auto_recall` ЗАМОРОЖЕНА (заход 2). Список статусов для обзвона задаёт
-- событие «Автоперезвон», а не эта колонка: писать в неё больше некому — ни
-- маршрут заведения статуса, ни маршрут правки её не трогают. Она только
-- читается и доживает до отдельного слова владельца о снятии.
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

-- ---------------------------------------------------------------------------
-- ТЕЛЕФОНИЯ СОТРУДНИКА: добавочный, служебный идентификатор и пароль АТС
-- (задача «Звонки», часть 2; план Б5.1-Б5.3, паспорт Р4).
--
-- Три колонки, все необязательные: сотрудник без добавочного и без пароля —
-- нормальная полная карточка, звонит не каждый.
--
--   pbx_extension     — добавочный, который набирают. Только цифры, длину не
--                       ограничиваем: у разных станций она разная.
--   pbx_extension_id  — служебный идентификатор расширения в АТС. Человеку не
--                       показывается, нужен для обращений вида
--                       /extension/{id}/record/{uuid}/storage_url/.
--   pbx_password      — пароль АТС. Кто его знает, тот регистрирует телефон и
--                       звонит за счёт компании, поэтому наружу он не уходит
--                       вместе с карточкой (routes/employees.js).
--
-- Префикс pbx_, а не atc_: в схеме нет ни одной транслитерации, и провайдер
-- может смениться (решение куратора, dialog.md И13).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pbx_extension VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pbx_extension_id VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pbx_password VARCHAR;

-- УНИКАЛЬНОСТЬ ДОБАВОЧНОГО — В БАЗЕ, А НЕ ТОЛЬКО В ФОРМЕ. Два оператора с одним
-- добавочным означают звонки, ушедшие не туда, а форму можно обойти запросом.
--
-- Индекс ЧАСТИЧНЫЙ по двум условиям, и оба выбраны сознательно:
--
--   pbx_extension IS NOT NULL — пустых добавочных много и они не конфликтуют.
--       Именно поэтому пустое значение приходит сюда как NULL, а не как пустая
--       строка: две пустые строки столкнулись бы между собой, два NULL — нет.
--
--   status <> 'inactive'      — уход сотрудника в архив ОСВОБОЖДАЕТ номер, и
--       отдельного действия «освободить» не нужно (план Б5.1, паспорт Р4).
--       Взято <> 'inactive', а не = 'active': CHECK на статусе нет, значения
--       ничем не ограничены, и опечатка в статусе при = 'active' вывела бы
--       строку из-под индекса — двое получили бы один добавочный. При <>
--       'inactive' та же опечатка оставит номер занятым, то есть ошибётся в
--       безопасную сторону (dialog.md И17).
--
-- Следствие, принятое сознательно: возврат сотрудника из неактивных упадёт,
-- если его номер уже отдали другому. Текст ошибки объясняет, кто занял.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_pbx_extension
    ON employees (pbx_extension)
    WHERE pbx_extension IS NOT NULL AND status <> 'inactive';

-- ---------------------------------------------------------------------------
-- КЛЮЧ ТУННЕЛЯ У СОТРУДНИКА И ОДНОРАЗОВЫЕ ССЫЛКИ НА ВЫДАЧУ
-- (задача «Звонки», часть 1Б; бриф — часть 1Б, паспорт Р1Б).
--
-- ГЛАВНОЕ, ЧТО НАДО ПОНЯТЬ ПРО ЭТИ ТАБЛИЦЫ: ключ сам по себе не пропуск.
-- Чтобы человек попал в сеть, его ОТКРЫТЫЙ ключ должен лежать в списке
-- допущенных ([Peer]) на сервере туннеля, и вносится он туда руками. Пар
-- можно нагенерировать сколько угодно — без записи в тот список это
-- бесполезные байты. Значит здесь хранится не пропуск, а учёт: кому, когда,
-- на какой адрес и кем выдано.
--
-- ЗАКРЫТОГО КЛЮЧА ЗДЕСЬ НЕТ И БЫТЬ НЕ МОЖЕТ — ни в открытом виде, ни в
-- зашифрованном. Он рождается в момент открытия одноразовой ссылки, уходит
-- в ответ единственным показом и не сохраняется нигде (правило 1 брифа,
-- «нарушение обнуляет всю схему»).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tunnel_public_key VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tunnel_address VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tunnel_issued_at TIMESTAMP;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tunnel_issued_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tunnel_revoked_at TIMESTAMP;
-- Дата, когда пара РОДИЛАСЬ, то есть когда сотрудник открыл ссылку. Отдельно от
-- tunnel_issued_at, потому что это разные события и между ними проходят часы:
-- карточка показывает «Ссылка выдана ДД.ММ.ГГГГ» до открытия и «Ключ получен
-- ДД.ММ.ГГГГ» после (паспорт Р1Б, редакция 3, состояния 4 и 5). Одной датой
-- обойтись нельзя — она отвечала бы на два разных вопроса сразу.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tunnel_key_at TIMESTAMP;

-- tunnel_public_key заполняется НЕ в момент выдачи ссылки, а в момент её
-- открытия: пара рождается там же, где показывается. Пока ссылку не открыли,
-- адрес и дата уже есть, а открытого ключа ещё нет — и это не полусостояние
-- ошибки, а честная запись: вносить в список допущенных пока нечего.
--
-- tunnel_revoked_at ставится при уходе сотрудника в архив и при перевыпуске.
-- Ключ считается действующим, только когда адрес выдан и отзыва не было; на
-- этом же условии стоит частичный индекс ниже.

-- УНИКАЛЬНОСТЬ АДРЕСА В ПОДСЕТИ — В БАЗЕ, А НЕ В КОДЕ РАСПРЕДЕЛИТЕЛЯ.
-- Два человека с одним адресом означают, что второй не подключится вовсе, а
-- разбираться придётся на сервере туннеля. Проверка «свободен ли адрес» и
-- вставка идут разными запросами, и между ними успевает вклиниться вторая
-- выдача — полагаться можно только на индекс.
--
-- Условие ровно то же, что у добавочного (idx_employees_pbx_extension):
-- отозванный ключ адрес ОСВОБОЖДАЕТ, отдельного действия «освободить» нет.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_tunnel_address
    ON employees (tunnel_address)
    WHERE tunnel_address IS NOT NULL AND tunnel_revoked_at IS NULL;

-- ОДНОРАЗОВЫЕ ССЫЛКИ. Хранится ХЕШ токена, а не сам токен: утечка этой
-- таблицы тогда не даёт ни одной рабочей ссылки. Токен существует ровно в
-- одном месте — в ссылке, которую руководитель отдал сотруднику.
CREATE TABLE IF NOT EXISTS tunnel_key_tokens (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- sha256 в hex. UNIQUE — не украшение: одинаковый хеш означал бы две
    -- ссылки на один секрет, и «сгорела» бы только одна из них.
    token_hash VARCHAR NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    expires_at TIMESTAMP NOT NULL,
    -- Отметка «ссылку открыли». Именно она отличает мёртвое состояние
    -- «уже забирали» (возможен перехват, человека надо подтолкнуть сказать)
    -- от «срок истёк» (бытовая ситуация). Одна заглушка на оба случая стёрла
    -- бы единственный признак утечки, который у нас есть.
    used_at TIMESTAMP,
    -- Перевыпуск гасит прежние ссылки того же сотрудника, не дожидаясь срока:
    -- «прежний ключ перестанет работать сразу» — обещание окна подтверждения.
    revoked_at TIMESTAMP
);

-- Поиск идёт всегда по хешу токена (UNIQUE-индекс уже есть) и по сотруднику —
-- при перевыпуске, когда прежние ссылки надо погасить разом.
CREATE INDEX IF NOT EXISTS idx_tunnel_key_tokens_employee
    ON tunnel_key_tokens (employee_id);

-- ===========================================================================
-- АУДИТ ИЗМЕНЕНИЙ (задача «Звонки», часть 3; план раздел 10, пункты Б2.1–Б2.12)
--
-- ПОЧЕМУ ТРИГГЕРЫ, А НЕ ЗАПИСЬ ИЗ КОДА. Мест, где проект меняет данные, около
-- девяноста в восемнадцати файлах; только у лидов их десять. Часть неизбежно
-- забудут — и получится журнал с дырами, которому при этом верят. Это хуже,
-- чем никакого. Триггер обойти нельзя: правка прямым запросом в базу мимо CRM
-- тоже попадёт в журнал, а новая таблица подключается сама (см. конец файла).
--
-- ЧЕГО ЭТОТ ЖУРНАЛ НЕ ДЕЛАЕТ. Он не доказывает, КТО изменил. Входа в систему в
-- проекте нет: админка никого не спрашивает, оператор прикладывает свой номер
-- к запросу, и сервер верит на слово. Поэтому автор записывается как «кем
-- назвался браузер», и в интерфейсе так и пишется. Обвинять человека на
-- основании этого журнала нельзя, пока не появится настоящий вход
-- (решение владельца, план 10.3).
--
-- ЖУРНАЛ — ХРАНИЛИЩЕ ПЕРСОНАЛЬНЫХ ДАННЫХ НАРАВНЕ С САМОЙ БАЗОЙ. Урезать лиды
-- бессмысленно: ради них аудит и затевается. Обращаться с ним надо так же, как
-- с базой (Б2.12).
-- ===========================================================================

-- ----- Настройки приложения ------------------------------------------------
-- Таблицу планировала часть 6, но части 3 она нужна раньше: журналу нужна дата
-- включения, и она обязана лежать в настройке. Минимальная дата в самом журнале
-- не годится — чистили журнал, и она соврёт (решение куратора, ответ 2 по Р5).
-- Временный дом для одной строки — лишний переезд, поэтому таблица заводится
-- здесь, а часть 6 наполняет её тумблерами и порогами.
CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Дата включения журнала. Ставится ОДИН РАЗ, при первом старте с аудитом, и
-- дальше не трогается: по ней пустая вкладка в карточке говорит «до такого-то
-- числа мы не записывали», а не «эту запись никто не менял». Без неё журнал
-- врёт в самом чувствительном месте — там, где по нему судят о человеке.
INSERT INTO app_settings (key, value)
VALUES ('audit_started_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS'))
ON CONFLICT (key) DO NOTHING;

-- ----- Настройки: то, чем живёт экран (часть 6, В4) -------------------------
-- Трёх колонок хватало ОДНОЙ строке, которую завела часть 3. Экрану настроек
-- (паспорт Р8) мало, и всё недостающее — ДАННЫЕ, а не вёрстка: описание, которое
-- правится без выкатки; тип, по которому экран отличает выключатель от числа;
-- единица, без которой «4» ничего не значит; группа с порядком, иначе дата
-- включения журнала встанет рядом с рубильником автообзвона.
--
-- Заводятся ВСЕ СРАЗУ, а не по мере надобности (ответ куратора И121): половина
-- колонок означала бы вторую миграцию по той же таблице, а этот файл
-- перечитывается при каждом старте — каждая лишняя миграция это лишний риск.
--
-- ИМЯ НАСТРОЙКИ — НАХОДКА, А НЕ САМОДЕЯТЕЛЬНОСТЬ. Паспорт перечисляет четыре
-- недостающие вещи и два признака, но сам же требует в строке ДВА текста:
-- `.set-row__name` («человеческое имя настройки — данные») и `.set-row__desc`.
-- Имени в его перечне нет — оно потерялось. Заводится здесь по тому же доводу,
-- по которому заводятся остальные: вторая миграция по этой таблице дороже
-- одной лишней колонки. Имя колонки моё, поправить его дешевле всего сейчас.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS title VARCHAR;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS description TEXT;

-- ТИП ЗНАЧЕНИЯ — ИЗ ШЕСТИ, И ИМЕНА ЗДЕСЬ ПОЛНЫЕ. Паспорт называет типы
-- по-русски: выключатель · число · процент · окно времени · строка · дата.
-- Машинные имена — 'switch', 'number', 'percent', 'time_range', 'text', 'date'.
-- «Дата, только чтение» отдельным типом не заводится: только чтение — признак
-- строки (is_readonly), ровно как опасность, и держать один и тот же смысл в
-- двух местах значит однажды их рассогласовать.
--
-- ВЫКЛЮЧАТЕЛЬ ПИШЕТСЯ СЛОВАМИ 'true' / 'false' и никак иначе (ответ куратора
-- И142). Соглашение на все будущие выключатели: одно написание в базе, в ответе
-- API и в журнале изменений вместо трёх.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS value_type VARCHAR;

-- Единица — данные, а не подпись в разметке: список «этот ключ в часах, тот в
-- месяцах», зашитый в экран, разойдётся с таблицей на второй новой настройке.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS unit VARCHAR;

-- ГРУППА ХРАНИТ СВОЙ ЗАГОЛОВОК, А НЕ СЛОВО-ЯРЛЫК. Паспорт требует, чтобы
-- заголовок группы приходил с сервера как данные; отдельной колонки под него
-- куратор не называл, значит его несёт сам `group_key`. Иначе экрану
-- понадобилась бы таблица «ярлык → заголовок» в коде — то самое, от чего этот
-- набор колонок и уводит.
--
-- `group_order` — место строки в СПЛОШНОМ списке, а не внутри группы: тогда и
-- порядок групп выходит сам, без второй колонки на него. Шаг десять — чтобы
-- вставка между двумя не перенумеровывала всё (правило куратора по Р6-8).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS group_key VARCHAR;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS group_order INTEGER;

-- Два признака строки. Оба — данные, и оба по одной причине: список ключей,
-- зашитый в разметку, разъедется с таблицей на второй же новой настройке.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS is_readonly BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS is_dangerous BOOLEAN NOT NULL DEFAULT false;

-- Умолчание из кода — чтобы подсказка «работает умолчание из кода» могла
-- назвать значение, а не отделаться общими словами.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS default_value TEXT;

-- ----- Настройки: засев ------------------------------------------------------
-- ЗАСЕВАЮТСЯ ТОЛЬКО ТЕ СТРОКИ, У КОТОРЫХ ЕСТЬ ЧИТАТЕЛЬ (ответ куратора И122).
-- Сегодня их две: дата включения журнала (её читает вкладка истории) и
-- рубильник автообзвона. Остальные девять настроек паспорта придут со своими
-- частями: настройка, которая ничего не меняет, ХУЖЕ её отсутствия — по ней
-- принимают решения.
--
-- ОПИСАНИЕ ИДЁТ ИЗ КОДА, ЗНАЧЕНИЕ ЖИВЁТ В БАЗЕ. Поэтому метаданные
-- обновляются БЕЗУСЛОВНО при каждом старте, а `value` в этих UPDATE не
-- упоминается вовсе: поправить описание правкой файла нужно, а вернуть человеку
-- выключенный им тумблер — нельзя.
UPDATE app_settings SET
    title = 'Журнал ведётся с',
    description = 'Дата, с которой пишется история изменений. Ставится один раз при первом запуске с аудитом и дальше не меняется.',
    value_type = 'date',
    unit = NULL,
    group_key = 'Журнал и хранение',
    group_order = 100,
    is_readonly = true,
    is_dangerous = false,
    default_value = NULL
 WHERE key = 'audit_started_at';

-- РУБИЛЬНИК АВТООБЗВОНА. Строка засевается со значением 'false', а не
-- отсутствием строки (ответ куратора И144): отсутствие ключа означает «настройки
-- нет» — экран её просто не покажет, и правило «свежая выкатка сама никому не
-- звонит» держалось бы на пустоте вместо значения.
--
-- Читателя у него сегодня нет: автообзвон появится вместе с телефонией. Строка
-- заводится раньше читателя намеренно — она и есть та защита, которая должна
-- стоять ДО первого звонка, а не появиться вместе с ним.
INSERT INTO app_settings (key, value)
VALUES ('autodial_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

UPDATE app_settings SET
    title = 'Автообзвон',
    description = 'Разрешает системе звонить лидам самой, без участия оператора. Пока выключен — набор идёт только по нажатию человека.',
    value_type = 'switch',
    unit = NULL,
    group_key = 'Автообзвон',
    group_order = 10,
    is_readonly = false,
    is_dangerous = true,
    default_value = 'false'
 WHERE key = 'autodial_enabled';

-- ----- Реестр замков pg_try_advisory_lock (часть 6) --------------------------
-- Число замка — не случайное и не «любое свободное». Два разных механизма,
-- взявшие одно число, молча заблокируют друг друга: ошибки не будет, записи в
-- журнале не будет, будет один из них, который иногда не работает. Искать такое
-- нечем — в базе замок виден числом, и что это за число, знает только код.
--
-- Поэтому реестр живёт здесь, рядом со схемой, а не в комментарии у кода:
-- schema.sql читают все, кто заводит что-то новое в базе.
--
-- НОВЫЙ ЗАМОК ДОПИСЫВАЕТСЯ СЮДА, а не берётся из головы.
--
--   4826115501 — планировщик приложения (часть 6, services/scheduler.js).
--                Один тик на всю установку: лишний экземпляр молча простаивает.
--
-- Замки СЕССИОННЫЕ: снимаются либо явным pg_advisory_unlock, либо разрывом
-- соединения. Это и есть защита от повисшего замка после падения процесса.

-- ----- Правила: что писать, а что только отмечать --------------------------
-- ОТДЕЛЬНОЙ ТАБЛИЦЕЙ, А НЕ КОНСТАНТОЙ В ТРИГГЕРЕ (Б2.4): уточнение списка не
-- должно быть переделкой кода и миграцией. Правила нет — значит «пишем всё»:
-- умолчание выбрано в сторону полноты, потому что забытое правило должно
-- давать лишнюю запись, а не молчаливую дыру.
--
-- Строка с column_name = '*' говорит не про колонку, а про саму таблицу: как
-- назвать запись и чью карточку открывать, если своей у неё нет.
CREATE TABLE IF NOT EXISTS audit_rules (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR NOT NULL,
    column_name VARCHAR NOT NULL,
    -- full — пишем значения; masked — «…4417 → …8802»; fact — только факт
    -- изменения, значения нет. Для строки '*' не заполняется.
    level VARCHAR,
    -- Чем назвать запись в журнале. Список колонок через пробел: они берутся из
    -- самой строки, без единого лишнего запроса. Только для строки '*'.
    title_columns VARCHAR,
    -- Колонка первичного ключа. У шести связочных таблиц своего id нет вовсе
    -- (lead_offers, source_cpa_networks и другие), и угадывать его нельзя.
    key_column VARCHAR,
    -- Своей карточки у таблицы нет — открывать чужую. card_column указывает,
    -- через какую колонку до неё добираться. Только для строки '*'.
    card_table VARCHAR,
    card_column VARCHAR,
    UNIQUE (table_name, column_name)
);

-- ----- Карта расшифровки ссылок --------------------------------------------
-- «Статус: 3 → 7» человеку не говорит ничего; нужно «Новый → Перезвон» (Б2.9).
-- Таблицей по той же причине, что и правила: добавить справочник не должно
-- означать правку кода (решение куратора, ответ 3 по Р5).
CREATE TABLE IF NOT EXISTS audit_ref_map (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR NOT NULL,
    column_name VARCHAR NOT NULL,
    ref_table VARCHAR NOT NULL,
    -- Колонки имени через пробел — так же, как title_columns выше.
    ref_title_columns VARCHAR NOT NULL,
    UNIQUE (table_name, column_name)
);

-- ----- Партии массовых операций --------------------------------------------
-- Одно действие человека обязано читаться как ОДНО, а не как пять тысяч (Б2.10).
-- Импорт, раздача и разовые миграции заводят здесь строку и кладут её
-- идентификатор в настройку соединения; триггер проставляет его каждой записи.
--
-- Имя файла живёт здесь, а не в пяти тысячах строк журнала: «какой файл залили»
-- — первый вопрос при разборе неудачной загрузки (ответ 5 по Р5).
CREATE TABLE IF NOT EXISTS audit_batches (
    id UUID PRIMARY KEY,
    kind VARCHAR NOT NULL,
    title VARCHAR,
    file_name VARCHAR,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    actor_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    actor_kind VARCHAR,
    actor_name VARCHAR,
    page VARCHAR
);

-- ----- Сам журнал ----------------------------------------------------------
-- ОДНА СТРОКА НА ИЗМЕНЁННУЮ ЗАПИСЬ, внутри — только изменившиеся поля (Б2.2).
-- Импорт пяти тысяч лидов по двадцать полей даёт пять тысяч строк, а не сто
-- тысяч.
--
-- ПОМЕСЯЧНЫЕ ПОЛКИ ЗАЛОЖЕНЫ СРАЗУ, хотя удалять мы ничего не собираемся
-- (хранение бессрочное, решение владельца п. 37). Причина не в удалении:
-- аудит станет самой большой таблицей базы, крупнее лидов и звонков вместе, и
-- без полок через год любая работа с ней — проверка, перенос, разбор — станет
-- неподъёмной, а переделывать будет поздно (Б2.11).
--
-- Ключ составной (id, changed_at) — иначе нельзя: у секционированной таблицы
-- ключ обязан содержать колонку секционирования.
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL,
    changed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    -- insert · update · delete. Седьмое поле, добавленное по замечанию
    -- дизайн-сессии: без него создание неотличимо от правки, а удаление
    -- выглядит как обнуление всех полей разом. Триггеру оно известно даром.
    op VARCHAR NOT NULL,
    table_name VARCHAR NOT NULL,
    record_id VARCHAR,
    -- Снимок имени записи на момент изменения. Именно снимок: запись могут
    -- удалить, и тогда назвать её будет нечем — а журнал обязан оставаться
    -- читаемым сам по себе.
    record_title VARCHAR,
    -- «Кем назвался браузер». actor_kind: browser — назвался и мы записали его
    -- слова; none — назваться было некому (админка без входа); service —
    -- импорт, раздача, миграция. Путать первое со вторым нельзя: написать
    -- «указан браузером» там, где никто не назывался, значит придать журналу
    -- достоверность, которой у него нет.
    actor_employee_id INTEGER,
    actor_kind VARCHAR NOT NULL DEFAULT 'none',
    actor_name VARCHAR,
    -- Ключ раздела оболочки, страница оператора или имя служебной операции.
    page VARCHAR,
    batch_id UUID,
    -- МАССИВ, А НЕ ОБЪЕКТ, и это не вкусовщина: порядок полей внутри записи
    -- обязан совпадать с порядком в её карточке — человек ищет поле по
    -- знакомому месту. jsonb сортирует ключи объекта и порядок теряет, а
    -- порядок элементов массива сохраняет. Массив собирается обходом to_json
    -- строки, который идёт по колонкам таблицы.
    --
    -- Элемент: { field, level, before, after, beforeTitle, afterTitle }.
    -- У уровня fact значений нет вовсе, у masked они обрезаны до хвоста.
    changes JSONB NOT NULL,
    PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

-- Отбор в журнале идёт по времени (единственная сортировка раздела), по записи
-- (вкладка в карточке лида и сотрудника) и по партии (кнопка «Показать записи
-- партии»).
CREATE INDEX IF NOT EXISTS idx_audit_log_changed_at ON audit_log (changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_record ON audit_log (table_name, record_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_batch ON audit_log (batch_id) WHERE batch_id IS NOT NULL;

-- Полки на год вперёд и на месяц назад, идемпотентно. Прогоняется при каждом
-- старте сервера — значит горизонт отодвигается сам.
--
-- ПОЧЕМУ НЕТ ПОЛКИ «ПО УМОЛЧАНИЮ». Она приняла бы запись за пределами
-- горизонта и тем самым запретила бы завести полку на этот месяц потом: старт
-- сервера падал бы, и чинить пришлось бы руками на бою. Без неё запись за
-- горизонтом отобьётся ошибкой — а горизонт в год при том, что деплой
-- перезапускает сервер, недостижим на практике.
DO $$
DECLARE
    v_start date;
    v_month date;
    v_name text;
BEGIN
    v_start := date_trunc('month', NOW())::date - INTERVAL '1 month';
    FOR i IN 0..13 LOOP
        v_month := (v_start + (i || ' month')::interval)::date;
        v_name := 'audit_log_' || to_char(v_month, 'YYYY_MM');
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
                v_name, v_month, (v_month + INTERVAL '1 month')::date);
        END IF;
    END LOOP;
END $$;

-- ----- Две вспомогательные функции ------------------------------------------

-- Маскировка: «…4417». Видно, что менялось и на другое ли, самого реквизита в
-- журнале нет. Короткое значение отдаётся одним многоточием — обрезать нечего,
-- а показать четыре знака из четырёх значит не замаскировать ничего.
CREATE OR REPLACE FUNCTION audit_mask(v text) RETURNS text AS $$
    SELECT CASE
        WHEN v IS NULL THEN NULL
        WHEN length(v) <= 4 THEN '…'
        ELSE '…' || right(v, 4)
    END;
$$ LANGUAGE sql IMMUTABLE;

-- Имя записи справочника по её идентификатору: «3» превращается в «Новый».
-- Имена колонок приходят из audit_ref_map и прогоняются через quote_ident — в
-- выражение попадает только то, что является именем колонки.
CREATE OR REPLACE FUNCTION audit_ref_title(p_table text, p_columns text, p_id text)
RETURNS text AS $$
DECLARE
    v_cols text;
    v_title text;
BEGIN
    IF p_id IS NULL OR p_id !~ '^\d+$' THEN RETURN NULL; END IF;
    SELECT string_agg(quote_ident(c), ', ') INTO v_cols
      FROM unnest(string_to_array(p_columns, ' ')) AS c;
    EXECUTE format('SELECT concat_ws('' '', %s) FROM %I WHERE id = $1', v_cols, p_table)
       INTO v_title USING p_id::int;
    RETURN NULLIF(v_title, '');
EXCEPTION WHEN OTHERS THEN
    -- Справочник могли переименовать или колонка исчезла. Журнал от этого
    -- ломаться не должен: запись уйдёт без расшифровки, но уйдёт.
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ----- Сам триггер ---------------------------------------------------------
-- Пишет ОДНУ строку на изменённую запись. Внутри — только те поля, что реально
-- изменились: у обновления сравниваются старое и новое значение, совпавшие в
-- журнал не попадают вовсе.
--
-- ЧИТАЕТ НАСТРОЙКИ СОЕДИНЕНИЯ, а не выдумывает автора. Приложение кладёт в них
-- то, чем назвался браузер (services/auditContext.js); правка прямым запросом в
-- базу настроек не ставит — и запись честно получает «назваться было некому».
--
-- ПАДЕНИЕ ЭТОГО ТРИГГЕРА РОНЯЕТ ДЕЙСТВИЕ ЧЕЛОВЕКА, и это выбрано сознательно:
-- журнал с молчаливыми дырами хуже, чем отказ, который видно сразу.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger AS $audit$
DECLARE
    v_row json;
    v_new json;
    v_old json;
    v_levels jsonb;
    v_refs jsonb;
    v_meta record;
    v_field record;
    v_before text;
    v_after text;
    v_level text;
    v_changes jsonb := '[]'::jsonb;
    v_item jsonb;
    v_ref jsonb;
    v_title text;
    v_key_column text;
    v_record_id text;
    v_record_title text;
    v_actor_id text;
    v_batch text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_old := to_json(OLD);
        v_row := v_old;
    ELSIF TG_OP = 'INSERT' THEN
        v_new := to_json(NEW);
        v_row := v_new;
    ELSE
        v_new := to_json(NEW);
        v_old := to_json(OLD);
        v_row := v_new;
    END IF;

    -- Правила и карта расшифровки берутся ОДНИМ запросом на строку, а не одним
    -- на колонку: у лида два десятка полей, и разница вышла бы двадцатикратной
    -- на каждой вставке.
    SELECT jsonb_object_agg(column_name, level)
      INTO v_levels
      FROM audit_rules
     WHERE table_name = TG_TABLE_NAME AND column_name <> '*' AND level IS NOT NULL;

    SELECT jsonb_object_agg(column_name, jsonb_build_object('t', ref_table, 'c', ref_title_columns))
      INTO v_refs
      FROM audit_ref_map
     WHERE table_name = TG_TABLE_NAME;

    SELECT title_columns, key_column
      INTO v_meta
      FROM audit_rules
     WHERE table_name = TG_TABLE_NAME AND column_name = '*';

    -- Чем назвать запись. Колонки берутся из самой строки — ни одного лишнего
    -- запроса, и имя остаётся верным даже после удаления записи.
    IF v_meta.title_columns IS NOT NULL THEN
        SELECT string_agg(NULLIF(v_row ->> c, ''), ' ')
          INTO v_record_title
          FROM unnest(string_to_array(v_meta.title_columns, ' ')) AS c;
    END IF;

    -- Ключ записи. У связочных таблиц своего id нет вовсе, поэтому колонка
    -- ключа задаётся правилом, а не угадывается.
    v_key_column := COALESCE(v_meta.key_column, 'id');
    v_record_id := v_row ->> v_key_column;

    FOR v_field IN SELECT key, value FROM json_each_text(v_row) LOOP
        IF TG_OP = 'UPDATE' THEN
            v_before := v_old ->> v_field.key;
            v_after := v_new ->> v_field.key;
            CONTINUE WHEN v_before IS NOT DISTINCT FROM v_after;
        ELSIF TG_OP = 'INSERT' THEN
            v_before := NULL;
            v_after := v_field.value;
            -- Пустое поле новой записи в журнал не идёт: строка «поле: пусто →
            -- пусто» не сообщает ничего, а полей у лида два десятка.
            CONTINUE WHEN v_after IS NULL;
        ELSE
            v_before := v_field.value;
            v_after := NULL;
            CONTINUE WHEN v_before IS NULL;
        END IF;

        v_level := COALESCE(v_levels ->> v_field.key, 'full');

        -- ЧЕТВЁРТЫЙ УРОВЕНЬ: 'skip' — не писать вовсе (решение владельца 101).
        --
        -- Три прежних уровня отвечают на вопрос «сколько от значения показать»:
        -- всё, хвост, ничего. Четвёртый отвечает на другой — «а надо ли вообще».
        -- Он нужен колонкам, которые журнал уже знает из самого себя: `updated_at`
        -- совпадает с колонкой `changed_at` этой же строки до секунды (код пишет
        -- NOW() тем же действием, которое ловит триггер), а прежнее её значение —
        -- время предыдущей правки той же записи, то есть строка журнала выше.
        --
        -- ПРОПУСК ИДЁТ ДО СБОРКИ ЭЛЕМЕНТА, а не после: иначе в массиве осталась бы
        -- дыра, а в записи — поле без значения, и экран показал бы «изменено,
        -- значение не записано» там, где записывать было нечего.
        --
        -- ЗАПИСЬ ЦЕЛИКОМ НЕ ПРОПАДАЕТ. Пропускается поле, а не строка: правка,
        -- в которой изменилась только пропускаемая колонка, даст пустой массив
        -- изменений — и такая строка в журнал не пойдёт (проверка ниже, там же,
        -- где отсекается «изменилось ничего»).
        CONTINUE WHEN v_level = 'skip';

        v_item := jsonb_build_object('field', v_field.key, 'level', v_level);

        IF v_level = 'fact' THEN
            -- Значения нет вовсе: пароль, пароль АТС, скан документа, шапка
            -- бланка. Факт изменения при этом записан — иначе появится дыра.
            NULL;
        ELSIF v_level = 'masked' THEN
            v_item := v_item
                || jsonb_build_object('before', audit_mask(v_before), 'after', audit_mask(v_after));
        ELSE
            v_item := v_item || jsonb_build_object('before', v_before, 'after', v_after);
            -- Расшифровка ссылки: «3 → 7» превращается в «Новый → Перезвон».
            -- Имя кладётся РЯДОМ со значением, а не вместо него: справочник
            -- могут переименовать, и журнал обязан помнить и то, и другое.
            IF v_refs IS NOT NULL AND v_refs ? v_field.key THEN
                v_ref := v_refs -> v_field.key;
                v_title := audit_ref_title(v_ref ->> 't', v_ref ->> 'c', v_before);
                IF v_title IS NOT NULL THEN
                    v_item := v_item || jsonb_build_object('beforeTitle', v_title);
                END IF;
                v_title := audit_ref_title(v_ref ->> 't', v_ref ->> 'c', v_after);
                IF v_title IS NOT NULL THEN
                    v_item := v_item || jsonb_build_object('afterTitle', v_title);
                END IF;
            END IF;
        END IF;

        v_changes := v_changes || v_item;
    END LOOP;

    -- Обновление, которое ничего не изменило, записи не даёт: массовое
    -- «перевести в неактивные» по уже неактивным иначе засыпало бы журнал
    -- строками без единого отличия.
    IF jsonb_array_length(v_changes) = 0 THEN
        RETURN NULL;
    END IF;

    v_actor_id := NULLIF(current_setting('crm.audit_actor_id', true), '');
    v_batch := NULLIF(current_setting('crm.audit_batch', true), '');

    INSERT INTO audit_log (
        op, table_name, record_id, record_title,
        actor_employee_id, actor_kind, actor_name, page, batch_id, changes
    ) VALUES (
        lower(TG_OP), TG_TABLE_NAME, v_record_id, v_record_title,
        CASE WHEN v_actor_id ~ '^\d+$' THEN v_actor_id::int ELSE NULL END,
        COALESCE(NULLIF(current_setting('crm.audit_actor_kind', true), ''), 'none'),
        NULLIF(current_setting('crm.audit_actor_name', true), ''),
        NULLIF(current_setting('crm.audit_page', true), ''),
        CASE WHEN v_batch ~ '^[0-9a-fA-F-]{36}$' THEN v_batch::uuid ELSE NULL END,
        v_changes
    );

    RETURN NULL;
END;
$audit$ LANGUAGE plpgsql;

-- ----- Наполнение правил и карты --------------------------------------------
-- ПОД ЗАМКОМ applied_migrations, а не «вставить, если нет». Обе таблицы —
-- рабочий инструмент: список исключений будут уточнять, и снятое человеком
-- правило не должно воскресать при каждом старте сервера. Изнутри таблицы
-- «правила ещё не заводили» и «правило сняли осознанно» неразличимы, поэтому
-- замок внешний — ровно тот же приём, что у экранирования возражений выше.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-24-audit-rules-seed') THEN

    -- Правила о самих таблицах: чем назвать запись, где её ключ и чью карточку
    -- открывать, если своей у таблицы нет. Список составлен по всем 37 внешним
    -- ключам базы (тот же перечень нужен части 5).
    INSERT INTO audit_rules (table_name, column_name, title_columns, key_column, card_table, card_column) VALUES
        ('employees',                        '*', 'last_name first_name middle_name', 'id',          NULL,                 NULL),
        ('leads',                            '*', 'last_name first_name phone',       'id',          NULL,                 NULL),
        ('organizations',                    '*', 'name',                             'id',          NULL,                 NULL),
        ('organization_bank_accounts',       '*', 'bank_name',                        'id',          'organizations',      'organization_id'),
        ('organization_taxes',               '*', 'tax_type',                         'id',          'organizations',      'organization_id'),
        ('departments',                      '*', 'name',                             'id',          'organizations',      'organization_id'),
        ('cpa_networks',                     '*', 'name',                             'id',          NULL,                 NULL),
        ('sources',                          '*', 'lead_source city_region',          'id',          NULL,                 NULL),
        ('ad_platforms',                     '*', 'name',                             'id',          NULL,                 NULL),
        ('source_cpa_networks',              '*', NULL,                               'source_id',   'sources',            'source_id'),
        ('real_estate_offers',               '*', 'name',                             'id',          NULL,                 NULL),
        ('real_estate_offer_geo',            '*', 'city',                             'id',          'real_estate_offers', 'offer_id'),
        ('real_estate_offer_segments',       '*', 'label',                            'id',          'real_estate_offers', 'offer_id'),
        ('real_estate_offer_payment_methods','*', 'value',                            'id',          'real_estate_offers', 'offer_id'),
        ('real_estate_offer_mortgage_types', '*', 'value',                            'id',          'real_estate_offers', 'offer_id'),
        ('offers',                           '*', 'name',                             'id',          NULL,                 NULL),
        ('lead_offers',                      '*', NULL,                               'lead_id',     'leads',              'lead_id'),
        ('lead_script_statuses',             '*', NULL,                               'lead_id',     'leads',              'lead_id'),
        ('lead_distribution_pool',           '*', NULL,                               'lead_id',     'leads',              'lead_id'),
        ('lead_funnel_statuses',             '*', 'stage_name status_name',           'id',          NULL,                 NULL),
        ('scripts',                          '*', 'title',                            'id',          NULL,                 NULL),
        ('script_nodes',                     '*', 'label',                            'id',          'scripts',            'script_id'),
        ('knowledge_articles',               '*', 'title',                            'id',          NULL,                 NULL),
        ('knowledge_article_attachments',    '*', 'file_name',                        'id',          'knowledge_articles', 'article_id'),
        ('knowledge_article_visibility',     '*', NULL,                               'article_id',  'knowledge_articles', 'article_id'),
        ('employee_documents',               '*', 'file_name',                        'id',          'employees',          'employee_id'),
        ('employee_schedule_days',           '*', 'day',                              'id',          'employees',          'employee_id'),
        ('employee_state_intervals',         '*', 'state',                            'id',          'employees',          'employee_id'),
        ('employee_column_settings',         '*', NULL,                               'employee_id', 'employees',          'employee_id'),
        ('tunnel_key_tokens',                '*', NULL,                               'id',          'employees',          'employee_id'),
        ('param_lists',                      '*', 'list_key value',                   'id',          NULL,                 NULL),
        ('app_settings',                     '*', 'key',                              'key',         NULL,                 NULL),
        ('audit_rules',                      '*', 'table_name column_name',           'id',          NULL,                 NULL),
        ('audit_ref_map',                    '*', 'table_name column_name',           'id',          NULL,                 NULL);

    -- УРОВЕНЬ «ТОЛЬКО ФАКТ» — здесь не приватность, а работоспособность.
    -- Скан документа на 2 МБ превращается в ~2,7 МБ текста и записался бы
    -- ДВАЖДЫ, до и после. Без этих шести строк журнал за месяц стал бы больше
    -- самой базы: файлы в этом проекте лежат в базе целиком.
    INSERT INTO audit_rules (table_name, column_name, level) VALUES
        ('employees',                     'password',             'fact'),
        ('employees',                     'pbx_password',         'fact'),
        ('employee_documents',            'file_data',            'fact'),
        ('knowledge_article_attachments', 'file_data',            'fact'),
        ('organizations',                 'letterhead_header',    'fact'),
        ('organizations',                 'letterhead_signature', 'fact'),

    -- «Только факт» для текстовых персональных: маскировать бессмысленно,
    -- значение не пишем.
        ('employees',                     'issued_by',            'fact'),
        ('employees',                     'issue_date',           'fact'),
        ('employees',                     'registration',         'fact'),
        ('organizations',                 'legal_address',        'fact'),
        ('organizations',                 'actual_address',       'fact'),

    -- УРОВЕНЬ «МАСКИРОВАННО» — решение владельца. Пишется как «…4417 → …8802»:
    -- видно, что менялось и на другое ли, самих реквизитов в журнале нет.
        ('employees',                     'passport_series',      'masked'),
        ('employees',                     'passport_number',      'masked'),
        ('employees',                     'inn',                  'masked'),
        ('employees',                     'bank',                 'masked'),
        ('employees',                     'account',              'masked'),
        ('organization_bank_accounts',    'checking_account',     'masked'),
        ('organization_bank_accounts',    'correspondent_account','masked'),
        ('organization_bank_accounts',    'bik',                  'masked'),
        ('organizations',                 'inn',                  'masked'),
        ('organizations',                 'kpp',                  'masked'),
        ('organizations',                 'ogrn',                 'masked');

    -- ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Контакты сотрудника (phone, email, whatsapp,
    -- telegram) пишутся ПОЛНОСТЬЮ: их подмена — как раз то, что аудит должен
    -- ловить. Лиды тоже целиком, включая имя, телефон и комментарий: ради них
    -- аудит и затевается. Оговорка при этом остаётся в силе — журнал становится
    -- хранилищем персональных данных наравне с базой.

    -- Карта расшифровки ссылок. «Статус: 3 → 7» человеку не говорит ничего.
    INSERT INTO audit_ref_map (table_name, column_name, ref_table, ref_title_columns) VALUES
        ('leads',                        'funnel_status_id',   'lead_funnel_statuses', 'status_name'),
        ('leads',                        'employee_id',        'employees',            'last_name first_name'),
        ('leads',                        'source_id',          'sources',              'lead_source city_region'),
        ('leads',                        'script_id',          'scripts',              'title'),
        ('leads',                        'repeat_script_id',   'scripts',              'title'),
        ('employees',                    'manager_id',         'employees',            'last_name first_name'),
        ('employees',                    'tunnel_issued_by',   'employees',            'last_name first_name'),
        ('sources',                      'platform_id',        'ad_platforms',         'name'),
        ('real_estate_offers',           'network_id',         'cpa_networks',         'name'),
        ('cpa_networks',                 'organization_id',    'organizations',        'name'),
        ('departments',                  'organization_id',    'organizations',        'name'),
        ('organization_bank_accounts',   'organization_id',    'organizations',        'name'),
        ('organization_taxes',           'organization_id',    'organizations',        'name'),
        ('source_cpa_networks',          'source_id',          'sources',              'lead_source city_region'),
        ('source_cpa_networks',          'cpa_network_id',     'cpa_networks',         'name'),
        ('lead_offers',                  'lead_id',            'leads',                'last_name first_name'),
        ('lead_offers',                  'offer_id',           'real_estate_offers',   'name'),
        ('lead_script_statuses',         'lead_id',            'leads',                'last_name first_name'),
        ('lead_script_statuses',         'funnel_status_id',   'lead_funnel_statuses', 'status_name'),
        ('lead_script_statuses',         'script_id',          'scripts',              'title'),
        ('lead_distribution_pool',       'lead_id',            'leads',                'last_name first_name'),
        ('lead_distribution_pool',       'employee_id',        'employees',            'last_name first_name'),
        ('knowledge_articles',           'author_employee_id', 'employees',            'last_name first_name'),
        ('knowledge_article_attachments','article_id',         'knowledge_articles',   'title'),
        ('knowledge_article_visibility', 'article_id',         'knowledge_articles',   'title'),
        ('knowledge_article_visibility', 'employee_id',        'employees',            'last_name first_name'),
        ('script_nodes',                 'script_id',          'scripts',              'title'),
        ('script_nodes',                 'parent_id',          'script_nodes',         'label'),
        ('employee_documents',           'employee_id',        'employees',            'last_name first_name'),
        ('employee_schedule_days',       'employee_id',        'employees',            'last_name first_name'),
        ('employee_state_intervals',     'employee_id',        'employees',            'last_name first_name'),
        ('employee_column_settings',     'employee_id',        'employees',            'last_name first_name'),
        ('real_estate_offer_geo',        'offer_id',           'real_estate_offers',   'name'),
        ('real_estate_offer_segments',   'offer_id',           'real_estate_offers',   'name'),
        ('real_estate_offer_payment_methods','offer_id',       'real_estate_offers',   'name'),
        ('real_estate_offer_mortgage_types', 'offer_id',       'real_estate_offers',   'name'),
        ('tunnel_key_tokens',            'employee_id',        'employees',            'last_name first_name'),
        ('tunnel_key_tokens',            'created_by',         'employees',            'last_name first_name');

        INSERT INTO applied_migrations (id) VALUES ('2026-08-24-audit-rules-seed');
    END IF;
END $$;

-- ===== ЧАСТЬ 4 · ЕДИНЫЙ ФОРМАТ ТЕЛЕФОНА =====================================
-- Разбор непривёдшихся номеров и указатель слияния (план 5, пункты Б1.1–Б1.6,
-- паспорт Р10 редакции 2). Структура стоит ДО подключения триггеров аудита,
-- разовая миграция — в конце файла, ПОСЛЕ них: иначе массовая правка номеров
-- прошла бы мимо журнала, а она ровно та операция, которую потом захочется
-- посмотреть (часть 3 и делалась раньше ради этого).

-- Причины, по которым строка не разобралась. СПРАВОЧНИК, а не текст в колонке
-- (требование паспорта Р10): по причине отбирают и считают, а свободный текст
-- ни отобрать, ни сосчитать. Числовой ключ, а не код строкой, — чтобы журнал
-- изменений показывал причину словами через audit_ref_map, как любую другую
-- ссылку на справочник.
--
-- ПОРЯДОК ОБЯЗАТЕЛЕН И ЖИВЁТ В sort_order: пусто → буквы → длина. Строка
-- «8 (916) 123-45-67 доб. 102» подходит сразу под две причины, и без
-- назначенного порядка получала бы разную в зависимости от того, какая
-- проверка сработала первой, — а счётчики посчитали бы её дважды. Строка
-- получает РОВНО ОДНУ причину.
CREATE TABLE IF NOT EXISTS phone_fix_reasons (
    id SERIAL PRIMARY KEY,
    code VARCHAR NOT NULL UNIQUE,
    title VARCHAR NOT NULL,
    sort_order INTEGER NOT NULL
);

-- Сидинг идемпотентный (ON CONFLICT по code): файл прогоняется при каждом
-- старте. Тексты — дословно из паспорта Р10.
INSERT INTO phone_fix_reasons (code, title, sort_order) VALUES
    ('empty',          'Пусто',                                        1),
    ('letters',        'В строке есть буквы',                          2),
    ('digits_lt_10',   'Цифр меньше десяти',                           3),
    ('ten_not_nine',   'Десять цифр, начинается не с девятки',         4),
    ('eleven_foreign', 'Одиннадцать цифр, начинается не с 7 и не с 8', 5),
    ('digits_gt_11',   'Цифр больше одиннадцати',                      6)
ON CONFLICT (code) DO NOTHING;

-- ----- Разбор у лида --------------------------------------------------------
-- ИСХОДНАЯ СТРОКА ХРАНИТСЯ БЕССРОЧНО, а не до выхода строки из разбора
-- (паспорт Р10). Два довода, и оба практические: неверно сработавшее приведение
-- испортит хороший номер, и без исходника его не восстановить (ответ куратора
-- И34); и человек, глядя на исправленный номер, должен видеть, что пришло на
-- самом деле, а не только то, что получилось.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_raw VARCHAR;

-- Признак «разобрался». Из него собирается список разбора и счётчик на вкладке.
-- DEFAULT false, а не true: у всех существующих строк номер ещё не проверялся,
-- и объявить их приведёнными до миграции значило бы соврать.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_normalized BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_fix_reason_id INTEGER REFERENCES phone_fix_reasons(id) ON DELETE RESTRICT;

-- Вердикт человека. Четыре значения, и «проверен» с «безнадёжен» — РАЗНЫЕ, а не
-- одно «выведен из разбора»: у первого звонить можно прямо сейчас, у второго
-- некуда (решение владельца 63). NULL означает «разбора не было вовсе», то есть
-- номер привёлся сам.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_fix_verdict VARCHAR;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_phone_fix_verdict_check') THEN
        ALTER TABLE leads ADD CONSTRAINT leads_phone_fix_verdict_check
            CHECK (phone_fix_verdict IS NULL
                   OR phone_fix_verdict IN ('pending', 'checked', 'hopeless', 'fixed'));
    END IF;
END $$;

-- КТО И КОГДА вынес вердикт. Три колонки автора — те же три, что у журнала
-- (audit_log.actor_*), и берутся они из того же источника: заголовков единого
-- транспорта. Отдельного поля с ручным вводом здесь нет намеренно (решение
-- куратора И66): поле, которое человек заполняет руками, — второй источник
-- правды, и он разойдётся с первым в тот же день, когда кто-то вынесет вердикт
-- и забудет представиться. Появится вход — подпись заполнится сама.
--
-- Ссылки на employees у actor_id нет по той же причине, что и в журнале:
-- удалённый сотрудник не должен стирать подпись под вердиктом.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_fix_actor_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_fix_actor_kind VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_fix_actor_name VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_fix_at TIMESTAMP;

-- ----- Указатель слияния ----------------------------------------------------
-- КУДА ДЕЛСЯ ЛИД. Слитый лид не удаляется (решение владельца 11.2: лидов не
-- удаляем, а отправляем в архив) и не ждёт архива из части 5 — иначе часть 4
-- встанет. Он получает указатель на того, в кого влит: пропадает из списков,
-- из раздачи и из подбора оператора, но существует, и на вопрос «куда делся
-- лид 1287» ответ есть навсегда (решение куратора И58).
--
-- ON DELETE RESTRICT, а не SET NULL: обнулить указатель значит вернуть слитого
-- лида в списки как самостоятельного — с тем же номером, что у живого. Отказ
-- объясняется словами там, где удаляют (routes/leadsAdmin.js).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_into_id INTEGER REFERENCES leads(id) ON DELETE RESTRICT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_leads_phone_fix ON leads (phone_fix_verdict)
    WHERE phone_normalized = false;
CREATE INDEX IF NOT EXISTS idx_leads_merged_into ON leads (merged_into_id)
    WHERE merged_into_id IS NOT NULL;

-- Расшифровка причины в журнале: «3 → 7» превращается в «Цифр меньше десяти».
-- Замка не нужно — карта дополняется по мере появления ссылок, конфликт по
-- (table_name, column_name) гасится сам.
INSERT INTO audit_ref_map (table_name, column_name, ref_table, ref_title_columns) VALUES
    ('leads', 'phone_fix_reason_id', 'phone_fix_reasons', 'title'),
    ('leads', 'merged_into_id',      'leads',             'last_name first_name phone')
ON CONFLICT (table_name, column_name) DO NOTHING;


-- ----- Имя записи источника: источник лидов, а не корневой -------------------
-- ПРАВКА СЕМЕНИ НЕ ДОХОДИТ ДО УЖЕ ЗАСЕЯННОЙ БАЗЫ, и это здесь главное. Строки
-- выше вставляются под замком '2026-08-24-audit-rules-seed'; на боевой базе он
-- уже сработал, значит изменённый текст семени там не появится никогда. Нужен
-- отдельный замок и UPDATE.
--
-- Почему меняем. 25.08.2026 в «Источниках» разделили слипшееся значение: номер
-- уехал в lead_source, а в root_source у всех 916 записей осталось одно и то же
-- слово «ДОМ.РФ». Журнал подписывал запись парой «корневой источник · город» —
-- и после правки все 916 записей стали называться одинаково, «ДОМ.РФ · Москва».
-- Подпись, одинаковая у всех записей таблицы, не подпись.
--
-- Прежние записи журнала НЕ переписываются: они хранят имя, снятое в момент
-- события, и это правильно — так было видно, как запись называлась тогда.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-25-source-title-lead-source') THEN
        UPDATE audit_rules
           SET title_columns = 'lead_source city_region'
         WHERE table_name = 'sources' AND title_columns = 'root_source city_region';

        UPDATE audit_ref_map
           SET ref_title_columns = 'lead_source city_region'
         WHERE ref_table = 'sources' AND ref_title_columns = 'root_source city_region';

        INSERT INTO applied_migrations (id) VALUES ('2026-08-25-source-title-lead-source');
        RAISE NOTICE 'Имя записи источника переведено на lead_source';
    END IF;
END $$;

-- ===== ЧАСТЬ 5 · УДАЛЕНИЯ, КАСКАДЫ И АРХИВ ==================================
-- План раздел 11 целиком, пункты Б3.1–Б3.5, решения владельца 70–76,
-- паспорт Р7 редакции 2. Экрана в этой части нет (решение владельца 76) —
-- здесь только данные и правила, кнопки придут отдельной частью.
--
-- СВЯЗЕЙ СОРОК, А НЕ ТРИДЦАТЬ ЧЕТЫРЕ. План писался 01.08.2026 и насчитал 34;
-- на 25.08.2026 в базе их 40 — 24 каскадных, 7 запрещающих, 9 обнуляющих.
-- Пять добавили части 3 и 4: tunnel_key_tokens → employees (две),
-- audit_batches → employees, leads → leads (указатель слияния) и
-- leads → phone_fix_reasons. Перечень снят с живой базы по information_schema,
-- а не из этого файла: журнал схемы есть намерение, база есть факт.

-- ----- Класс Б: самостоятельные сущности, удаление запрещается ---------------
-- План 11.3 делит связи на два класса. Класс А — части целого: своей ценности
-- не имеют, без родителя бессмысленны, каскад им ОСТАВЛЕН. Он и так перестал
-- быть молчаливым: часть 3 повесила триггер на каждую таблицу, и удаление
-- дочерних строк теперь пишется в журнал вместе с их содержимым (план 11.5).
--
-- Класс Б — семь связей ниже. Потеря по ним заметна и невосполнима, поэтому
-- каскад меняется на запрет. Сплошной запрет делать было нельзя: удаление
-- сотрудника превратилось бы в «сначала удалите 47 интервалов состояний», а
-- это не защита, а неработающая система.
--
-- ПОЧЕМУ ПЕРЕБОРОМ, А НЕ СЕМЬЮ ГОТОВЫМИ ALTER. Имена ограничений присвоены
-- базой при создании таблиц в разное время и разными файлами; писать их
-- списком значит зашить в схему то, чего мы не выбирали. Блок ищет связь по
-- тройке «таблица · колонка · родитель» и правит её ТОЛЬКО если политика ещё
-- не запрет — то есть при повторных стартах не делает ничего и не роняет
-- существующие ключи на ровном месте.
--
-- Замка applied_migrations здесь нет намеренно: условие confdeltype <> 'r'
-- само по себе и есть замок, и оно надёжнее записи в журнале миграций —
-- политику могут вернуть руками, и тогда блок починит её сам.
DO $$
DECLARE
    v_rel record;
    v_conname text;
BEGIN
    FOR v_rel IN
        SELECT * FROM (VALUES
            -- Сканы паспорта и трудового: потеря невосполнима, файл в журнал
            -- не пишется вовсе (план 11.5, оговорка про исключённые поля).
            ('employee_documents',         'employee_id',     'employees'),
            -- График работы: отработанные дни — это факт, а не черновик.
            ('employee_schedule_days',     'employee_id',     'employees'),
            -- Каталог недвижимости при удалении CPA-сети. Самая громкая из
            -- трёх молчаливых цепочек плана 11.1: одно нажатие сносило сеть,
            -- все её объекты, у каждого сегменты, географию, способы оплаты и
            -- виды ипотеки, и связи объектов с лидами. Три уровня вглубь.
            ('real_estate_offers',         'network_id',      'cpa_networks'),
            ('organization_bank_accounts', 'organization_id', 'organizations'),
            ('organization_taxes',         'organization_id', 'organizations'),
            -- ТОЛЬКО СТОРОНА ОБЪЕКТА, а не лида (ответ куратора И74). Запрет
            -- осмыслен здесь: нельзя удалить объект, который кому-то подобран.
            -- На стороне лида связка остаётся каскадной — офферы обязательны
            -- при создании лида (validateLeadParams требует минимум один),
            -- значит запрет там сделал бы физическое удаление невозможным
            -- всегда, а план 11.2 держит его ровно для одного случая: «завели
            -- не того, ни одного звонка не было». Правило, которое не
            -- срабатывает никогда, — это не правило (ответ куратора И72).
            ('lead_offers',                'offer_id',        'real_estate_offers'),
            -- Связка источника с сетями. Обратная сторона (cpa_network_id)
            -- запрещающей была всегда; эта уходила каскадом, и удаление
            -- источника молча рвало его связи с сетями. Теперь их удаляет
            -- явно сам маршрут (план 11.4, «Источник», шаг 2).
            ('source_cpa_networks',        'source_id',       'sources')
        ) AS t(child, col, parent)
    LOOP
        -- Сброс обязателен: SELECT INTO без строк ОСТАВЛЯЕТ прежнее значение,
        -- и на второй итерации блок переписал бы чужое ограничение.
        v_conname := NULL;
        SELECT c.conname INTO v_conname
          FROM pg_constraint c
          JOIN pg_class ch ON ch.oid = c.conrelid
          JOIN pg_class pa ON pa.oid = c.confrelid
          JOIN pg_attribute a ON a.attrelid = ch.oid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f'
           AND ch.relname = v_rel.child
           AND pa.relname = v_rel.parent
           AND a.attname = v_rel.col
           AND array_length(c.conkey, 1) = 1
           AND c.confdeltype <> 'r';
        IF v_conname IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', v_rel.child, v_conname);
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE RESTRICT',
                v_rel.child, v_conname, v_rel.col, v_rel.parent);
            RAISE NOTICE 'Часть 5: связь %.% → % переведена в запрет', v_rel.child, v_rel.col, v_rel.parent;
        END IF;
    END LOOP;
END $$;

-- ----- Архив сотрудника: две пометки вместо одной ---------------------------
-- Решение владельца 70. Слово «Неактивен» уходит, вместо него «Уволен» и
-- «Заморожен» (декрет, долгий отпуск, отстранение).
--
-- STATUS НЕ ТРОГАЕТСЯ ВОВСЕ, и это главное в блоке. На условии
-- status <> 'inactive' стоят две вещи, которые уже работают в бою:
-- освобождение добавочного (частичный индекс idx_employees_pbx_extension) и
-- отзыв ключа туннеля (routes/employees.js). Заменить status новой колонкой
-- значило сломать обе, и сломать МОЛЧА — номер остался бы занят за уволенным,
-- а ключ действующим. Новая колонка встаёт РЯДОМ и отвечает ровно на один
-- вопрос: что человек читает в карточке (ответ куратора И80).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS archive_kind VARCHAR;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_archive_kind_check') THEN
        ALTER TABLE employees ADD CONSTRAINT employees_archive_kind_check
            CHECK (archive_kind IS NULL OR archive_kind IN ('dismissed', 'frozen'));
    END IF;
END $$;

-- ДАТА ЗАМОРОЗКИ СВОЯ, А НЕ ОБЩАЯ С УВОЛЬНЕНИЕМ. Соблазн завести одну колонку
-- «дата ухода в архив» есть, но паспорт Р7 прямо говорит: у замороженного
-- колонка «Дата увольнения» в таблице ПУСТАЯ, а дата под пилюлей своя. Одна
-- колонка на два смысла через месяц читается как ошибка данных: непонятно,
-- уволен человек или заморожен, если смотреть на неё одну (ответ куратора И79).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS frozen_at DATE;

-- Существующие архивные — уволенные. Под замком, потому что это утверждение о
-- прошлом, а не приведение к правилу: кого-то из них могли заморозить, и если
-- человек потом исправит вид руками, повторный старт не должен возвращать
-- «Уволен» обратно.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-25-employee-archive-kind') THEN
        UPDATE employees SET archive_kind = 'dismissed'
         WHERE status = 'inactive' AND archive_kind IS NULL;
        INSERT INTO applied_migrations (id) VALUES ('2026-08-25-employee-archive-kind');
    END IF;
END $$;

-- ----- Архив лида -----------------------------------------------------------
-- Признака архива у лида не было вовсе — ни колонки, ни флага. Заводится здесь:
-- сам признак плюс КОГДА и КТО отправил (паспорт Р7 требует их для строки под
-- пилюлей).
--
-- Три колонки автора — те же три, что у вердикта разбора номера (часть 4) и у
-- журнала (audit_log.actor_*), и берутся они из того же источника: заголовков
-- единого транспорта. Два разных способа записать «кто это сделал» в одной
-- таблице — это будущий вопрос «а почему по-разному» (ответ куратора И83).
--
-- Ссылки на employees у archived_actor_id нет по той же причине, что в
-- журнале: подпись обязана пережить удаление сотрудника.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_actor_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_actor_kind VARCHAR;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_actor_name VARCHAR;

CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads (archived_at)
    WHERE archived_at IS NOT NULL;

-- УНИКАЛЬНОСТЬ НОМЕРА АРХИВНОГО ЛИДА НЕ ОСВОБОЖДАЕТСЯ, и это отдельное
-- предупреждение, потому что соблазн очевиден: idx_leads_phone_unique уже
-- отбирает по merged_into_id IS NULL, и рука сама допишет туда
-- AND archived_at IS NULL «для единообразия». Делать этого нельзя. Тогда номер
-- архивного лида освободится, кто-то заведёт второго с тем же номером — и
-- решение владельца 74 сломается: входящий звонок найдёт двоих и не сможет
-- выбрать, чью карточку поднять. Условие в индексе одно, и оно про слияние
-- (предупреждение куратора при ответе на И84).

-- ===== ЧАСТЬ 7А · ЖУРНАЛ ЗВОНКОВ =============================================
-- Решение владельца 34: ключ записи — РАЗГОВОР С КЛИЕНТОМ, а не плечо вызова.
-- АТС считает плечами, и сделать плечо строкой журнала значит превратить один
-- разговор в три: «сделано звонков» раздуется, средняя длительность поедет,
-- конверсия просядет на пустом месте. Склеить всё в одну строку без участков —
-- потерять, кто говорил и сколько (план 4.1).
--
-- Отсюда две таблицы: звонок и участки внутри него. Обычно участок один; при
-- переводе — два и более.

CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY,

    -- КОРЕНЬ ВЫЗОВА. Станция присылает его во всех событиях одного вызова
    -- (CallID) и по нему же склеиваются плечи. Хранится строкой: для нас это
    -- непрозрачный идентификатор, наше дело — сравнивать и возвращать.
    pbx_call_id VARCHAR,
    -- Идентификатор для управления идущим вызовом (CallAPIID) и идентификатор
    -- нашей инициации (CallBackID) — второй есть только у звонков, начатых
    -- нами через API.
    pbx_api_id VARCHAR,
    pbx_callback_id VARCHAR,

    -- Направление. Слов два, и перечень закрыт: третьего направления у звонка
    -- не бывает, а свободная строка однажды приедет с «Out» или «исходящий».
    direction VARCHAR NOT NULL DEFAULT 'out',

    -- Какой номер видел клиент и по какому звонили ему.
    our_number VARCHAR,
    client_phone VARCHAR,

    -- НАШИ СВЯЗИ. Лид запрещает своё удаление, пока есть хоть один звонок
    -- (план 11.4: «Есть звонки? → запрещено, только архив»). Сотрудник — тем
    -- более: «звонил оператор №14», у которого не осталось имени, это запись,
    -- ссылающаяся в пустоту (план 11.2).
    lead_id INTEGER REFERENCES leads(id) ON DELETE RESTRICT,
    employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,

    -- ДОБАВОЧНЫЙ — СНИМОК, А НЕ ССЫЛКА. Номер освобождается при выводе
    -- сотрудника из работы и выдаётся другому (часть 5). Читать его из карточки
    -- значит показать в звонке трёхмесячной давности того, кто получил номер
    -- вчера.
    operator_extension VARCHAR,

    -- ИСХОД ХРАНИТСЯ ДВАЖДЫ, И ЭТО НЕ ИЗБЫТОЧНОСТЬ (ответ куратора И161).
    -- `outcome` — наш перечень: он переживёт переименование у оператора связи и
    -- по нему отбирают. `outcome_raw` — строка станции как есть: единственное
    -- доказательство, когда цифры не сойдутся и начнётся спор, чья ошибка.
    outcome VARCHAR,
    outcome_raw VARCHAR,

    -- Состоялся ли разговор. Отдельно от исхода: у «ответили» разговор есть
    -- почти всегда, но исход приходит от станции, а этот признак — от факта.
    answered BOOLEAN NOT NULL DEFAULT false,
    transferred BOOLEAN NOT NULL DEFAULT false,

    -- ВНУТРЕННИЙ ЗВОНОК ЗАПИСЫВАЕТСЯ, НО НЕ СЧИТАЕТСЯ (решение владельца 33).
    -- Оператор ↔ оператор — это факт работы, и скрывать его нельзя; портить им
    -- процент дозвона и среднюю длительность — тоже. Строка в списке остаётся,
    -- из счётчиков и выгрузки исключается (ответ куратора И159).
    is_internal BOOLEAN NOT NULL DEFAULT false,

    -- Время и длительности. Секунды целым числом: микросекунды станции
    -- приводятся один раз на входе, services/pbxTime.js.
    started_at TIMESTAMP,
    answered_at TIMESTAMP,
    ended_at TIMESTAMP,
    wait_seconds INTEGER,
    talk_seconds INTEGER,

    -- Запись разговора. Идентификатор непрозрачен: наше дело вернуть его
    -- станции, а не разбирать. Пусто — записи нет вовсе, и кнопки в списке тоже
    -- нет (ответ куратора И178).
    record_id VARCHAR,

    -- СНИМКИ НА МОМЕНТ ЗАВЕРШЕНИЯ, А НЕ ССЫЛКИ НА ЛИДА (план 4.3). Поля notes и
    -- funnel_status_id лежат на лиде и перезаписываются при каждом сохранении:
    -- подтягивая их, журнал показал бы у всех звонков к одному человеку
    -- сегодняшний комментарий и сегодняшний статус. Он начал бы переписывать
    -- собственную историю, и заметить это почти нельзя — цифры-то правильные.
    --
    -- Статус хранится ПАРОЙ (ответ куратора И162): имя защищает от
    -- переименования, идентификатор нужен, чтобы отбирать по статусу, не
    -- сравнивая строки.
    funnel_status_id INTEGER REFERENCES lead_funnel_statuses(id) ON DELETE SET NULL,
    funnel_status_name VARCHAR,
    notes_snapshot TEXT,
    -- Номер попытки тоже снимок: leads.call_attempts — сквозной счётчик, он
    -- растёт, и в записи звонка он должен быть зафиксирован, а не пересчитан.
    attempt_no INTEGER,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_direction_check') THEN
        ALTER TABLE calls ADD CONSTRAINT calls_direction_check
            CHECK (direction IN ('in', 'out'));
    END IF;
    -- Перечень исходов закрыт ограничением, а не соглашением. Шесть от станции
    -- плюс служебный `lost`: строку, висящую активной дольше четырёх часов без
    -- единого события, закрывает сторож (план 7.3). Без сторожа один сбойный
    -- звонок остался бы в «Активных» навсегда, и вкладке перестали бы верить.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_outcome_check') THEN
        ALTER TABLE calls ADD CONSTRAINT calls_outcome_check
            CHECK (outcome IS NULL OR outcome IN
                ('answered', 'busy', 'no_answer', 'cancelled', 'congestion', 'unavailable', 'lost'));
    END IF;
END $$;

-- Отборы вкладки «Завершённые»: свежие сверху, по оператору, по лиду, по номеру.
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_employee ON calls (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_client_phone ON calls (client_phone);
-- Склейка событий в звонок идёт по корню вызова, и это самый горячий запрос
-- приёмника: он выполняется на каждое событие станции.
CREATE INDEX IF NOT EXISTS idx_calls_pbx_call ON calls (pbx_call_id) WHERE pbx_call_id IS NOT NULL;

-- ----- Участки звонка --------------------------------------------------------
-- Кто из операторов и сколько говорил ВНУТРИ одного звонка. Разговорное время
-- делится по операторам: ни один не получает чужие минуты, а общее число
-- звонков не раздувается.
CREATE TABLE IF NOT EXISTS call_segments (
    id SERIAL PRIMARY KEY,
    -- Класс А по разбору части 5: участок без своего звонка бессмыслен, и
    -- каскад здесь остаётся. Молчаливым он больше не бывает — попадает в журнал.
    call_id INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    -- Порядок участка в цепочке: «Абрамова 1:20 → перевод → Волков 4:05».
    position INTEGER NOT NULL DEFAULT 1,
    -- Плечо вызова у станции (SubCallID). Здесь оно на своём месте — участком,
    -- а не строкой журнала.
    pbx_sub_call_id VARCHAR,
    employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
    operator_extension VARCHAR,
    started_at TIMESTAMP,
    answered_at TIMESTAMP,
    ended_at TIMESTAMP,
    talk_seconds INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_segments_call ON call_segments (call_id, position);
CREATE INDEX IF NOT EXISTS idx_call_segments_employee
    ON call_segments (employee_id) WHERE employee_id IS NOT NULL;
-- Порядок внутри звонка уникален: два участка под одним номером — это ошибка
-- разбора, и пусть она отобьётся здесь, а не всплывёт кривой цепочкой на экране.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_segments_position
    ON call_segments (call_id, position);

-- ----- Карточка была заполнена частично: снимок у звонка ---------------------
-- Часть 9, заход 5. Пометка живёт у лида и снимается, как только карточку
-- дописали; тянуть её в журнал звонка ссылкой значило бы переписывать запись о
-- прошлом разговоре каждый раз, когда лида правят. Паспорт Р12 просит эту строку
-- ровно затем, чтобы объяснить, почему у долгого разговора короткий комментарий,
-- — а объясняет она ТОТ разговор, а не сегодняшнее состояние лида.
--
-- ⚠ ОТДЕЛЬНЫМ ALTER, А НЕ СТРОКОЙ В `CREATE TABLE`. Первая моя редакция дописала
-- колонку в тело объявления — и на любой существующей базе `IF NOT EXISTS`
-- пропустил всё объявление целиком, колонки не появилось, а журнал звонков
-- ответил пятисотым. На чистой базе при этом всё работало: наборы части 9 гоняют
-- свою базу с нуля и ошибку не увидели. Поймал регресс части 7Б, который ходит
-- по общему стенду.
--
-- ⚠ Писать сюда сегодня нечем: звонки заводит станция, которой ещё нет. Место —
-- как и оффер перевода у участка ниже (ответ куратора 3).
ALTER TABLE calls ADD COLUMN IF NOT EXISTS partially_filled BOOLEAN NOT NULL DEFAULT false;

-- ----- Перевод партнёру: звено цепочки, а не колонка у звонка ----------------
-- Часть 9, заход 5. Переводов у звонка бывает НЕСКОЛЬКО, и паспорт Р1 редакции 8
-- требует показывать все: «звено цепочки — оффер, сеть подстрокой, „ЖК «Символ» ·
-- Циан 2:12"». Колонка у `calls` держит ровно один — на ней «все офферы» не
-- собираются никак. Цепочка живёт здесь, здесь же лежат операторы и
-- `talk_seconds`, из которого берётся та самая «2:12».
--
-- ПАРТНЁРСКОЕ ЗВЕНО — С ПУСТЫМ СОТРУДНИКОМ. `employee_id` объявлен nullable
-- выше, менять ничего не пришлось: перевод наружу — не сотрудник.
--
-- ДВА СНИМКА РЯДОМ СО ССЫЛКОЙ, И ЭТО НЕ ПЕРЕСТРАХОВКА. Офферы удаляются
-- по-настоящему (`routes/realEstateOffers.js`, DELETE), часть 5 оставила их
-- удаляемыми и запретила только снос сети с офферами. Удалённый оффер обнулил бы
-- ссылку, и запись о разговоре потеряла бы, кому переводили. Приём тот же, что у
-- статуса звонка рядом: `funnel_status_id … ON DELETE SET NULL` плюс
-- `funnel_status_name` снимком. История разговоров удалением справочника не
-- переписывается.
--
-- ВНЕШНЕГО НОМЕРА ЗДЕСЬ НЕТ. Он лежит в строке события
-- `call_transfer_offers.transfer_phone`; понадобится в журнале звонка — возьмётся
-- оттуда.
--
-- ⚠ ПИСАТЬ В ЭТИ КОЛОНКИ СЕГОДНЯ НЕЧЕМ. Кнопки «Перевести» не существует, пульт
-- вынесен отдельной задачей (решение владельца 49). Часть 9 заводит место, показ
-- в развороте и столбец выгрузки; сама запись придёт с телефонией. Место, готовое
-- заранее, стоит три колонки; добавленное потом — ещё одну выкатку схемы в
-- разгар настройки станции.
ALTER TABLE call_segments ADD COLUMN IF NOT EXISTS transfer_offer_id INTEGER
    REFERENCES real_estate_offers(id) ON DELETE SET NULL;
ALTER TABLE call_segments ADD COLUMN IF NOT EXISTS transfer_offer_name VARCHAR;
ALTER TABLE call_segments ADD COLUMN IF NOT EXISTS transfer_network_name VARCHAR;

-- Разворот строки звонка спрашивает «какие офферы у этого звонка» — то есть
-- идёт по `call_id`, который уже покрыт индексом выше. Своего индекса связь не
-- получает: отбора «все звонки по этому офферу» в паспортах нет.
--
-- РАСШИФРОВКИ ССЫЛКИ В ЖУРНАЛЕ НЕТ, И ЭТО НЕ ПРОПУСК — тот же довод, что у
-- статуса звонка двумя блоками ниже: `transfer_offer_id` лежит СНИМКОМ рядом с
-- `transfer_offer_name`. Расшифровать его через справочник значило бы подставить
-- сегодняшнее имя оффера в запись о прошлом — ровно то, ради чего снимок и
-- заведён. Подписи трёх колонок живут в `Shell/history/historyFields.js`.

-- ----- Сырые сообщения станции ----------------------------------------------
-- ЗАЧЕМ ХРАНИТЬ. Когда цифра в журнале не сойдётся, это единственный способ
-- доказать, чья ошибка — наша или станции. Без них спор с телефонией выиграть
-- нечем (план 7.5).
--
-- СКОЛЬКО ИХ. До полутора десятков на звонок; при сотне звонков в день — около
-- полутора миллионов строк за полгода. Поэтому таблица сразу помесячными
-- полками: через шесть месяцев полка выбрасывается целиком и мгновенно, а не
-- вычищается построчно ночной уборкой на миллионах строк.
--
-- ПЕРВИЧНЫЙ КЛЮЧ СОСТАВНОЙ. У разрезанной таблицы он обязан включать ключ
-- разреза — иначе Postgres откажется его создавать.
CREATE TABLE IF NOT EXISTS pbx_events (
    id BIGSERIAL,
    -- Время события, уже приведённое из микросекунд. По нему же идёт разрез.
    event_at TIMESTAMP NOT NULL,
    -- Когда мы его приняли. Расхождение с event_at — первое, что смотрят, когда
    -- события приходят с опозданием или не приходят вовсе.
    received_at TIMESTAMP NOT NULL DEFAULT NOW(),
    event_type VARCHAR,
    pbx_call_id VARCHAR,
    pbx_sub_call_id VARCHAR,
    -- Тело как пришло. JSONB, а не текст: по нему придётся искать, а разбирать
    -- строку при каждом разборе спора — та же работа, только руками.
    payload JSONB NOT NULL,
    PRIMARY KEY (id, event_at)
) PARTITION BY RANGE (event_at);

CREATE INDEX IF NOT EXISTS idx_pbx_events_call ON pbx_events (pbx_call_id, event_at);
CREATE INDEX IF NOT EXISTS idx_pbx_events_received ON pbx_events (received_at);

-- Полки на год вперёд и на месяц назад, идемпотентно, тем же приёмом, что у
-- журнала аудита (ответ куратора И154). Прогоняется при каждом старте — значит
-- горизонт отодвигается сам, а перезапуск бывает при каждой выкатке.
--
-- ПОЛКИ «ПО УМОЛЧАНИЮ» НЕТ, и это то же решение, что у журнала: она приняла бы
-- запись за пределами горизонта и тем самым запретила бы завести полку на этот
-- месяц потом — старт сервера падал бы, и чинить пришлось бы руками на бою.
DO $$
DECLARE
    v_start date;
    v_month date;
    v_name text;
BEGIN
    v_start := date_trunc('month', NOW())::date - INTERVAL '1 month';
    FOR i IN 0..13 LOOP
        v_month := (v_start + (i || ' month')::interval)::date;
        v_name := 'pbx_events_' || to_char(v_month, 'YYYY_MM');
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF pbx_events FOR VALUES FROM (%L) TO (%L)',
                v_name, v_month, (v_month + INTERVAL '1 month')::date);
        END IF;
    END LOOP;
END $$;

-- ----- Уборка полок сырых событий (часть 7А) --------------------------------
-- СРОК ХРАНЕНИЯ СЫРЫХ СООБЩЕНИЙ — ШЕСТЬ МЕСЯЦЕВ (решение владельца 38), и он
-- касается ТОЛЬКО их: журнал изменений и всё остальное хранятся бессрочно
-- (решение 37).
--
-- Уборка — команда, а не расписание. Внутри приложения её нет намеренно
-- (план 7.5, ответ куратора И155): планировщик части 6 нужен автодозвону, а
-- снятие полки — редкая служебная работа, которой место в таймере на сервере,
-- рядом с резервным копированием. Функция здесь, таймер ставит куратор.
--
-- ПОЛКА СНИМАЕТСЯ ЦЕЛИКОМ, А НЕ ВЫЧИЩАЕТСЯ ПОСТРОЧНО. В этом и был смысл
-- разреза: DROP полки мгновенен и база его не замечает, а «удали всё старше
-- полугода» на полутора миллионах строк превращается в тяжёлую ночную уборку.
--
-- Возвращает имена снятых полок — чтобы таймер писал в журнал службы, что
-- именно он снял, а не «готово».
CREATE OR REPLACE FUNCTION drop_old_pbx_shelves(p_months integer DEFAULT 6)
RETURNS SETOF text AS $$
DECLARE
    v_edge date;
    v_name text;
    v_month date;
BEGIN
    -- Граница считается от начала текущего месяца, а не от «сегодня минус
    -- полгода»: полка живёт месяцем, и снимать её надо, когда истёк весь месяц,
    -- а не когда истекло его первое число.
    v_edge := date_trunc('month', NOW())::date - (p_months || ' month')::interval;

    FOR v_name IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relname ~ '^pbx_events_[0-9]{4}_[0-9]{2}$'
         ORDER BY c.relname
    LOOP
        -- Имя полки и есть её месяц. Разбираем имя, а не спрашиваем границы у
        -- каталога: имя мы задаём сами и оно однозначно.
        v_month := to_date(right(v_name, 7), 'YYYY_MM');
        IF v_month < v_edge THEN
            EXECUTE format('DROP TABLE %I', v_name);
            RETURN NEXT v_name;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ----- Лид: пропущенный звонок и происхождение (часть 7А) --------------------
-- ПРОПУЩЕННЫЙ — ПРИЗНАК, А НЕ СТАТУС (план 6.4). Статус воронки в проекте один,
-- и его ставит оператор после разговора — на этом держится весь журнал.
-- Записать туда «пропущенный» машинно значило бы затереть то, что поставил
-- человек.
--
-- ВРЕМЯ, А НЕ БУЛЕВО (ответ куратора И156). Признак отвечает за приоритет в
-- очереди, а внутри уровня пропущенные идут по времени звонка: кто раньше
-- звонил, того раньше отдаём (решение владельца 28). Булева для этого мало.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS missed_at TIMESTAMP;

-- Отбор третьего уровня очереди. Частичный: пропущенных всегда меньшинство, а
-- индекс по всей таблице ради них — плата за каждую запись лида.
CREATE INDEX IF NOT EXISTS idx_leads_missed ON leads (missed_at)
    WHERE missed_at IS NOT NULL;

-- ПРОИСХОЖДЕНИЕ ЛИДА — СВОЁ ПОЛЕ, А НЕ СТРОКА В СПРАВОЧНИКЕ ИСТОЧНИКОВ
-- (решение владельца 58, ответ куратора И158). Звонок в справочник не влезает:
-- у источника обязательна площадка, а у входящего звонка её нет и быть не может.
--
-- Существующим лидам НЕ ПРОСТАВЛЯЕТСЯ НИЧЕГО, и это решение куратора: часть из
-- них заводили руками, часть грузили файлом, и написать им всем `import` значило
-- бы утверждать то, чего мы не знаем. Пустое «неизвестно» честнее выдуманного
-- значения — на экране это прочерк.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS origin VARCHAR;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_origin_check') THEN
        ALTER TABLE leads ADD CONSTRAINT leads_origin_check
            CHECK (origin IS NULL OR origin IN ('ad', 'incoming_call', 'import', 'manual'));
    END IF;
END $$;

-- ===== ЧАСТЬ 9 · СОБЫТИЯ ПЛАНИРОВЩИКА · ХРАНИЛИЩЕ ============================
-- Наряд куратора от 26.08.2026, заход 1 «База». Паспорта: Р12 ред. 3 (события),
-- Р11 ред. 5 (пометка статуса), Р1 ред. 8 (третья вкладка).
--
-- ЧТО ЗДЕСЬ ПРОИСХОДИТ. Числа, стоявшие константами в `services/appTime.js` —
-- перезвон через час, двадцать попыток, окно 9–21, — становятся тремя
-- событиями руководителя. Заход 1 завёл таблицы и засеял их этими же числами,
-- поведения не меняя; заход 2 научил код читать их отсюда, и в самом
-- `appTime.js` этих констант больше нет — иначе источников правды стало бы два.
--
-- ПОЧЕМУ БЛОК СТОИТ ЗДЕСЬ, А НЕ В КОНЦЕ ФАЙЛА. Ниже идёт перебор, который
-- вешает триггер аудита на все таблицы схемы. Таблица, заведённая ПОСЛЕ него,
-- получила бы триггер только со второго старта сервера — то есть первая правка
-- события прошла бы мимо журнала и никто бы этого не заметил. Ни одна таблица
-- проекта после этого перебора не заводится, и эта не будет.

-- ----- Сами события ----------------------------------------------------------
-- ТРИ ВИДА, И ЧЕТВЁРТОГО НЕ БЫВАЕТ. Каждый отвечает за своё место в коде, а
-- «добавить событие» означало бы «добавить поведение» (паспорт Р12). Поэтому
-- перечень закрыт ограничением, а вид уникален: второго «Перевода» не бывает.
--
-- ⚠ ВИДОВ БЫЛО ЧЕТЫРЕ ДО РЕШЕНИЯ ВЛАДЕЛЬЦА 109 (К259). Четвёртый, «Время
-- перевода», держал ОДНО число на всех, и оно уехало полем в строку сотрудника
-- — своим у каждой, ровно как у оффера. Сам переезд стоит НИЖЕ, после
-- `call_transfer_employees`, и перечень видов сужается только там: сузить его
-- здесь значит применить новое правило к таблице, где снимаемая строка ещё
-- на месте.
--
-- ИМЯ ТАБЛИЦЫ. Не путать с `pbx_events` ниже: там СЫРЫЕ СООБЩЕНИЯ СТАНЦИИ, по
-- полтора десятка на звонок, которые человек не правит вовсе. Здесь — три
-- строки настройки, которые правит руководитель. Слово «событие» взято из
-- паспорта и с экрана; оно же стоит на вкладке.
--
-- ОКНО ОБЗВОНА ПРИНАДЛЕЖИТ ОДНОМУ ВИДУ, и это осознанно: оно одно на весь
-- автоперезвон (интервал и предел — свои у каждого статуса, они ниже строками).
-- Складывать пару в JSONB нельзя: журнал изменений показал бы правку одного
-- числа как замену всего блока, и подпись поля взять было бы неоткуда.
-- Ограничение ниже не даёт заполнить окно чужому виду.
CREATE TABLE IF NOT EXISTS call_events (
    id SERIAL PRIMARY KEY,
    kind VARCHAR NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    -- Рабочее окно автоперезвона: одно на всё событие, а не своё у каждого
    -- статуса. Интервал и предел свои у каждой строки, окно общее — так это и
    -- работало константами до захода 2.
    window_from TIME,
    window_to TIME,
    -- ⚠ КОЛОНКА ЖИВЁТ ДО ПЕРЕЕЗДА НИЖЕ И СНИМАЕТСЯ ИМ ЖЕ (решение владельца 109,
    -- К259). Держать её в объявлении обязательно, и это не инерция: перенос
    -- читает её на ЛЮБОЙ базе, в том числе на чистой, — убери отсюда, и
    -- `UPDATE … SELECT wait_seconds` упадёт на несуществующей колонке ещё до
    -- того, как ему будет нечего переносить. На чистой базе колонка живёт ровно
    -- один прогон файла: заводится здесь, снимается тридцатью строками ниже.
    wait_seconds INTEGER,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    -- ⚠ ПЕРЕЧЕНЬ ВИДОВ ЗАВОДИТСЯ НЕ ЗДЕСЬ, А НИЖЕ, ПОСЛЕ ПЕРЕЕЗДА. Схема
    -- исполняется сверху вниз при каждом старте, и на боевой базе перечень из
    -- трёх видов применился бы здесь к таблице, где строка `transfer_wait` ещё
    -- на месте: «ограничение-проверку … нарушает некоторая строка», и сервер не
    -- поднимается. ПРОВЕРЕНО ОПЫТОМ на живой базе, в обе стороны: до удаления
    -- строки команда падает, после — проходит.
    --
    -- И самое опасное: на ЧИСТОЙ базе такая раскладка зелена — строки там ещё
    -- нет, засев не отработал. То есть дефект живёт ровно на той базе, где он
    -- дорогой, и ни один прогон на пустой базе его не покажет.
    --
    -- Здесь остаётся только снятие прежнего имени; новое
    -- `call_events_kind_rule_check` заводится последней строкой блока переезда.
    ALTER TABLE call_events DROP CONSTRAINT IF EXISTS call_events_kind_check;
    -- Окно — только у автоперезвона.
    -- Ограничение здесь не педантизм: без него заполненная не тем видом колонка
    -- молча ничего не делала бы, и разбираться пошли бы в код.
    --
    -- К225: ОКНО — ПАРА, И ПОЛОВИНЫ ОКНА НЕ БЫВАЕТ. Первая редакция проверки
    -- сторожила только чужие виды, а своему разрешала всё — в том числе
    -- «с 09:00 и до никогда». Дыра ровно того же вида, ради которого проверка и
    -- заведена, только на своём виде. Теперь: обе колонки заполнены либо обе
    -- пусты, и заполнены они могут быть только у автоперезвона.
    --
    -- ИМЯ ОГРАНИЧЕНИЯ НОВОЕ, И СТАРОЕ СНИМАЕТСЯ ЯВНО. Сохрани прежнее имя — и
    -- на базе, где первая редакция уже сработала, guard увидел бы ограничение с
    -- этим именем и молча пропустил правку: снаружи «проверка есть», внутри
    -- дыра. DROP IF EXISTS идемпотентен и на чистой базе не делает ничего.
    --
    -- ЗАХОД 7: ТРЕТЬЕ УСЛОВИЕ — ОКНО НУЛЕВОЙ ДЛИНЫ. `window_from = window_to`
    -- означает «никогда», а не «круглые сутки»: `shiftIntoCallWindow` считает
    -- вхождение как `at >= from && at < from`, то есть ложь при любом времени
    -- (`services/appTime.js`). Экран это отбивал с захода 5, база — нет, и
    -- правило данных обязано жить в данных.
    --
    -- ⚠ ОГРАНИЧЕНИЕ ДОПОЛНЯЕТСЯ ЗДЕСЬ ЖЕ, А НЕ ЗАВОДИТСЯ ВТОРЫМ. Второе
    -- ограничение на ту же колонку означало бы два места, где написано одно
    -- правило, и один и тот же отказ с двумя разными именами в логе. Отсюда и
    -- третье имя: guard по имени иначе пропустил бы правку на базе, где уже
    -- стоит парная редакция.
    ALTER TABLE call_events DROP CONSTRAINT IF EXISTS call_events_window_check;
    ALTER TABLE call_events DROP CONSTRAINT IF EXISTS call_events_window_pair_check;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_events_window_rule_check') THEN
        ALTER TABLE call_events ADD CONSTRAINT call_events_window_rule_check
            CHECK ((window_from IS NULL) = (window_to IS NULL)
                   AND (window_from IS NULL OR kind = 'auto_recall')
                   AND (window_from IS NULL OR window_from <> window_to));
    END IF;
    -- ⚠ ПРОВЕРКИ ОЖИДАНИЯ ЗДЕСЬ БОЛЬШЕ НЕТ, И ЭТО НЕ ПРОПУСК. Она стерегла
    -- `wait_seconds IS NULL OR kind = 'transfer_wait'` — колонку, которую
    -- переезд ниже снимает целиком. Отдельного `DROP CONSTRAINT` для неё нет
    -- намеренно: `DROP COLUMN` уносит проверку на свою колонку сам (проверено
    -- опытом). Сказано словами, чтобы следующий читатель не искал снятие,
    -- которого не должно быть.
END $$;

-- ----- Строки «Автоперезвона» ------------------------------------------------
-- Список статусов, по которым система перезванивает, задаёт руководитель
-- (решение владельца 8), и у КАЖДОГО статуса свой интервал, свой предел и свой
-- статус после предела (решения 9, 10, 12, 14). Списком через запятую в одной
-- строке это не ложится.
--
-- ОДНА СТРОКА НА СТАТУС. Двух правил для одного статуса не бывает: система не
-- знала бы, какое из них исполнять.
--
-- ЗАПРЕТ, А НЕ КАСКАД, у обеих ссылок на справочник. Молча исчезнувшее правило
-- автоперезвона — это выключенный обзвон без единой записи о том, кто и когда
-- его выключил. Отказ при удалении статуса громче и разбирается за минуту.
-- ⚠ Помех при удалении статуса паспорт Р11 называет ДВЕ — лиды и наборы
-- «скрипт + статус»; эта третья. Вопрос куратору задан (dialog.md, вопросы по
-- части 9); до ответа стоит запрет, потому что он не теряет данные.
CREATE TABLE IF NOT EXISTS call_recall_rules (
    id SERIAL PRIMARY KEY,
    funnel_status_id INTEGER NOT NULL UNIQUE REFERENCES lead_funnel_statuses(id) ON DELETE RESTRICT,
    interval_minutes INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    after_limit_status_id INTEGER NOT NULL REFERENCES lead_funnel_statuses(id) ON DELETE RESTRICT
);

-- ----- Строки «Пост-обработки» -----------------------------------------------
-- Условие — ПАРА «линия + скрипт» (решение 18), длительность своя у каждой пары
-- (решение 19). Внутри события перечень пар, а не одна пара: иначе фраза «если
-- для линии и скрипта события нет» лишена смысла. Чтение подтверждено куратором.
--
-- ЛИНИЯ — СТРОКОЙ, как везде в проекте: `employees.line_type` и `leads.line_type`
-- объявлены VARCHAR и хранят «Входящая» / «Исходящая» (`schema.sql:638`, `666`,
-- нормализация 726–731). Второго представления линии здесь не заводится.
CREATE TABLE IF NOT EXISTS call_wrapup_rules (
    id SERIAL PRIMARY KEY,
    line_type VARCHAR NOT NULL,
    script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
    duration_seconds INTEGER NOT NULL,
    UNIQUE (line_type, script_id)
);

-- ----- Перечень «Перевода»: офферы -------------------------------------------
-- Перевод партнёру на внешний номер. ОДНА СТРОКА НА ОФФЕР, второй быть не может
-- (паспорт Р12): порядок строк берётся из приоритета оффера, и две строки на
-- один оффер сделали бы порядок неопределённым.
--
-- КАСКАД, А НЕ ЗАПРЕТ, и это разница по существу с автоперезвоном выше. Строка
-- перевода — принадлежность оффера, ровно как его сегменты, его география и его
-- способы оплаты: все три уходят вместе с оффером и запретом не защищены.
--
-- ⚠ СТРОКА `CREATE TABLE` ПРО ЭТУ СВЯЗЬ ВРЁТ, и проверять надо не её. В
-- объявлении `real_estate_offers.network_id` стоит ON DELETE CASCADE (строка
-- 376) — а часть 5 перевела эту связь в ЗАПРЕТ перебором ниже (строка 1991):
-- одно нажатие сносило сеть, все её объекты и всё, что под ними, на три уровня
-- вглубь. Значит сеть офферы за собой больше не уносит, и каскад здесь — только
-- про удаление самого оффера. Часть 5 разбирала и такие связи тоже: в запрет
-- пошло то, чья потеря невосполнима (сканы документов, отработанные дни);
-- пять полей, которые вводятся заново за полминуты, остались каскадом.
--
-- НОМЕР — ЕДИНЫЙ ФОРМАТ ПРОЕКТА, `services/phoneFormat.js` (часть 4): хранение
-- +7XXXXXXXXXX. Второго формата не заводится. Один и тот же номер у двух
-- офферов допустим — уникальности здесь нет намеренно.
--
-- ДНИ НЕДЕЛИ — МАССИВОМ ISO: 1 понедельник … 7 воскресенье, ровно как их отдаёт
-- EXTRACT(ISODOW). Массив, а не семь колонок и не битовая маска: массивы в
-- проекте уже есть (`obj_types`, `finishes`, `rooms`), маску пришлось бы
-- расшифровывать и в коде, и в журнале изменений.
CREATE TABLE IF NOT EXISTS call_transfer_offers (
    id SERIAL PRIMARY KEY,
    offer_id INTEGER NOT NULL UNIQUE REFERENCES real_estate_offers(id) ON DELETE CASCADE,
    transfer_phone VARCHAR NOT NULL,
    weekdays SMALLINT[] NOT NULL,
    time_from TIME NOT NULL,
    time_to TIME NOT NULL,
    wait_seconds INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true
);

-- ----- Перечень «Перевода»: сотрудники ---------------------------------------
-- Перевод внутрь, на внутренний номер. СЕКУНДЫ ОЖИДАНИЯ СВОИ У КАЖДОЙ СТРОКИ,
-- ровно как у оффера — решение владельца 109 (К259). Одного числа на всех
-- больше нет: событие «Время перевода» снято, а его значение перенесено сюда
-- переездом ниже. Колонку заводит он же, поэтому в объявлении её нет: на базе,
-- где таблица уже создана, `CREATE TABLE IF NOT EXISTS` не делает ничего, и
-- новая колонка приехала бы только на чистой.
--
-- ⚠ Одна строка на сотрудника — вопрос закрыт куратором 29.08.2026. Симметрия с
-- оффером верна, и у неё появился второй довод: со своим ожиданием у строки две
-- строки на одного сотрудника означали бы два разных числа для одного
-- внутреннего номера.
CREATE TABLE IF NOT EXISTS call_transfer_employees (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
    weekdays SMALLINT[] NOT NULL,
    time_from TIME NOT NULL,
    time_to TIME NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true
);

-- Дни недели проверяются в базе, а не только на форме: «Отметьте хотя бы один
-- день — иначе перевод не работает никогда» (текст Р12) — это правило данных, а
-- пустой набор дней означает строку, которая не сработает ни разу и молча.
--
-- COALESCE ЗДЕСЬ ОБЯЗАТЕЛЕН, И ЭТО НЕ ПЕРЕСТРАХОВКА. У ПУСТОГО массива
-- array_length возвращает не ноль, а NULL; NULL BETWEEN 1 AND 7 даёт NULL, а
-- ограничение считает нарушением только явное FALSE — то есть без COALESCE
-- пустой набор дней проходил бы насквозь. Ровно тот случай, ради которого
-- проверка и заведена. Поймано набором, а не чтением.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_transfer_offers_weekdays_check') THEN
        ALTER TABLE call_transfer_offers ADD CONSTRAINT call_transfer_offers_weekdays_check
            CHECK (COALESCE(array_length(weekdays, 1), 0) BETWEEN 1 AND 7
                   AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_transfer_employees_weekdays_check') THEN
        ALTER TABLE call_transfer_employees ADD CONSTRAINT call_transfer_employees_weekdays_check
            CHECK (COALESCE(array_length(weekdays, 1), 0) BETWEEN 1 AND 7
                   AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]);
    END IF;
END $$;

-- Отбор строк перевода идёт по адресату: «есть ли строка у этого оффера» —
-- первый вопрос при попытке перевода. По сотруднику — то же самое.
CREATE INDEX IF NOT EXISTS idx_call_transfer_offers_offer ON call_transfer_offers (offer_id);
CREATE INDEX IF NOT EXISTS idx_call_transfer_employees_employee ON call_transfer_employees (employee_id);

-- ----- Ожидание перевода переезжает в строку сотрудника (К259) ---------------
-- Решение владельца 109. Событие «Время перевода» держало ОДНО число на все
-- переводы внутрь; теперь ожидание — поле строки, своё у каждой, ровно как у
-- оффера. Событий на вкладке становится три.
--
-- ПОРЯДОК ОБЯЗАТЕЛЕН И НЕ ПЕРЕСТАВЛЯЕТСЯ — это дословное требование решения:
-- сперва число ложится в каждую строку, и ТОЛЬКО ПОТОМ исчезает событие.
-- Наоборот — потеря числа без следа, и она молчаливая: ни отказа, ни записи в
-- журнале, ни признака на экране.
--
-- ПОЧЕМУ БЛОК СТОИТ ЗДЕСЬ, А НЕ У САМОЙ ТАБЛИЦЫ СОБЫТИЙ. Ему нужны обе стороны
-- переноса, а строка сотрудника заводится строками выше. Перечень видов при
-- этом сужается последним действием — см. конец блока.
--
-- ЗАМОК СТОРОЖИТ ПОВТОР, а не «половину переезда»: внутри `DO $$` всё атомарно,
-- откат уносит и правки, и сам замок. Опасность в другом — повторись перенос,
-- второй старт перезаписал бы числа, уже правленные руками. От того же и
-- `t.wait_seconds IS NULL` в условии: два сторожа на один случай, потому что
-- цена ошибки здесь — чужая настройка.
--
-- ТРИ ШАГА У КОЛОНКИ, А НЕ ОДИН. `ADD COLUMN … NOT NULL` без умолчания падает,
-- когда строки есть, — поэтому колонка заводится пустой, наполняется переносом
-- и лишь потом становится обязательной. Умолчания у неё нет намеренно:
-- подставить число значит решить за владельца, сколько ждать.
--
-- ЕСЛИ ПЕРЕНОСИТЬ НЕЧЕГО, А СТРОКИ ЕСТЬ — отказ с ЧИСЛОМ непокрытых строк, и
-- замок не ставится. Оставить колонку необязательной значило бы разойтись и с
-- оффером, и с паспортом («все поля события обязательны»); подставить число —
-- решить за владельца. Замер 29.08.2026: в бою строк перевода ноль, на девяти
-- рабочих базах — тоже ноль, так что сегодня этот отказ выстрелить не может.
-- Он написан на завтра, когда строки заведут.
DO $$
DECLARE
    v_moved   integer := 0;
    v_missing integer := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-29-transfer-wait-move') THEN

    ALTER TABLE call_transfer_employees ADD COLUMN IF NOT EXISTS wait_seconds INTEGER;

    UPDATE call_transfer_employees t
       SET wait_seconds = e.wait_seconds
      FROM call_events e
     WHERE e.kind = 'transfer_wait'
       AND e.wait_seconds IS NOT NULL
       AND t.wait_seconds IS NULL;
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    SELECT count(*) INTO v_missing FROM call_transfer_employees WHERE wait_seconds IS NULL;
    IF v_missing > 0 THEN
        RAISE EXCEPTION '[переезд ожидания] строк без ожидания %, а переносить нечего: у события «Время перевода» число не задано. Задайте его событию или заполните строки — и повторите старт', v_missing;
    END IF;

    ALTER TABLE call_transfer_employees ALTER COLUMN wait_seconds SET NOT NULL;

    DELETE FROM call_events WHERE kind = 'transfer_wait';

    -- WARNING, а не NOTICE, и это не громкость ради громкости: `pool.query`
    -- (migrate.js) слушателя сообщений не ставит, и до приложения не доедет ни
    -- то, ни другое, — но WARNING Postgres пишет в СВОЙ журнал при умолчаниях, а
    -- NOTICE нет. Молчаливый перенос не отличить от несделанного, а строчка в
    -- журнале выкатки — единственный след, который у него будет.
    RAISE WARNING '[переезд ожидания] строк получило своё число: %; событие «Время перевода» снято', v_moved;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-29-transfer-wait-move');
    END IF;
END $$;

-- Колонка события снимается ПОСЛЕ переноса и БЕЗ замка: `IF EXISTS` сам себе
-- замок — второй раз не делает ничего и не падает. Образец отсюда же, решение
-- владельца 107 (`real_estate_offers.transfer_time`): запись в
-- `applied_migrations`, которая ничего не сторожит, через год читается как
-- имеющая смысл. Вместе с колонкой уходит и проверка `call_events_wait_check` —
-- `DROP COLUMN` уносит её сам, отдельного снятия не нужно.
ALTER TABLE call_events DROP COLUMN IF EXISTS wait_seconds;

-- ПЕРЕЧЕНЬ ВИДОВ — ПОСЛЕДНЕЕ ДЕЙСТВИЕ ПЕРЕЕЗДА. До снятия строки он падал бы на
-- живой базе, а на чистой прошёл бы молча (разбор — у самой таблицы). Имя новое,
-- прежнее снято явно выше по файлу: guard по имени иначе пропустил бы правку
-- там, где старое ограничение уже стоит.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_events_kind_rule_check') THEN
        ALTER TABLE call_events ADD CONSTRAINT call_events_kind_rule_check
            CHECK (kind IN ('auto_recall', 'transfer', 'wrapup'));
    END IF;
END $$;

-- ----- Пометка статуса: окончательный / промежуточный ------------------------
-- Решение владельца 100, оно отменяет решение 99. Признак говорит, КОНЧЕНА ЛИ
-- по статусу работа: автоперезвон смотрит на него после предела попыток —
-- окончательный отправляет лида в архив сам, промежуточный оставляет в работе.
--
-- ТРИ РАЗЛИЧИМЫХ СОСТОЯНИЯ, ТРЕТЬЕ — ПУСТОЕ. Узор трёх соседних колонок
-- (`auto_recall`, `requires_call_time`, `releases_lead` — BOOLEAN NOT NULL
-- DEFAULT false, строки 872–874) здесь повторять НЕЛЬЗЯ: умолчание молча
-- объявило бы все пятьдесят статусов промежуточными — утверждение, которого
-- никто не делал, а цена ошибки здесь — архивированный лид, с которым работают.
-- Разметка это разовая работа владельца, и до неё поле обязано быть пустым.
--
-- СТРОКОЙ, А НЕ ЛОГИЧЕСКИМ ЗНАЧЕНИЕМ, и слова русские. Журнал изменений пишет
-- значение как текст (`audit_row_change`, `to_json(NEW) ->> колонка`), а
-- расшифровка `audit_ref_map` умеет только справочники по идентификатору.
-- Логическое дало бы в журнале «true → false», а требование наряда — «читаемым
-- словом, а не числом». Перечень пришпилен ограничением, поэтому разойтись
-- значения не могут; тот же приём стоит на `real_estate_offers.status`
-- (строка 379).
--
-- К226: ПРИЁМОВ В ПРОЕКТЕ ДВА, И ОБА ЗАКОННЫЕ. Здесь стоит первый — перечень
-- в CHECK. Второй — перечень на стороне API без CHECK: так живут
-- `employees.line_type` (строка 664 говорит это прямо), `ad_platforms.status` и
-- `sources.lead_source`. По второму сделан и `call_wrapup_rules.line_type`
-- ниже: он повторяет ту самую колонку линии и обязан жить её правилами, а не
-- своими. Выбор здесь — первый, потому что значение читает журнал, а не только
-- экран: слово в базе и есть слово на экране.
ALTER TABLE lead_funnel_statuses ADD COLUMN IF NOT EXISTS mark VARCHAR;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_funnel_statuses_mark_check') THEN
        ALTER TABLE lead_funnel_statuses ADD CONSTRAINT lead_funnel_statuses_mark_check
            CHECK (mark IS NULL OR mark IN ('окончательный', 'промежуточный'));
    END IF;
END $$;

-- ----- Лид: карточка заполнена частично --------------------------------------
-- ОТДЕЛЬНЫМ ПОЛЕМ, А НЕ ВЫВОДОМ ИЗ ПУСТОТЫ ДРУГИХ (паспорт Р12): пустой
-- комментарий бывает и у полностью заполненной карточки, и вывести одно из
-- другого нельзя. Ставит признак система, когда пост-обработка закрыла карточку
-- по времени; это не ошибка и не черновик, а законченная запись с пометкой.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS partially_filled BOOLEAN NOT NULL DEFAULT false;

-- ----- Лид: кем назначено время перезвона ------------------------------------
-- Ловушка 7 из разбора куратора: смена интервала в событии обязана пересчитать
-- перезвоны, назначенные АВТОМАТИЧЕСКИ, и не тронуть назначенные РУКАМИ —
-- время, о котором оператор договорился с клиентом, наша настройка менять не
-- вправе. Отличить их постфактум нельзя ничем: в `next_call_at` лежит просто
-- момент. Значит принадлежность хранится у лида.
--
-- ПУСТО — ЗАКОННОЕ ТРЕТЬЕ СОСТОЯНИЕ: перезвон не назначен вовсе. Умолчания нет
-- по той же причине, что у пометки статуса.
--
-- ⚠ И ЧЕТВЁРТОЕ, ДОСТАВШЕЕСЯ ОТ ПРОШЛОГО (К240). Колонка приезжает на бой
-- пустой у всех, и разовый засев (`services/recallMigration.js`) размечает
-- только тех, чей статус говорит сам за себя: строка автоперезвона — 'auto',
-- признак «нужно время» — 'manual'. Прочим, у кого время назначено, а статус
-- молчит (например, оно досталось слиянием), умолчание НЕ подставляется — и
-- значит на бою законно живут лиды с `next_call_at IS NOT NULL` и пустым
-- признаком. Число таких названо в журнале выкатки. Читать пустой признак как
-- «перезвона нет» нельзя: сначала смотреть на `next_call_at`.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_call_source VARCHAR;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_next_call_source_check') THEN
        ALTER TABLE leads ADD CONSTRAINT leads_next_call_source_check
            CHECK (next_call_source IS NULL OR next_call_source IN ('auto', 'manual'));
    END IF;
END $$;

-- ----- Пары «скрипт + статус»: каскад становится запретом ---------------------
-- `lead_script_statuses.funnel_status_id` объявлен ON DELETE CASCADE (строка
-- 684). Пока справочник статусов не правился, это ничего не значило; со следующим
-- заходом статус можно будет удалить — и пары ушли бы МОЛЧА, вместе с настройкой
-- скриптов у лидов. Отказ удаления в паспорте Р11 считает эти пары второй
-- помехой и называет их число, а посчитать нечего, если база уже их убрала.
--
-- ⚠ ТОЛЬКО ЭТА СВЯЗЬ. `lead_id` (строка 683) и `script_id` (миграция ниже, 2449)
-- остаются каскадом НАМЕРЕННО: перевести все три «заодно» значит сломать
-- удаление лида и удаление скрипта, у которых своё правило.
--
-- Замок внешний: имя ограничения у связи задаётся Postgres автоматически, и
-- различить «связь уже переведена» и «связь переведена и вручную возвращена»
-- изнутри каталога нельзя.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-26-lss-status-restrict') THEN

    ALTER TABLE lead_script_statuses
        DROP CONSTRAINT IF EXISTS lead_script_statuses_funnel_status_id_fkey;
    ALTER TABLE lead_script_statuses
        ADD CONSTRAINT lead_script_statuses_funnel_status_id_fkey
        FOREIGN KEY (funnel_status_id) REFERENCES lead_funnel_statuses(id) ON DELETE RESTRICT;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-26-lss-status-restrict');
    END IF;
END $$;

-- ----- Сегодняшние числа переезжают в события --------------------------------
-- ЧТОБЫ В ДЕНЬ ВЫКАТКИ НЕ ИЗМЕНИЛОСЬ НИЧЕГО. Требование наряда, раздел 8:
-- умолчания равны сегодняшним числам. Пустое событие «Автоперезвон» означало бы,
-- что обзвон выключился в день выкатки, — а заход 2 только учится читать эти
-- строки вместо констант, и прочитать он должен ровно то, что стоит в коде.
--
-- ЧЕТЫРЕ СТАТУСА — те же, что проставила миграция флагов 15.08.2026 (строка 887),
-- и берутся они ИЗ САМИХ ФЛАГОВ, а не переписыванием списка названий: список,
-- переписанный второй раз, разойдётся с первым на первой же правке.
--
-- ОСТАЛЬНЫЕ ДВА СОБЫТИЯ ЗАВОДЯТСЯ ВЫКЛЮЧЕННЫМИ И ПУСТЫМИ, и это тоже
-- сегодняшнее поведение: переводов система сегодня не делает вовсе, а
-- пост-обработка не кончается сама. Строка-итог на вкладке скажет об этом
-- словами.
--
-- ⚠ ВИДОВ ЗДЕСЬ ТРИ, А БЫЛО ЧЕТЫРЕ (решение владельца 109, К259). Убрать
-- `transfer_wait` из засева обязательно, хотя блок и стоит под замком: на
-- ЧИСТОЙ базе замка нет, засев исполняется — и вставил бы вид, которого больше
-- не бывает, в таблицу, чей перечень видов переезд выше уже сузил. Старт упал
-- бы, и упал бы ровно там, где всё выглядит новым и правильным. Колонки
-- `wait_seconds` в перечне тоже нет: тот же переезд снимает её раньше.
DO $$
DECLARE
    v_no_answer integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-26-call-events-seed') THEN

    INSERT INTO call_events (kind, enabled, window_from, window_to) VALUES
        ('auto_recall', true,  TIME '09:00', TIME '21:00'),
        ('transfer',    false, NULL,         NULL),
        ('wrapup',      false, NULL,         NULL)
    ON CONFLICT (kind) DO NOTHING;

    -- Статус после предела до захода 2 был один на всех — константа
    -- NO_ANSWER_STATUS_NAME в `services/leadCallRules.js`. Из рабочего пути она
    -- снята (ответ куратора 16), и здесь, в засеве, осталось её единственное
    -- употребление: искать статус по этапу 1 и точному имени. Замок держит его
    -- разовым — заводить статус повторно этот блок не станет.
    SELECT id INTO v_no_answer
      FROM lead_funnel_statuses
     WHERE stage_number = 1 AND status_name = 'Не ответил после N перезвонов'
     LIMIT 1;

    -- Строки не заводятся вовсе, если целевого статуса в справочнике нет:
    -- правило без статуса после предела неполно, а выдумывать ему замену
    -- значит решить за владельца, куда уходит лид. Код в этом случае и сегодня
    -- пишет ошибку в лог и оставляет лида на месте.
    IF v_no_answer IS NOT NULL THEN
        INSERT INTO call_recall_rules (funnel_status_id, interval_minutes, max_attempts, after_limit_status_id)
        SELECT s.id, 60, 20, v_no_answer
          FROM lead_funnel_statuses s
         WHERE s.auto_recall
        ON CONFLICT (funnel_status_id) DO NOTHING;
    ELSE
        RAISE WARNING '[события] Статуса «Не ответил после N перезвонов» нет — строки автоперезвона не засеяны';
    END IF;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-26-call-events-seed');
    END IF;
END $$;

-- ----- Правила аудита для новых таблиц ---------------------------------------
-- УРОК ЧАСТИ 7А: без правил журнал показывает правку события как «изменилось
-- поле у чего-то» — без имени записи и без ссылки.
--
-- КАРТОЧКИ У СОБЫТИЯ НЕТ, и это не пропуск. Событие живёт строкой на вкладке
-- «Звонки → События»; открывать по ссылке нечего. Тот же случай, что у участка
-- звонка (`call_segments`, строка 2608): имя есть, ссылки нет.
--
-- ЧЕМ НАЗВАТЬ ЗАПИСЬ. Событие — своим видом: строк всего три, и вид у них
-- уникален. Строки перечней — тем адресатом, о котором они: правило
-- автоперезвона своего имени не имеет вовсе (в нём одни ссылки), поэтому
-- называется номером записи, а расшифровка ниже дописывает имя статуса.
INSERT INTO audit_rules (table_name, column_name, title_columns, key_column, card_table, card_column) VALUES
    ('call_events',              '*', 'kind',           'id', NULL, NULL),
    ('call_recall_rules',        '*', NULL,             'id', NULL, NULL),
    ('call_wrapup_rules',        '*', 'line_type',      'id', NULL, NULL),
    ('call_transfer_offers',     '*', 'transfer_phone', 'id', NULL, NULL),
    ('call_transfer_employees',  '*', NULL,             'id', NULL, NULL)
ON CONFLICT (table_name, column_name) DO NOTHING;

-- РАСШИФРОВКА ССЫЛОК. «Статус: 3 → 7» не говорит ничего.
INSERT INTO audit_ref_map (table_name, column_name, ref_table, ref_title_columns) VALUES
    ('call_recall_rules',       'funnel_status_id',      'lead_funnel_statuses', 'status_name'),
    ('call_recall_rules',       'after_limit_status_id', 'lead_funnel_statuses', 'status_name'),
    ('call_wrapup_rules',       'script_id',             'scripts',              'title'),
    ('call_transfer_offers',    'offer_id',              'real_estate_offers',   'name'),
    ('call_transfer_employees', 'employee_id',           'employees',            'last_name first_name')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- `updated_at` события в журнал не пишется — решение владельца 101. Замок свой:
-- прежний ('2026-08-26-audit-skip-updated-at', конец файла) на боевой базе уже
-- сработал, и дописанное в него не доедет туда никогда.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-26-audit-skip-call-events') THEN

    INSERT INTO audit_rules (table_name, column_name, level) VALUES
        ('call_events', 'updated_at', 'skip')
    ON CONFLICT (table_name, column_name) DO NOTHING;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-26-audit-skip-call-events');
    END IF;
END $$;

-- ============================================================================
-- ЧАСТЬ 9, ЗАХОД 6: СИСТЕМНЫЙ ЭТАП И СТАТУС «НЕТ РЕЗУЛЬТАТА»
-- ============================================================================
--
-- Решение владельца 106: карточка, которую закрыла пост-обработка без статуса,
-- получает статус «Нет результата» — красный, системный, до решения
-- руководителя. Лид при этом выходит из очереди: это и есть та половина круга,
-- из-за которой заход и заведён отдельным.
--
-- ⚠ СТОИТ ДО ПЕРЕБОРА ТРИГГЕРОВ. Новая таблица получает аудит на первом же
-- старте только если объявлена выше цикла; объявленная ниже — со второго, и
-- правки первого дня в журнал не попадут вовсе (урок части 9, заход 1).

-- ----- Этапы воронки отдельной таблицей --------------------------------------
--
-- ЗАЧЕМ ТАБЛИЦА, А НЕ ПОЛЕ У СТАТУСА. Описание, лежащее в пятидесяти строках, —
-- это пятьдесят правок на одну, и запись «этап» становится неопределимой.
--
-- ⚠ ИМЯ ЭТАПА СЮДА ПОКА НЕ ПЕРЕЕХАЛО, И ЭТО НЕ ЗАБЫВЧИВОСТЬ. `stage_name`
-- размазан по строкам `lead_funnel_statuses`, и свести его сюда значит править
-- восемь мест чтения (`routes/leadFunnelStatuses.js`, `routes/callEvents.js`,
-- `routes/leadsAdmin.js`, `Shell/history/historyFields.js`,
-- `Leads/js/modules/leadsModal.js`, `leadsPickList.js`, `leadsScriptPairs.js`,
-- `Operator/js/modules/operatorLeadForm.js`) ради того, что сегодня не правится
-- вовсе: имена этапов владелец менять не собирается. Часть 9 переписывать
-- модель не нанималась. Переезд имени — отдельная задача со своим разбором.
--
-- СТРОКИ ЕСТЬ У ВСЕХ ЭТАПОВ, А НЕ ТОЛЬКО У СИСТЕМНОГО. Иначе «этап есть, а
-- строки нет» становится законным состоянием, и каждый читающий обязан о нём
-- помнить.
CREATE TABLE IF NOT EXISTS lead_funnel_stages (
    id SERIAL PRIMARY KEY,
    stage_number INTEGER NOT NULL UNIQUE,
    -- Пусто у всех этапов, кроме системного: остальные объяснять нечем — их
    -- смысл виден по имени и по составу статусов. Правку описания сервер
    -- разрешает только системному, см. `routes/leadFunnelStatuses.js`.
    description TEXT
);

-- ----- Два признака у статуса ------------------------------------------------
--
-- ПРИЗНАКОВ ДВА, И ОДНИМ НЕ ОБОЙТИСЬ. «Не ответил после N перезвонов» тоже
-- ставится системой, но красным не показывается и решения руководителя не ждёт:
-- по нему работа кончена, лид уходит в архив. Одним признаком эти два случая
-- неразличимы.
--
-- ⚠ ИМЕНА ПРО ПОВЕДЕНИЕ, А НЕ ПРО ВИД. Колонки `show_red` здесь нет и не будет:
-- колонка, названная по виду, привязывает данные к решению экрана. Скажет
-- владелец «пусть будет значок вместо цвета» — и придётся либо переименовывать
-- колонку в живой базе, либо оставлять `show_red`, который рисует не красное.
-- Красный — это то, КАК слой рисует смысл, и решает это экран.
ALTER TABLE lead_funnel_statuses ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lead_funnel_statuses ADD COLUMN IF NOT EXISTS awaits_manager BOOLEAN NOT NULL DEFAULT false;

-- ----- Целевой статус тайм-аута — полем события, а не поиском по имени --------
--
-- ТРЕТИЙ ПОИСК СТАТУСА ПО ИМЕНИ ЗАВОДИТЬ НЕЛЬЗЯ. Заход 2 убрал
-- `findNoAnswerStatusId`, заход 4 сделал имена правимыми — искать статус строкой
-- «Нет результата» значило бы завести такой поиск ровно в тот день, когда
-- переименование стало законным.
--
-- Поле заполняется выкаткой и на экране показывается строкой, а не выбором:
-- правку его владелец не заказывал.
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS wrapup_status_id INTEGER
    REFERENCES lead_funnel_statuses(id) ON DELETE RESTRICT;

DO $$
BEGIN
    -- Целевой статус — только у пост-обработки, как окно только у автоперезвона.
    -- Заполненная не тем видом колонка молча ничего не делала бы.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_events_wrapup_status_check') THEN
        ALTER TABLE call_events ADD CONSTRAINT call_events_wrapup_status_check
            CHECK (wrapup_status_id IS NULL OR kind = 'wrapup');
    END IF;
END $$;

-- ----- Системный этап, его статусы и целевой статус тайм-аута ----------------
--
-- ЗАМОК СВОЙ (правило К227). Блок заводит правимое содержимое: описание этапа
-- правит руководитель, имя статуса — тоже. Без замка переименованный статус
-- воскресал бы двойником при каждом старте.
--
-- ЭТАП ЗАВОДИТСЯ ВЫКАТКОЙ, А НЕ ЭКРАНОМ. Наряд запрещал заводить этапы вовсе;
-- решение владельца сильнее, и запрет снят наполовину: этап приезжает выкаткой
-- один раз, а экран завести этап по-прежнему не даёт — проверка захода 4
-- остаётся на месте.
DO $$
DECLARE
    v_no_result INTEGER;
    v_moved INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-27-system-stage-seed') THEN

    INSERT INTO lead_funnel_statuses
        (stage_number, stage_name, status_name, sort_order, is_system, awaits_manager, mark)
    VALUES
        (7, 'Системные статусы', 'Нет результата', 1, true, true, 'промежуточный')
    ON CONFLICT (stage_number, status_name) DO NOTHING;

    -- ПОМЕТКА СТАВИТСЯ ЗДЕСЬ, И ЭТО НЕ ДОГАДКА. Разметка статусов — разовая
    -- работа владельца, и угадывать за него запрещено; но про этот статус он
    -- сказал сам: «промежуточный, пока руководитель не исправит». Прочим
    -- статусам пометку эта миграция не трогает.
    SELECT id INTO v_no_result
      FROM lead_funnel_statuses
     WHERE stage_number = 7 AND status_name = 'Нет результата';

    INSERT INTO lead_funnel_stages (stage_number, description) VALUES
        (7, 'Эти статусы ставит система, а не человек. «Нет результата» — когда время '
            || 'пост-обработки вышло, а оператор статус не выбрал. «Не ответил после N '
            || 'перезвонов» — когда исчерпан предел попыток автоперезвона. Лид с системным '
            || 'статусом не раздаётся, пока ему не поставят настоящий.')
    ON CONFLICT (stage_number) DO NOTHING;

    -- ПЕРЕЕЗД, А НЕ ЗАВЕДЕНИЕ ЗАНОВО. Меняется номер этапа у существующей
    -- строки: лиды на этом статусе не трогаются, ссылки правил автоперезвона
    -- (`after_limit_status_id`) не рвутся — они по идентификатору.
    --
    -- ИЩЕТСЯ ПО ИМЕНИ, И ЭТО ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ТАК МОЖНО: разовая
    -- миграция под замком, ровно как засев правил автоперезвона в заходе 1.
    -- Не нашлось — кричим в лог, а не заводим двойника молча.
    UPDATE lead_funnel_statuses
       SET stage_number = 7, stage_name = 'Системные статусы', sort_order = 2, is_system = true
     WHERE stage_number = 1 AND status_name = 'Не ответил после N перезвонов';
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved = 0 THEN
        RAISE WARNING '[системный этап] Статус «Не ответил после N перезвонов» на этапе 1 не найден — переезд не выполнен';
    END IF;

    IF v_no_result IS NOT NULL THEN
        UPDATE call_events SET wrapup_status_id = v_no_result WHERE kind = 'wrapup';
    ELSE
        RAISE WARNING '[системный этап] Статус «Нет результата» не заведён — целевой статус пост-обработки пуст';
    END IF;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-27-system-stage-seed');
    END IF;
END $$;

-- ----- Строки этапов для всех остальных --------------------------------------
--
-- БЕЗ ЗАМКА, И ЭТО ОСОЗНАННО. Замок сторожит правимое содержимое: он не даёт
-- воскреснуть переименованному или удалённому. Здесь вставляется только номер
-- этапа — то, чего человек не правит вовсе: экран завести или удалить этап не
-- даёт. Строка этапа без описания — не запись, а недостающая половина
-- инварианта «у каждого этапа есть строка», и восстанавливать её при каждом
-- старте правильно. Уже заведённые строки `ON CONFLICT` не трогает, и правленое
-- описание переживает любой перезапуск.
INSERT INTO lead_funnel_stages (stage_number)
SELECT DISTINCT stage_number FROM lead_funnel_statuses
ON CONFLICT (stage_number) DO NOTHING;

-- ============================================================================
-- ЧАСТЬ 9, ЗАХОД 7: МИГРАЦИИ В ПОЛЁТЕ
-- ============================================================================
--
-- Разовые правки того, что уже лежит в бою. Ни одного пикселя не меняют.
-- Пересчёт назначенных перезвонов живёт НЕ ЗДЕСЬ, а в
-- `services/recallMigration.js` — разбор в шапке того файла: правило времени в
-- проекте одно, и на plpgsql его вторым разом не пишут.

-- ----- Приоритет оффера: недостающим ставится 1 ------------------------------
--
-- Решение владельца 105. Замер до миграции снят на бою неизменяющим запросом
-- 27.08.2026: приоритет пуст у 39 офферов из 39 — то есть она трогает всех до
-- единого, а не хвост. Это то число, ради которого замер и заказывался: их
-- владельцу размечать руками.
--
-- ОБЯЗАТЕЛЬНОСТЬ ЕДЕТ ТЕМ ЖЕ КОММИТОМ (К228), и порознь нельзя: обязательность
-- без миграции — это тридцать девять заблокированных карточек. Проверка живёт в
-- `routes/realEstateOffers.js`, здесь только заполнение пустого.
--
-- ⚠ МИГРАЦИЯ ПОДПИСЫВАЕТ СЕБЯ САМА. Триггер журнала читает автора из настроек
-- соединения; без них семь записей выкатки части 5 остались с «автора нет» —
-- по существу неправда, их сделала миграция. Решение владельца 98 говорит
-- обратное. Третий параметр `true` — настройка живёт до конца транзакции и не
-- течёт в соседние запросы соединения.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-28-offer-priority-fill') THEN

    PERFORM set_config('crm.audit_actor_kind', 'service', true);
    PERFORM set_config('crm.audit_actor_name', 'Миграция', true);

    UPDATE real_estate_offers SET priority = 1 WHERE priority IS NULL;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-28-offer-priority-fill');
    END IF;
END $$;

-- ----- «Время для перевода»: переносить нечего ------------------------------
--
-- Наряд просил список «оффер → что стояло», чтобы окна перевода заводили по
-- бумажке, а не вслепую. СПИСОК ПУСТ: замер на бою 27.08.2026 — `transfer_time`
-- заполнен у 0 офферов из 39. Значит миграции здесь нет вовсе, и это сказано
-- словами, а не пропущено молчанием: пропуск читался бы как «забыли».
--
-- СЛОВО ВЛАДЕЛЬЦА ПОЛУЧЕНО 28.08.2026 (решение 107) — колонка снята, строка
-- снятия стоит рядом с `obj_classes`. Абзац выше остаётся не по инерции: он и
-- объясняет, почему при удалении не появилось миграции ДАННЫХ. Переносить было
-- нечего — это факт замера, а не пропуск работы.

-- ----- Правила аудита нового ------------------------------------------------
-- Этап называется своим номером: имени у него в этой таблице нет (см. выше),
-- а описание — то самое поле, правки которого и надо видеть в журнале.
INSERT INTO audit_rules (table_name, column_name, title_columns, key_column, card_table, card_column) VALUES
    ('lead_funnel_stages', '*', 'stage_number', 'id', NULL, NULL)
ON CONFLICT (table_name, column_name) DO NOTHING;

INSERT INTO audit_ref_map (table_name, column_name, ref_table, ref_title_columns) VALUES
    ('call_events', 'wrapup_status_id', 'lead_funnel_statuses', 'status_name')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- ----- Подключение триггера ко всем таблицам --------------------------------
-- Перебором, а не списком: новая таблица подключается САМА, при первом же
-- старте сервера после её появления. Иначе про аудит пришлось бы помнить при
-- каждой новой функции — а помнят не всегда, и дыру в журнале потом не видно.
--
-- Не подключаются три:
--   audit_log и его полки — иначе триггер писал бы сам о себе без конца;
--   audit_batches         — служебная бухгалтерия партии, её содержимое видно
--                           в самих записях партии;
--   applied_migrations    — машинный учёт накатанных миграций, к человеку
--                           отношения не имеет, строк даст много, смысла ноль
--                           (решение куратора, ответ 9 по Р5);
--   pbx_events и его полки — сырые сообщения станции. Их до полутора десятков
--                           НА КАЖДЫЙ звонок и полтора миллиона за полгода;
--                           человек их не правит вовсе, а журнал изменений
--                           хранится бессрочно. Сама таблица разрезана и в
--                           перебор не попадает (relkind = 'p'), но ПОЛКИ —
--                           обычные таблицы, и без этой строки триггер повесился
--                           бы на каждую.
--
-- Таблицы настроек и правил аудита В ЖУРНАЛ ПИШУТСЯ, и это отдельное решение:
-- изменение настройки объясняет поведение системы, а «кто и когда решил
-- что-то не записывать» обязано остаться записанным.
DO $$
DECLARE
    v_table record;
BEGIN
    FOR v_table IN
        SELECT c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relname NOT IN ('audit_log', 'audit_batches', 'applied_migrations', 'pbx_events')
           AND c.relname NOT LIKE 'audit_log_%'
           AND c.relname NOT LIKE 'pbx_events_%'
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS audit_trg ON %I', v_table.name);
        EXECUTE format(
            'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OR DELETE ON %I'
            || ' FOR EACH ROW EXECUTE FUNCTION audit_row_change()', v_table.name);
    END LOOP;
END $$;

-- ===== СКРИПТЫ ЛИДА ПАРАМИ ====================================================
-- Решения владельца 82–88 от 25.08.2026. Было: у лида ОДИН скрипт, ОДИН общий
-- список статусов показа и отдельное поле «повторный скрипт», которое включалось
-- само на этапах 5–6. Стало: до пяти пар «скрипт + его статусы», и при указанных
-- статусах открывается выбранный скрипт.
--
-- ПОЧЕМУ ПАРА ХРАНИТСЯ СТРОКОЙ НА КАЖДЫЙ СТАТУС, А НЕ СПИСКОМ В ОДНОЙ СТРОКЕ.
-- Первичный ключ (lead_id, funnel_status_id) уже стоит на этой таблице — и он
-- ДАРОМ даёт главное правило владельца (решение 83): один статус может стоять
-- только в одной паре одного лида. Хранили бы пару строкой со списком статусов —
-- пришлось бы проверять пересечение списков руками, в приложении, и оно
-- разошлось бы с базой при первом же обходе интерфейса.

ALTER TABLE lead_script_statuses ADD COLUMN IF NOT EXISTS script_id INTEGER REFERENCES scripts(id) ON DELETE CASCADE;

-- Перенос прежних данных ПОД ЗАМКОМ: это утверждение о прошлом, а не приведение
-- к правилу. Прежний общий список статусов относился к leads.script_id — значит
-- он и есть первая пара. Строки лидов без скрипта пары не образуют и удаляются:
-- статус показа без скрипта не значит ничего.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-25-lead-script-pairs') THEN
        UPDATE lead_script_statuses lss
           SET script_id = l.script_id
          FROM leads l
         WHERE l.id = lss.lead_id AND lss.script_id IS NULL AND l.script_id IS NOT NULL;

        DELETE FROM lead_script_statuses WHERE script_id IS NULL;

        INSERT INTO applied_migrations (id) VALUES ('2026-08-25-lead-script-pairs');
        RAISE NOTICE 'Скрипты лида: прежние списки статусов перенесены в пары';
    END IF;
END $$;

-- NOT NULL ставится ПОСЛЕ переноса и только когда переносить больше нечего.
-- Отдельным блоком, а не в ADD COLUMN: на первом старте колонка появляется
-- пустой, и NOT NULL уронил бы весь пакет.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'lead_script_statuses' AND column_name = 'script_id'
           AND is_nullable = 'YES'
    ) AND NOT EXISTS (SELECT 1 FROM lead_script_statuses WHERE script_id IS NULL) THEN
        ALTER TABLE lead_script_statuses ALTER COLUMN script_id SET NOT NULL;
    END IF;
END $$;

-- Поиск «какой скрипт у этого лида при этом статусе» идёт по первичному ключу.
-- А вот обратный вопрос — «какие лиды используют этот скрипт» — нужен запрету
-- удаления скрипта, и для него свой индекс.
CREATE INDEX IF NOT EXISTS idx_lead_script_statuses_script ON lead_script_statuses (script_id);

-- ----- Поле «повторный скрипт» уходит -----------------------------------------
-- Решение владельца 82. Повторный скрипт — это просто пара, в которой выбраны
-- повторные статусы; отдельное поле и правило «этап 5–6 включает его сам» больше
-- не нужны.
--
-- DROP COLUMN необратим, поэтому перед ним проверка пустоты — правило проекта.
-- На бою 25.08.2026 колонка пуста у всех трёх лидов (проверено запросом), но
-- проверка стоит в коде, а не в отчёте: файл прогоняется и на чужих копиях.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'leads' AND column_name = 'repeat_script_id'
    ) AND NOT EXISTS (SELECT 1 FROM leads WHERE repeat_script_id IS NOT NULL) THEN
        ALTER TABLE leads DROP COLUMN repeat_script_id;
        RAISE NOTICE 'Скрипты лида: поле repeat_script_id снято (было пусто)';
    END IF;
END $$;

-- leads.script_id ОСТАЁТСЯ, и это осознанно. Данные из неё перенесены, писать в
-- неё сервер перестал, но её ещё читает разметка «Лидов» — колонка «Скрипт» в
-- таблице и поле в карточке. Снимет её та часть, которая соберёт экран пар:
-- уронить колонку раньше клиента значит уронить раздел.

-- ----- Журнал обязан называть скрипт пары словом ------------------------------
-- Колонка script_id появилась В СУЩЕСТВУЮЩЕЙ таблице, у которой уже стоит триггер
-- аудита. Значит правка пары попадёт в журнал сразу — и без строки в карте
-- расшифровки покажется как «script_id: 3 → 7». Ровно то, ради чего карта и
-- заведена: «Статус: 3 → 7» человеку не говорит ничего.
--
-- Замка не нужно, и это не небрежность: карта дополняется по мере появления
-- ссылок, конфликт по (table_name, column_name) гасится сам — тот же приём, что
-- у карты причин разбора номеров ниже по файлу.
INSERT INTO audit_ref_map (table_name, column_name, ref_table, ref_title_columns) VALUES
    ('lead_script_statuses', 'script_id', 'scripts', 'title')
ON CONFLICT (table_name, column_name) DO NOTHING;

-- И уборка за собой: строка карты на leads.repeat_script_id указывает на
-- колонку, которой больше нет. Вреда от неё нет — карту читают по имени
-- колонки, а такой колонки не встретится, — но мёртвая строка в карте
-- расшифровки через полгода читается как «а почему не работает».
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'leads' AND column_name = 'repeat_script_id'
    ) THEN
        DELETE FROM audit_ref_map WHERE table_name = 'leads' AND column_name = 'repeat_script_id';
    END IF;
END $$;

-- ----- Третий вид куска скрипта: фраза для перевода ---------------------------
-- Решение владельца 86. Одна на весь скрипт, стоит ДО списка возражений,
-- правится той же полосой инструментов, заполнять не обязательно.
--
-- CHECK ПЕРЕСОБИРАЕТСЯ, А НЕ ДОПИСЫВАЕТСЯ: у ограничения нет «добавить значение».
-- Снимаем по имени и ставим заново — обе операции под проверкой существования,
-- иначе второй старт упадёт на попытке снять уже снятое.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'script_nodes_node_type_check'
           AND pg_get_constraintdef(oid) NOT LIKE '%transfer%'
    ) THEN
        ALTER TABLE script_nodes DROP CONSTRAINT script_nodes_node_type_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'script_nodes_node_type_check') THEN
        ALTER TABLE script_nodes ADD CONSTRAINT script_nodes_node_type_check
            CHECK (node_type IN ('statement', 'objection', 'transfer'));
    END IF;
END $$;

-- ОДНА ФРАЗА НА СКРИПТ — правилом базы, а не обещанием приложения. Частичный
-- уникальный индекс: на прочие виды кусков он не распространяется, их у скрипта
-- сколько угодно.
CREATE UNIQUE INDEX IF NOT EXISTS idx_script_nodes_one_transfer
    ON script_nodes (script_id) WHERE node_type = 'transfer';


-- ===== ЧАСТЬ 8 · ЭКРАН «ИСТОРИЯ ИЗМЕНЕНИЙ» ===================================
-- Правила аудита для таблиц, заведённых ПОСЛЕ семени части 3. Экран журнала —
-- первое место, где отсутствие правила видно глазом, и оно же единственное:
-- в базе строка без имени записи ничем себя не выдаёт.
--
-- ЧТО БЫЛО НЕ ТАК. Семя части 3 знает 34 таблицы (`2026-08-24-audit-rules-seed`).
-- Часть 4 завела справочник причин `phone_fix_reasons`, часть 7А — `calls` и
-- `call_segments`; правил ни у одной из трёх нет. Триггер при этом на них
-- висит — он вешается перебором, — и запись уходит в журнал БЕЗ ИМЕНИ
-- (`record_title` пуст) и без указания, чью карточку открывать. На экране это
-- строка «изменилось поле у чего-то».
--
-- ОТДЕЛЬНЫЙ ЗАМОК, А НЕ ПРАВКА СТАРОГО БЛОКА. На боевой базе
-- `2026-08-24-audit-rules-seed` уже сработал, и дописанное в тот блок туда не
-- доедет никогда — ровно тот же случай, что с именем записи источника ниже по
-- файлу. `ON CONFLICT DO NOTHING` сверх замка: снятое человеком правило не
-- должно воскресать, а замок один на всю вставку.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-26-audit-rules-calls') THEN

    -- ЧЕМ НАЗВАТЬ ЗАПИСЬ.
    --
    -- Звонок называется НОМЕРОМ КЛИЕНТА, а не направлением и не временем.
    -- Направление — служебные 'in'/'out', в подписи они читались бы как ошибка
    -- перевода; время уже стоит в первой колонке журнала своей. Номер — то
    -- единственное, по чему человек узнаёт звонок в списке.
    --
    -- КАРТОЧКА ЗВОНКА — КАРТОЧКА ЛИДА. Своей карточки у звонка нет и не будет:
    -- в разделе «Звонки» он живёт строкой. У внутреннего звонка `lead_id` пуст
    -- по построению — тогда ссылки нет вовсе, и это честно: карточки, которую
    -- она бы открыла, не существует.
    --
    -- У УЧАСТКА НЕТ НИ ИМЕНИ, НИ КАРТОЧКИ. Владелец участка — звонок, а у
    -- звонка карточки нет; вести на лида через звонок значит идти в два шага, а
    -- правило знает только один. Строка журнала остаётся читаемой: «участок
    -- звонка», номер записи и список изменившихся полей.
    INSERT INTO audit_rules (table_name, column_name, title_columns, key_column, card_table, card_column) VALUES
        ('calls',              '*', 'client_phone', 'id', 'leads', 'lead_id'),
        ('call_segments',      '*', NULL,           'id', NULL,    NULL),
        ('phone_fix_reasons',  '*', 'title',        'id', NULL,    NULL)
    ON CONFLICT (table_name, column_name) DO NOTHING;

    -- РАСШИФРОВКА ССЫЛОК. «Лид: 1042 → 1043» человеку не говорит ничего.
    --
    -- СТАТУСА ЗДЕСЬ НЕТ, И ЭТО НЕ ПРОПУСК. `calls.funnel_status_id` лежит
    -- СНИМКОМ, рядом с `funnel_status_name`, снятым в момент завершения звонка.
    -- Расшифровать его через справочник значило бы подставить сегодняшнее имя
    -- статуса в запись о прошлом — ровно то, ради чего снимок и заведён.
    INSERT INTO audit_ref_map (table_name, column_name, ref_table, ref_title_columns) VALUES
        ('calls',         'lead_id',     'leads',     'last_name first_name phone'),
        ('calls',         'employee_id', 'employees', 'last_name first_name'),
        ('call_segments', 'call_id',     'calls',     'client_phone'),
        ('call_segments', 'employee_id', 'employees', 'last_name first_name')
    ON CONFLICT (table_name, column_name) DO NOTHING;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-26-audit-rules-calls');
    END IF;
END $$;

-- ФАКТ ВЫГРУЗКИ ЖУРНАЛА пишется в сам журнал строкой с `op = 'export'`
-- (бриф, часть 8, пункт 4). Ограничения на `op` у `audit_log` нет вовсе, и
-- заводить его сейчас нельзя: это единственная запись не от триггера, и
-- перечень видов операций пришлось бы держать в двух местах сразу.
--
-- Автор такой строки — ЧЕЛОВЕК, нажавший кнопку, из контекста запроса, а не
-- служебный: выгрузку делает человек, и в журнале должен стоять он.


-- ===== РЕШЕНИЕ ВЛАДЕЛЬЦА 101 · `updated_at` В ЖУРНАЛ НЕ ПИШЕТСЯ ==============
-- Довод не «шум», а ПОВТОР. Новое значение `updated_at` совпадает с колонкой
-- `changed_at` самой строки журнала до секунды: код пишет `NOW()` тем же
-- действием, которое ловит триггер. Прежнее значение — время предыдущей правки
-- той же записи, то есть строка журнала выше по этой же записи. Журнал пишет
-- дважды один факт, а хранится он бессрочно и станет самой большой таблицей
-- базы.
--
-- ЗАМЕР, А НЕ ОЩУЩЕНИЕ (копия рабочей базы, 26.08.2026): строк «изменение»
-- 2346, из них тащат `updated_at` 564 — каждая четвёртая. Строк, где кроме неё
-- не изменилось ничего, — НОЛЬ: неправды журнал из-за неё не говорил, потому
-- это и не корректировка приёмки, а отдельная работа.
--
-- ШЕСТЬ ТАБЛИЦ — те, у кого эта колонка есть на `4c63128`. Новая таблица с
-- такой же колонкой правила не получит: замок сработает один раз, и ей
-- понадобится свой. Это осознанно — «правило сняли осознанно» и «правило ещё не
-- заводили» изнутри таблицы неразличимы, поэтому замок внешний.
--
-- ЗАПИСАННОЕ НЕ ПЕРЕПИСЫВАЕТСЯ. Те 564 строки остаются как есть: журнал
-- дополняют, а не правят задним числом.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applied_migrations WHERE id = '2026-08-26-audit-skip-updated-at') THEN

    INSERT INTO audit_rules (table_name, column_name, level) VALUES
        ('leads',                    'updated_at', 'skip'),
        ('calls',                    'updated_at', 'skip'),
        ('sources',                  'updated_at', 'skip'),
        ('app_settings',             'updated_at', 'skip'),
        ('employee_column_settings', 'updated_at', 'skip'),
        ('knowledge_articles',       'updated_at', 'skip')
    ON CONFLICT (table_name, column_name) DO NOTHING;

    INSERT INTO applied_migrations (id) VALUES ('2026-08-26-audit-skip-updated-at');
    END IF;
END $$;
