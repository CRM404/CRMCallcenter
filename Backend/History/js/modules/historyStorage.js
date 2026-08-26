// --- History/js/modules/historyStorage.js: запросы журнала изменений -------
//
// Правило проекта: прямых fetch вне storage-модуля нет. Транспорт приходит
// параметром — это ctx.api оболочки, привязанный к жизни панели.
//
// ЖУРНАЛ ЧИТАЕТСЯ, А НЕ ПРАВИТСЯ. Единственный изменяющий вызов здесь —
// отметка о выгрузке, и он не меняет данные, а признаётся в том, что данные
// покинули систему пачкой.

/** Список записей журнала. Курсор — точка отсчёта следующей порции. */
export function fetchHistory(api, filters, cursor) {
    return api.get('/audit', {
        ...toQuery(filters),
        cursorAt: cursor ? cursor.at : undefined,
        cursorId: cursor ? cursor.id : undefined
    });
}

/** Вся выборка одним куском — для выгрузки. */
export function fetchHistoryForExport(api, filters) {
    return api.get('/audit', { ...toQuery(filters), export: '1' });
}

/** Справочники окна отбора: таблицы, авторы, виды операции, дата включения. */
export function fetchMeta(api) {
    return api.get('/audit/meta');
}

/** Сводка партии — только когда её строку разворачивают. */
export function fetchBatch(api, batchId) {
    return api.get(`/audit/batch/${batchId}`);
}

/**
 * Отметка о выгрузке. Отправляется ПОСЛЕ того, как файл собран: отметиться о
 * выгрузке, которая не состоялась, значит записать в журнал неправду.
 */
export function markExport(api, rows, filters) {
    return api.post('/audit/export', { rows, filters: toQuery(filters) });
}

function toQuery(f) {
    return {
        // ПРЕСЕТ ПЕРИОДА УХОДИТ ЧИСЛОМ ДНЕЙ, А НЕ ПАРОЙ ДАТ (К204): «сегодня»
        // знает сервер, и он же переводит пресет в даты. Даты идут только те,
        // что выбраны руками в окне отбора.
        days: f.days || undefined,
        // Порядок — один на список, колонка у него одна: «Когда».
        sort: f.sort || undefined,
        from: f.from || undefined,
        to: f.to || undefined,
        page: f.page || undefined,
        table: f.table || undefined,
        op: f.op || undefined,
        actorId: f.actorId || undefined,
        actorKind: f.actorKind || undefined,
        actorName: f.actorName || undefined,
        batchOnly: f.batchOnly ? '1' : undefined,
        batchId: f.batchId || undefined,
        recordTable: f.recordTable || undefined,
        recordId: f.recordId || undefined,
        search: f.search || undefined
    };
}
