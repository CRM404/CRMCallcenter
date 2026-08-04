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
