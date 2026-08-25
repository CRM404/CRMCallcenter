// --- api.js: общий транспорт к REST API ---
//
// Сегодня функция request() дословно скопирована в шести storage-модулях
// разделов (седьмой — операторский, страница оператора в задачу не входит).
// Здесь она одна.
//
// ЧТО ОСТАЁТСЯ ПО РАЗДЕЛАМ: доменные методы — fetchEmployees, fetchLeads,
// createSource и прочие. Слить их в один файл на шесть разделов значило бы
// заменить шесть копий одним монолитом; это не улучшение. Разделы
// импортируют request отсюда и строят свои методы поверх.
//
// ПРАВИЛО ПРОЕКТА СОХРАНЯЕТСЯ: прямых fetch вне storage-модулей быть не
// должно. Единственное исключение — загрузка фрагмента разметки раздела
// оболочкой (см. shell/app.js), и оно объявлено в брифе.
//
// ЧТО ДОБАВИЛОСЬ ПРОТИВ КОПИЙ: отмена запросов. Раздел закрывают вместе с
// панелью, и его незавершённые запросы обязаны отмениться — иначе ответ
// придёт в уже размонтированный раздел и попытается нарисовать себя в
// вырезанный из документа контейнер.

export const API_BASE_URL = '/api';

/**
 * ПОМЕТКА «С КАКОЙ СТРАНИЦЫ» — ЗДЕСЬ, В ОДНОМ МЕСТЕ НА ВЕСЬ ПРОЕКТ.
 *
 * Журналу изменений нужно знать, из какого раздела пришла правка (Б2.7). Ради
 * этого оболочка и сводила запросы всех разделов в одну функцию: пометка
 * добавляется однажды, и её получают все разделы разом — включая те, которых
 * ещё нет.
 *
 * Автора здесь не бывает: в админке нет входа, называться некому, и сервер
 * честно запишет «не указан». Свой номер прикладывает только страница
 * оператора — у неё свой транспорт.
 */
function auditHeaders(page) {
    return page ? { 'X-CRM-Page': page } : {};
}

/**
 * Запрос к API. Текст ошибки — тот же, что раздавали копии: пользователь
 * видел эти формулировки и до переезда.
 */
export async function request(path, options = {}) {
    const { page, batch, batchTitle, ...rest } = options;
    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            ...rest,
            headers: {
                'Content-Type': 'application/json',
                ...auditHeaders(page),
                // Признак партии: череда обычных запросов, которую человек
                // сделал ОДНИМ действием (массовая правка в таблице), обязана
                // читаться в журнале как одно действие, а не как сто.
                ...(batch ? { 'X-CRM-Batch': batch } : {}),
                // Заголовок партии — русский текст, а в заголовок HTTP он не
                // лезет вовсе: значение обязано быть латиницей, и fetch на
                // кириллице падает ошибкой ещё до отправки. Поэтому кодируем;
                // сервер раскодирует обратно.
                ...(batch && batchTitle ? { 'X-CRM-Batch-Title': encodeURIComponent(batchTitle) } : {}),
                ...(rest.headers || {})
            }
        });
    } catch (e) {
        // Отмена приходит сюда же, но это не сбой связи, и говорить о ней
        // пользователю нечего — раздел уже закрыт.
        if (e && e.name === 'AbortError') throw abortError();
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
        // Текст ошибки остаётся тем же — его показывают тостом. Рядом едут код
        // и статус: разделу иногда нужно не «что написать», а «куда показать».
        // Первый случай — занятый добавочный: текст уходит ПОД ПОЛЕ, а не в
        // тост, и отличить этот отказ от прочих можно только по коду.
        const error = new Error((body && body.error) || 'Произошла ошибка на сервере');
        if (body && body.code) error.code = body.code;
        // Помехи удаления (часть 5) — списком, а не строкой: сервер отдаёт
        // пары «сколько — чего», текст окна собирает раздел. Транспорт обязан
        // их пронести, иначе структура доедет только до этого места и раздел
        // снова будет разбирать готовую фразу — то, от чего часть 5 и уходила.
        if (body && Array.isArray(body.blockers)) error.blockers = body.blockers;
        error.status = response.status;
        throw error;
    }
    return body;
}

/** Сборка строки запроса. Пустые значения не отправляются. */
export function buildQuery(filters = {}) {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '' && value !== false) {
            params.set(key, value);
        }
    });
    const query = params.toString();
    return query ? `?${query}` : '';
}

/**
 * Транспорт, привязанный к жизни одной панели. Оболочка создаёт его при
 * монтировании раздела и обрывает при размонтировании — раздел получает его
 * как ctx.api и своего AbortController не заводит.
 */
export function createApiScope(hooks = {}) {
    const controller = new AbortController();
    let alive = true;
    // Ключ раздела, с которым оболочка смонтировала панель. Уходит в журнал
    // изменений как «какая страница CRM».
    const page = hooks.page || null;
    // Признак партии живёт ровно столько, сколько идёт массовое действие:
    // ставится перед ним и снимается сразу после.
    let batch = null;
    let batchTitle = null;

    // Чтение отличается от действия по методу. Оболочка вешает на чтение
    // показ полосы «данные не загрузились» (ui/load-error.js): отказавший
    // запрос данных иначе неотличим от честного «записей нет» — раздел
    // рисует своё пустое состояние, и человек заводит заново то, что уже
    // есть (находка ревизора Р3).
    const isRead = (options) => !options.method || String(options.method).toUpperCase() === 'GET';

    // Хукам передаётся ПУТЬ БЕЗ строки запроса — по нему оболочка различает
    // запросы между собой (К140). Строка запроса в ключ не входит намеренно:
    // отказавший `/sources?platformId=3` и удавшийся следом `/sources` — это
    // одно и то же чтение, и второй обязан снимать полосу, поставленную первым.
    const readKey = (path) => String(path).split('?')[0];

    const send = (path, options = {}) => {
        if (!alive) return Promise.reject(abortError());
        const read = isRead(options);
        return request(path, { ...options, page, batch, batchTitle, signal: controller.signal }).then(
            (body) => {
                if (read && alive && hooks.onReadOk) hooks.onReadOk(readKey(path));
                return body;
            },
            (err) => {
                // Отмена — не отказ: панель просто закрыли.
                if (read && alive && !isAbort(err) && hooks.onReadFail) hooks.onReadFail(err, readKey(path));
                throw err;
            }
        );
    };

    return {
        request: send,
        buildQuery,

        get: (path, filters) => send(`${path}${filters ? buildQuery(filters) : ''}`),
        post: (path, payload) => send(path, { method: 'POST', body: JSON.stringify(payload) }),
        put: (path, payload) => send(path, { method: 'PUT', body: JSON.stringify(payload) }),
        patch: (path, payload) => send(path, { method: 'PATCH', body: JSON.stringify(payload) }),
        del: (path) => send(path, { method: 'DELETE' }),

        /**
         * Массовое действие: череда запросов, которую человек сделал одним
         * нажатием. Признак снимается в finally — иначе следующая одиночная
         * правка приедет в журнал как часть чужой партии.
         */
        async batched(title, fn) {
            batch = (crypto.randomUUID && crypto.randomUUID()) || null;
            batchTitle = title || null;
            try {
                return await fn();
            } finally {
                batch = null;
                batchTitle = null;
            }
        },

        /** Оболочка зовёт это при закрытии панели. Раздел — не зовёт. */
        abort() {
            if (!alive) return;
            alive = false;
            controller.abort();
        },
        get aborted() { return !alive; }
    };
}

/**
 * Отменённый запрос — не ошибка пользователя. Раздел, поймавший ошибку,
 * обязан проверить это перед показом тоста:
 *
 *     catch (err) { if (!isAbort(err)) ctx.toast(err.message, 'error'); }
 *
 * Иначе закрытие панели во время загрузки будет выдавать «Не удалось
 * связаться с сервером» на ровном месте.
 */
export function isAbort(err) {
    return !!err && err.aborted === true;
}

function abortError() {
    const err = new Error('Запрос отменён: раздел закрыт');
    err.aborted = true;
    return err;
}
