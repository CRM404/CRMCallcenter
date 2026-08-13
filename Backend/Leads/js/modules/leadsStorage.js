// --- leadsStorage.js: клиент REST API для страницы "Лиды" ---

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

// --- Лиды (админский слой, routes/leadsAdmin.js) ---

export function fetchLeads({ fio, phone, sourceId, employeeId, funnelStatusId, limit, offset } = {}) {
    return request(`/leads-admin${buildQuery({ fio, phone, sourceId, employeeId, funnelStatusId, limit, offset })}`);
}

export function fetchLeadStats() {
    return request('/leads-admin/stats');
}

export function checkPhoneDuplicate(phone) {
    return request(`/leads-admin/check-phone${buildQuery({ phone })}`);
}

export function fetchLeadById(id) {
    return request(`/leads-admin/${id}`);
}

export function createLead(data) {
    return request('/leads-admin', { method: 'POST', body: JSON.stringify(data) });
}

export function updateLead(id, data) {
    return request(`/leads-admin/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteLead(id) {
    return request(`/leads-admin/${id}`, { method: 'DELETE' });
}

export function bulkImportLeads(sourceId, rows) {
    return request('/leads-admin/bulk-import', { method: 'POST', body: JSON.stringify({ sourceId, rows }) });
}

// --- Справочники, переиспользуемые с других страниц (только чтение) ---

export function fetchAllSources() {
    return request('/sources');
}

export function fetchAllEmployees() {
    return request('/employees');
}

export function fetchAllOffers() {
    return request('/real-estate-offers');
}

export function fetchFunnelStatuses() {
    return request('/lead-funnel-statuses');
}

export function fetchParamLists() {
    return request('/param-lists');
}

export function fetchGeoSuggest(query, { bound, regionFiasId } = {}) {
    const params = new URLSearchParams({ q: query });
    if (bound) params.set('bound', bound);
    if (regionFiasId) params.set('regionFiasId', regionFiasId);
    return request(`/geo-suggest?${params.toString()}`);
}
