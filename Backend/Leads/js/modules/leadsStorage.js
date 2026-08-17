// --- leadsStorage.js: доменные методы раздела «Лиды» ---
//
// Транспорта здесь больше нет: request/buildQuery живут в /api.js, один на
// проект. Storage раздела стал фабрикой — она получает ctx.api, привязанный к
// жизни ОДНОЙ панели, и все запросы раздела отменяются вместе с её закрытием.
//
//     const storage = createStorage(ctx.api);
//     const leads = await storage.fetchLeads({ limit: 30 });

export function createStorage(api) {
    return {
        // --- Лиды (админский слой, routes/leadsAdmin.js) ---

        fetchLeads: ({ fio, phone, sourceId, employeeId, funnelStatusId, limit, offset } = {}) =>
            api.get('/leads-admin', { fio, phone, sourceId, employeeId, funnelStatusId, limit, offset }),

        fetchLeadStats: () => api.get('/leads-admin/stats'),

        checkPhoneDuplicate: (phone) => api.get('/leads-admin/check-phone', { phone }),

        fetchLeadById: (id) => api.get(`/leads-admin/${id}`),

        createLead: (data) => api.post('/leads-admin', data),

        updateLead: (id, data) => api.put(`/leads-admin/${id}`, data),

        deleteLead: (id) => api.del(`/leads-admin/${id}`),

        // Один набор параметров подбора на всю партию + строки файла.
        bulkImportLeads: (params) => api.post('/leads-admin/bulk-import', params),

        // Лёгкая PATCH-семантика под массовые действия списка: полное тело лида
        // не нужно, поэтому массово править можно и старых лидов, у которых ещё
        // не заполнены обязательные для PUT поля (линия/скрипт/офферы/статусы).
        bulkUpdateLeads: (leadIds, patch) => api.post('/leads-admin/bulk-update', { leadIds, patch }),

        // --- Справочники, переиспользуемые с других разделов (только чтение) ---

        fetchAllSources: () => api.get('/sources'),

        fetchAllEmployees: () => api.get('/employees'),

        // Офферы — ТОЛЬКО серверный поиск: в базе ≈38 000, полный справочник
        // (GET /real-estate-offers, им живёт раздел CPA-сетей) этот раздел не
        // запрашивает никогда.
        searchOffers: ({ search, rootSource, platformId, region, city, district, locality, limit } = {}) =>
            api.get('/real-estate-offers/search', { search, rootSource, platformId, region, city, district, locality, limit }),

        // Транспорт кнопки «Добавить все (N)»: id всего отбора, а не видимой страницы.
        searchOfferIds: ({ search, rootSource, platformId, region, city, district, locality } = {}) =>
            api.get('/real-estate-offers/search-ids', { search, rootSource, platformId, region, city, district, locality }),

        // Гео-уровни каскадные: выбранные верхние сужают списки нижних, поэтому
        // эндпоинт принимает их параметрами и перезапрашивается при смене уровня.
        fetchOfferFilters: ({ region, city, district } = {}) =>
            api.get('/real-estate-offers/search-filters', { region, city, district }),

        // Только активные скрипты — черновики в выборе на «Лидах» не участвуют.
        fetchActiveScripts: () => api.get('/admin/scripts', { status: 'active' }),

        fetchFunnelStatuses: () => api.get('/lead-funnel-statuses'),

        fetchParamLists: () => api.get('/param-lists'),

        fetchGeoSuggest: (query, { bound, regionFiasId } = {}) =>
            api.get('/geo-suggest', { q: query, bound, regionFiasId })
    };
}
