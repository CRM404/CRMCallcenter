// --- sourcesStorage.js: доменные запросы раздела «Источники» ---
//
// Транспорт переехал в общий api.js (был дословной копией в шести разделах),
// доменные методы остались здесь — слить их в один файл на шесть разделов
// значило бы заменить шесть копий одним монолитом.
//
// Каждый метод принимает `api` — транспорт, привязанный к жизни панели
// (ctx.api). Раздел закрывают — незавершённые запросы обрываются, и ответ не
// приходит в вырезанный из документа контейнер.
//
// Прямых fetch здесь нет и быть не должно: это правило проекта.

// --- Площадки (справочник ad_platforms) ---

export function fetchPlatforms(api) {
    return api.get('/ad-platforms');
}

export function createPlatform(api, data) {
    return api.post('/ad-platforms', data);
}

export function updatePlatform(api, id, data) {
    return api.put(`/ad-platforms/${id}`, data);
}

export function deletePlatform(api, id) {
    return api.del(`/ad-platforms/${id}`);
}

// --- CPA-сети: только чтение, справочник для мультивыбора в форме источника ---

export function fetchCpaNetworks(api) {
    return api.get('/cpa-networks');
}

// --- Источники ---

/**
 * { platformId } — источники одной площадки; { search } — кросс-площадочный
 * режим (по всем полям сразу, игнорирует platformId). Ровно один из двух.
 */
export function fetchSources(api, { platformId, search } = {}) {
    if (search) return api.get('/sources', { search });
    if (platformId !== undefined && platformId !== null) return api.get('/sources', { platformId });
    return api.get('/sources');
}

export function createSource(api, data) {
    return api.post('/sources', data);
}

export function updateSource(api, id, data) {
    return api.put(`/sources/${id}`, data);
}

export function deleteSource(api, id) {
    return api.del(`/sources/${id}`);
}
