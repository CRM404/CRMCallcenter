// --- operatorStorage.js: клиент REST API для страницы оператора ---

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

function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            usp.set(key, value);
        }
    });
    const query = usp.toString();
    return query ? `?${query}` : '';
}

export function operatorLogin(email, password) {
    return request('/auth/operator-login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
    });
}

export function fetchOwnLeads(employeeId) {
    return request(`/leads${buildQuery({ employeeId })}`);
}

export function fetchLead(id, employeeId) {
    return request(`/leads/${id}${buildQuery({ employeeId })}`);
}

export function saveLead(id, employeeId, data) {
    return request(`/leads/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...data, employeeId })
    });
}

export function fetchFunnelStatuses() {
    return request('/lead-funnel-statuses');
}

export function fetchScript() {
    return request('/scripts');
}
