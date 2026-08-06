// --- cpaStorage.js: клиент REST API для страницы "CPA-сети" ---

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

export function fetchCpaNetworks() {
    return request('/cpa-networks');
}

export function createCpaNetwork(data) {
    return request('/cpa-networks', { method: 'POST', body: JSON.stringify(data) });
}

export function updateCpaNetwork(id, data) {
    return request(`/cpa-networks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteCpaNetwork(id) {
    return request(`/cpa-networks/${id}`, { method: 'DELETE' });
}

// Единственная организация (или null) — переиспользуем существующий singleton-
// эндпоинт "Реквизиты" для выпадающего списка "Юрлицо" (dialog.md, п.1: заводить
// отдельный список организаций сейчас не нужно, поддержка нескольких юрлиц вне
// рамок этой задачи).
export function fetchOrganization() {
    return request('/organization');
}
