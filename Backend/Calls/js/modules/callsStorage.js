// --- Calls/js/modules/callsStorage.js: доменные запросы раздела «Звонки» ---
//
// Правило проекта: прямых fetch вне storage-модуля нет. Транспорт приходит
// параметром — это ctx.api оболочки, привязанный к жизни панели: закрыли
// панель, и незавершённые запросы отменились сами.
//
// ЖУРНАЛ ТОЛЬКО ЧИТАЕТ, НАСТРОЙКА — ПИШЕТ. Две первые вкладки не меняют ничего:
// звонок и смена — это записи о том, что произошло, и править их задним числом
// нельзя. Третья вкладка «События» — настройка, и она пишет; изменяющие функции
// ниже относятся ТОЛЬКО к ней.
//
// До части 9 в этой шапке стояло «ни одной изменяющей функции здесь нет и не
// будет». Обещание снято вместе с тем коммитом, который его нарушил: обещание,
// пережившее свою правду, вводит в заблуждение сильнее, чем его отсутствие.

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
export function fetchCalls(api, filters, cursor) {
    return api.get('/calls', {
        ...toQuery(filters),
        // КУРСОР, А НЕ СМЕЩЕНИЕ (К197). Журнал пополняется во время чтения:
        // новый звонок встаёт наверх и сдвигает окно, а на смещении это значит
        // повтор уже показанной строки на следующей странице.
        cursorAt: cursor ? cursor.at || undefined : undefined,
        cursorId: cursor ? cursor.id : undefined
    });
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

// ----------------------------------------------------- вкладка «События»

/** Три события со своими перечнями. Вкладка «События». */
export function fetchEvents(api) {
    return api.get('/call-events');
}

/**
 * Справочники трёх окон одним ответом: статусы, скрипты, офферы, сотрудники.
 *
 * ОТДЕЛЬНЫМ ЗАПРОСОМ ОТ САМИХ СОБЫТИЙ, а не вместе с ними: события перечитываются
 * после каждого сохранения, справочники — нет. Класть их в один ответ значило бы
 * возить весь список офферов туда-обратно на каждую правку интервала.
 */
export function fetchEventDirectories(api) {
    return api.get('/call-events/directories');
}

/** Выключатель в строке события. Срабатывает сразу, настройку не трогает. */
export function setEventEnabled(api, slug, enabled) {
    return api.put(`/call-events/${slug}/enabled`, { enabled });
}

// Три сохранения по числу окон. Каждое возвращает события ЦЕЛИКОМ — экран
// перерисовывается ответом сервера, а не тем, что сам отправил: строки заводятся
// с новыми id, а строка-итог считается по тому, что действительно записано.
export function saveAutoRecall(api, payload) {
    return api.put('/call-events/auto-recall', payload);
}

export function saveTransfer(api, payload) {
    return api.put('/call-events/transfer', payload);
}

export function saveWrapup(api, payload) {
    return api.put('/call-events/wrapup', payload);
}

// ⚠ ЧЕТВЁРТОГО СОХРАНЕНИЯ ЗДЕСЬ НЕТ. `saveTransferWait` правил одно число на все
// переводы внутрь; решение владельца 109 (К259) сделало ожидание полем строки, и
// уезжает оно теперь вместе со строкой в `saveTransfer`.

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
