// --- storage.js: клиент REST API бэкенда (Node.js + Express + PostgreSQL) ---

// Базовый адрес API — единственное место, которое нужно поменять при переезде на боевой сервер.
export const API_BASE_URL = 'https://crmcallcenter-production.up.railway.app/api';

// Соответствие ключей полей формы (camelCase) типам документов в БД/API (snake_case).
export const DOCUMENT_TYPE_MAP = {
    passportFront: 'passport_front',
    passportBack: 'passport_back',
    patent: 'patent',
    contract: 'contract',
    additionalAgreement: 'additional_agreement'
};

async function request(path, options = {}) {
    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
    } catch (e) {
        throw new Error('Не удалось связаться с сервером. Проверьте подключение.');
    }

    if (response.status === 204) return null;

    let body = null;
    try {
        body = await response.json();
    } catch (e) {
        // тело может отсутствовать при некоторых ошибках — игнорируем
    }

    if (!response.ok) {
        throw new Error((body && body.error) || 'Произошла ошибка на сервере');
    }
    return body;
}

function buildQuery(filters) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '' && value !== false) {
            params.set(key, value);
        }
    });
    const query = params.toString();
    return query ? `?${query}` : '';
}

// --- Сотрудники ---

export function fetchEmployees(filters = {}) {
    return request(`/employees${buildQuery(filters)}`);
}

export function fetchEmployeeById(id) {
    return request(`/employees/${id}`);
}

export function fetchManagerList(excludeId) {
    return request(`/employees/list-for-manager${buildQuery({ excludeId })}`);
}

export function createEmployee(data) {
    return request('/employees', { method: 'POST', body: JSON.stringify(data) });
}

export function updateEmployee(id, data) {
    return request(`/employees/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteEmployee(id) {
    return request(`/employees/${id}`, { method: 'DELETE' });
}

// --- Документы сотрудника ---

export function fetchEmployeeDocuments(employeeId) {
    return request(`/employees/${employeeId}/documents`);
}

export function uploadEmployeeDocument(employeeId, documentType, fileName, fileData) {
    return request(`/employees/${employeeId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ documentType, fileName, fileData })
    });
}
