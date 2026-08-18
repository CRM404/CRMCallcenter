// --- scriptsAdminStorage.js: доменные методы API раздела «Скрипты» ---
//
// Своя копия request() удалена: транспорт теперь общий и привязан к жизни
// панели (Shell/api.js, ctx.api). Раздел строит хранилище от ctx.api в mount —
// закрытие панели обрывает незавершённые запросы, и ответ не приходит в
// разобранный раздел.
//
// Здесь были fetchEmployees / addScriptToEmployee / removeScriptFromEmployee —
// удалены вместе с панелью назначения операторов (13.08.2026). Скрипт теперь
// привязывается к лиду на странице «Лиды», а не к оператору здесь.

export function createStorage(api) {
    return {
        fetchScripts: () => api.get('/admin/scripts'),
        createScript: (data) => api.post('/admin/scripts', data),
        updateScript: (id, data) => api.put(`/admin/scripts/${id}`, data),
        deleteScript: (id) => api.del(`/admin/scripts/${id}`),

        fetchScriptNodes: (scriptId) => api.get(`/admin/scripts/${scriptId}/nodes`),
        createScriptNode: (scriptId, data) => api.post(`/admin/scripts/${scriptId}/nodes`, data),
        updateScriptNode: (nodeId, data) => api.put(`/admin/script-nodes/${nodeId}`, data),
        deleteScriptNode: (nodeId) => api.del(`/admin/script-nodes/${nodeId}`)
    };
}
