// --- Calls/js/modules/callsStorage.js: доменные запросы раздела «Звонки» ---
//
// Правило проекта: прямых fetch вне storage-модуля нет. Транспорт приходит
// параметром — это ctx.api оболочки, привязанный к жизни панели: закрыли
// панель, и незавершённые запросы отменились сами.
//
// РАЗДЕЛ ТОЛЬКО ЧИТАЕТ. Ни одной изменяющей функции здесь нет и не будет.

/** Операторы на смене сегодня. Вкладка «Активные». */
export function fetchActive(api) {
    return api.get('/calls/active');
}

/** Справочники окна «Фильтры»: операторы, источники, исходы. */
export function fetchMeta(api) {
    return api.get('/calls/meta');
}

/**
 * Журнал звонков. Вкладка «Завершённые».
 *
 * Пустые значения в строку запроса не попадают — этим занимается buildQuery
 * транспорта: «фильтр не задан» и «фильтр задан пустым» на сервере разные вещи.
 */
export function fetchCalls(api, filters, offset) {
    return api.get('/calls', { ...toQuery(filters), offset: offset || undefined });
}

/**
 * Вся выборка одним куском — для выгрузки. Не показанные тридцать, а всё, что
 * подошло под отбор (ответ куратора И176): файл уносят, чтобы иметь всё.
 * Сверх потолка сервер отвечает отказом с числом, а не половиной данных.
 */
export function fetchCallsForExport(api, filters) {
    return api.get('/calls', { ...toQuery(filters), export: '1' });
}

/** Цепочка участников звонка — только когда строку разворачивают. */
export function fetchChain(api, callId) {
    return api.get(`/calls/${callId}/chain`);
}

/** Ссылка на запись разговора. Живёт у оператора связи, а не у нас. */
export function fetchRecording(api, callId) {
    return api.get(`/calls/${callId}/recording`);
}

function toQuery(f) {
    return {
        from: f.from,
        to: f.to,
        employeeId: f.employeeId || undefined,
        outcome: f.outcome || undefined,
        direction: f.direction || undefined,
        lineType: f.lineType || undefined,
        sourceId: f.sourceId || undefined,
        withRecord: f.withRecord ? '1' : undefined,
        search: f.search || undefined
    };
}
