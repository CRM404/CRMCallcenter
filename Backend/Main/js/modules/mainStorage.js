// --- mainStorage.js: клиент REST API для главной страницы (раздел "Реквизиты") ---

export const API_BASE_URL = '/api';

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
        const err = new Error((body && body.error) || 'Произошла ошибка на сервере');
        err.status = response.status;
        throw err;
    }
    return body;
}

export function fetchOrganization() {
    return request('/organization');
}

export function createOrganization(data) {
    return request('/organization', { method: 'POST', body: JSON.stringify(data) });
}

export function updateOrganization(id, data) {
    return request(`/organization/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function createBankAccount(organizationId, data) {
    return request(`/organization/${organizationId}/bank-accounts`, { method: 'POST', body: JSON.stringify(data) });
}

export function updateBankAccount(organizationId, accountId, data) {
    return request(`/organization/${organizationId}/bank-accounts/${accountId}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteBankAccount(organizationId, accountId) {
    return request(`/organization/${organizationId}/bank-accounts/${accountId}`, { method: 'DELETE' });
}

export function createTax(organizationId, data) {
    return request(`/organization/${organizationId}/taxes`, { method: 'POST', body: JSON.stringify(data) });
}

export function updateTax(organizationId, taxId, data) {
    return request(`/organization/${organizationId}/taxes/${taxId}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteTax(organizationId, taxId) {
    return request(`/organization/${organizationId}/taxes/${taxId}`, { method: 'DELETE' });
}
