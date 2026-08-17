// --- cpaStorage.js: клиент REST API раздела «CPA-сети» ---
//
// Транспорт (fetch, разбор JSON, обработка ошибки) был здесь дословной копией
// такой же функции из пяти других storage-модулей — убран, он живёт в
// Shell/api.js. Доменные методы остались тут.
//
// Фабрика, а не свободные функции: раздел получает от оболочки ctx.api,
// привязанный к жизни его панели, и строит storage поверх него. Так закрытие
// панели обрывает незавершённые запросы — со свободными функциями ответ
// пришёл бы в уже размонтированный раздел.

export function createStorage(api) {
    const q = (params) => {
        const search = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') search.set(k, v);
        });
        const s = search.toString();
        return s ? `?${s}` : '';
    };

    return {
        // --- Сети ---
        fetchCpaNetworks: () => api.get('/cpa-networks'),
        createCpaNetwork: (data) => api.post('/cpa-networks', data),
        updateCpaNetwork: (id, data) => api.put(`/cpa-networks/${id}`, data),
        deleteCpaNetwork: (id) => api.del(`/cpa-networks/${id}`),

        // Единственная организация (или null) — переиспользуем singleton-эндпоинт
        // «Реквизитов» для выпадающего списка «Юрлицо»: заводить отдельный список
        // организаций сейчас не нужно, поддержка нескольких юрлиц вне рамок задачи.
        fetchOrganization: () => api.get('/organization'),

        // --- Офферы недвижимости ---
        fetchRealEstateOffers: (networkId) =>
            api.get(`/real-estate-offers${networkId !== undefined && networkId !== null ? `?networkId=${networkId}` : ''}`),
        createRealEstateOffer: (data) => api.post('/real-estate-offers', data),
        updateRealEstateOffer: (id, data) => api.put(`/real-estate-offers/${id}`, data),
        deleteRealEstateOffer: (id) => api.del(`/real-estate-offers/${id}`),

        // --- Рекламные площадки ---
        // Раздел их не показывает (уезжают на будущую страницу «Маркетинг»),
        // но методы оставлены: бэкенд их отдаёт, и удалять клиентскую часть
        // в задаче про оболочку не наше дело.
        fetchAdPlatforms: () => api.get('/ad-platforms'),
        createAdPlatform: (data) => api.post('/ad-platforms', data),
        updateAdPlatform: (id, data) => api.put(`/ad-platforms/${id}`, data),
        deleteAdPlatform: (id) => api.del(`/ad-platforms/${id}`),

        // --- Настройка списков ---
        fetchParamLists: () => api.get('/param-lists'),
        addParamValue: (key, value) =>
            api.post(`/param-lists/${encodeURIComponent(key)}`, { value }),
        deleteParamValue: (key, value) =>
            api.del(`/param-lists/${encodeURIComponent(key)}/${encodeURIComponent(value)}`),

        // --- Подсказки адреса, прокси к DaData ---
        fetchGeoSuggest: (query, { bound, regionFiasId } = {}) =>
            api.get(`/geo-suggest${q({ q: query, bound, regionFiasId })}`)
    };
}
