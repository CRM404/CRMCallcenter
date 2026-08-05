// --- scriptsAdminStorage.js: клиент REST API для страницы управления скриптом ---

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

export function fetchScripts() {
    return request('/admin/scripts');
}

export function createScript(data) {
    return request('/admin/scripts', { method: 'POST', body: JSON.stringify(data) });
}

export function updateScript(id, data) {
    return request(`/admin/scripts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteScript(id) {
    return request(`/admin/scripts/${id}`, { method: 'DELETE' });
}

export function fetchScriptNodes(scriptId) {
    return request(`/admin/scripts/${scriptId}/nodes`);
}

export function createScriptNode(scriptId, data) {
    return request(`/admin/scripts/${scriptId}/nodes`, { method: 'POST', body: JSON.stringify(data) });
}

export function updateScriptNode(nodeId, data) {
    return request(`/admin/script-nodes/${nodeId}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteScriptNode(nodeId) {
    return request(`/admin/script-nodes/${nodeId}`, { method: 'DELETE' });
}

export function fetchOffers() {
    return request('/admin/offers');
}

export function createOffer(name) {
    return request('/admin/offers', { method: 'POST', body: JSON.stringify({ name }) });
}

// Список сотрудников для формы назначения — переиспользует прод-эндпоинт
// GET /api/employees (он теперь отдаёт scriptId в каждой записи).
export function fetchEmployees() {
    return request('/employees');
}

export function assignScriptToEmployee(employeeId, scriptId) {
    return request(`/admin/employees/${employeeId}/script`, {
        method: 'PUT',
        body: JSON.stringify({ scriptId })
    });
}
