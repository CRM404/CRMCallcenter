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
 * Запрос к API. Текст ошибки — тот же, что раздавали копии: пользователь
 * видел эти формулировки и до переезда.
 */
export async function request(path, options = {}) {
    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...options
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
        throw new Error((body && body.error) || 'Произошла ошибка на сервере');
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
        return request(path, { ...options, signal: controller.signal }).then(
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
