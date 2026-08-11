// --- sourcesStorage.js: клиент REST API для страницы "Источники" ---

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

// --- Площадки (переиспользует существующий справочник ad_platforms) ---

export function fetchPlatforms() {
    return request('/ad-platforms');
}

export function createPlatform(data) {
    return request('/ad-platforms', { method: 'POST', body: JSON.stringify(data) });
}

export function updatePlatform(id, data) {
    return request(`/ad-platforms/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deletePlatform(id) {
    return request(`/ad-platforms/${id}`, { method: 'DELETE' });
}

// --- CPA-сети (только чтение — справочник для мультивыбора в форме источника) ---

export function fetchCpaNetworks() {
    return request('/cpa-networks');
}

// --- Источники ---

// { platformId } — источники одной площадки; { search } — кросс-площадочный
// режим (по всем полям сразу, игнорирует platformId). Ровно один из двух.
export function fetchSources({ platformId, search } = {}) {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    else if (platformId !== undefined && platformId !== null) params.set('platformId', platformId);
    return request(`/sources?${params.toString()}`);
}

export function fetchSourceById(id) {
    return request(`/sources/${id}`);
}

export function createSource(data) {
    return request('/sources', { method: 'POST', body: JSON.stringify(data) });
}

export function updateSource(id, data) {
    return request(`/sources/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteSource(id) {
    return request(`/sources/${id}`, { method: 'DELETE' });
}
