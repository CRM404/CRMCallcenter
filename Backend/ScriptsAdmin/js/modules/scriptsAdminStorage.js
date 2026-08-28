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

        // Справочник статусов воронки. Читают его «Лиды» и рабочее место
        // оператора, а правит — только эта вкладка (часть 9, заход 4).
        //
        // ПОМЕТКА СВОИМ МЕТОДОМ, А НЕ ЧАСТЬЮ ПРАВКИ. Её ставят списком прямо в
        // строке, пятьдесят раз подряд и без кнопки «Сохранить»; слать вместе с
        // ней имя и два признака значило бы отправлять всю строку ради одного
        // значения — и затирать правку, сделанную в окне между чтением списка и
        // выбором.
        fetchFunnelStatuses: () => api.get('/lead-funnel-statuses'),
        createFunnelStatus: (data) => api.post('/lead-funnel-statuses', data),
        updateFunnelStatus: (id, data) => api.put(`/lead-funnel-statuses/${id}`, data),
        setFunnelStatusMark: (id, mark) => api.put(`/lead-funnel-statuses/${id}/mark`, { mark }),
        deleteFunnelStatus: (id) => api.del(`/lead-funnel-statuses/${id}`),

        // ЭТАПЫ — СВОИМ ЗАПРОСОМ, А НЕ ВЫВОДОМ ИЗ СПИСКА СТАТУСОВ. Разбивку по
        // этапам вкладка и раньше собирала из самих статусов, и это верно: имя
        // этапа живёт в их строках. Но описание живёт у ЭТАПА, и вывести его из
        // статусов нельзя ничем — значит нужен второй запрос, а не догадка.
        // Он же приносит `editable`: право правки решает сервер, экран его не
        // вычисляет (`routes/leadFunnelStatuses.js:121`).
        fetchFunnelStages: () => api.get('/lead-funnel-statuses/stages'),
        updateStageDescription: (number, description) =>
            api.put(`/lead-funnel-statuses/stages/${number}`, { description }),

        fetchScriptNodes: (scriptId) => api.get(`/admin/scripts/${scriptId}/nodes`),
        createScriptNode: (scriptId, data) => api.post(`/admin/scripts/${scriptId}/nodes`, data),
        updateScriptNode: (nodeId, data) => api.put(`/admin/script-nodes/${nodeId}`, data),
        deleteScriptNode: (nodeId) => api.del(`/admin/script-nodes/${nodeId}`)
    };
}
