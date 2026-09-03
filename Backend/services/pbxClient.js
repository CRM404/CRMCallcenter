// --- services/pbxClient.js: доступ к API Телфина (этап Е0) --------------------
//
// ЗАЧЕМ ОТДЕЛЬНАЯ СЛУЖБА, А НЕ ВЫЗОВ ИЗ МАРШРУТА. Токен живёт ЧАС, и у типа
// `trusted` refresh-токена НЕТ вовсе — по истечении берётся новый. Значит кто-то
// обязан его держать. Брать токен на каждый запрос нельзя не из экономии: часовой
// лимит запросов ОБЩИЙ на все приложения клиента, и удвоение расхода приближает
// 429, который стоит ЧАСА простоя.
//
// ⚠⚠ ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Есть чтение: токен, разбор заголовков лимита,
// запись состояния связи. ⛔ ИЗМЕНЯЮЩИХ ВЫЗОВОВ НЕТ НИ ОДНОГО — ни `callback`,
// ни заведения обработчиков событий, ни удаления записей. Это Е1 и Е2, и тариф
// на `callback` проверяется там же, а не здесь.
//
// ⛔ ДВА ЗАПРЕТА, ОПРЕДЕЛЯЮЩИЕ УСТРОЙСТВО ФАЙЛА:
//   · ключи не выносятся никуда — ни в ответ, ни в журнал службы;
//   · в журнал пишется КОД ошибки, а не сама ошибка: в её текст драйвер и
//     `fetch` кладут параметры запроса, а второй параметр здесь — ключ.
// Правило уже применено в `routes/settings.js`, здесь оно то же.
//
// ⚠ ПОВТОРОВ В ЦИКЛЕ НЕТ, И ЭТО ТРЕБОВАНИЕ ДОКУМЕНТАЦИИ (стр. 33–36), а не
// осторожность: повтор допускается либо по действию человека, либо по выдержке
// времени. Неудача возвращается наверх как неудача.

const API_BASE = (process.env.TELPHIN_API_BASE || 'https://apiproxy.telphin.ru/api/ver1.0/')
    .replace(/\/+$/, '');

// ⚠⚠ АДРЕС ТОКЕНА НЕ ПОД `/api/ver1.0/`, И ЭТО НЕ ОПИСКА. Паспорт Телфина
// (стр. 518) даёт `POST https://<hostname>/oauth/token` — то есть на корне
// хоста. Замер 03.09.2026 это подтвердил: адрес ответил 200.
const TOKEN_URL = new URL('/oauth/token', API_BASE).toString();

// Документация требует `Accept-Encoding: gzip` прямо (стр. 9).
const BASE_HEADERS = { 'Accept-Encoding': 'gzip' };

// ⚠ ЗАПАС ПО СРОКУ. `expires_in` — 3600 секунд, но токен, истекающий «прямо
// сейчас», по дороге до станции успевает протухнуть. Берём новый заранее.
const EXPIRY_MARGIN_MS = 60 * 1000;

// Токен живёт в памяти процесса НАМЕРЕННО, и это не спорит с планом 7.1: он
// ничего не значит после перезапуска — новый берётся одним запросом. В базе
// лежит то, что перезапуск пережить обязано: время последнего удачного обмена.
let cached = null; // { token, expiresAt }

// ---------------------------------------------------------------- ключи
//
// ⚠⚠ КЛЮЧИ ЧИТАЮТСЯ ИЗ ДВУХ ИСТОЧНИКОВ, И ПОРЯДОК МЕЖДУ НИМИ — РЕШЕНИЕ, А НЕ
// УДОБСТВО. Владелец выбрал путь Б (решение 132): ключи живут в настройках CRM.
// Настройки ПОБЕЖДАЮТ, окружение остаётся ЗАПАСНЫМ — на случай пустой настройки
// и на время, пока ключи ещё не внесены. Обратный порядок означал бы, что
// забытая переменная окружения молча отменяет то, что человек вписал на экране.
//
// ⚠ ФУНКЦИЯ ПЕРЕЕХАЛА СЮДА ИЗ `routes/calls.js` ВМЕСТЕ С ЭТИМ ДОВОДОМ (Е0).
// Причина переезда — не порядок в файлах: ключи понадобились службе, а второй
// экземпляр этого правила рано или поздно разошёлся бы с первым, и разошёлся бы
// молча. Маршрут теперь ввозит её отсюда, а не держит свою.
async function readKeys(pool) {
    try {
        const found = await pool.query(
            `SELECT key, value FROM pbx_credentials
              WHERE key IN ('telphin_app_id', 'telphin_app_secret')`
        );
        const byKey = new Map(found.rows.map((r) => [r.key, r.value]));
        const id = byKey.get('telphin_app_id') || process.env.TELPHIN_APP_ID;
        const secret = byKey.get('telphin_app_secret') || process.env.TELPHIN_APP_SECRET;
        return { id, secret };
    } catch (err) {
        // ⚠ Таблицы может не быть на старой базе — это не повод ронять экран
        // «Звонков»: он тогда честно скажет «телефония не настроена».
        // ⓘ Печатается КОД ошибки, а не она сама: в тексте ошибки драйвера
        // лежат параметры запроса.
        console.error('Не удалось прочитать ключи телефонии:', err && err.code);
        return { id: process.env.TELPHIN_APP_ID, secret: process.env.TELPHIN_APP_SECRET };
    }
}

// ---------------------------------------------------------------- запись состояния
//
// ⚠⚠ ВРЕМЯ ОБМЕНА ДВИГАЕТ ТОЛЬКО УДАЧА. Неудачный запрос отмечает `available`
// ложью и код ошибки, но `last_exchange_at` не трогает: поле отвечает на вопрос
// «когда работало», а не «когда пробовали». На этом различении стоит третье
// состояние экрана (задача 58): пусто — связи не было никогда.
async function noteExchange(pool, { ok, errorCode, rate }) {
    try {
        await pool.query(
            `UPDATE pbx_state
                SET available = $1,
                    last_exchange_at = CASE WHEN $1 THEN NOW() ELSE last_exchange_at END,
                    last_error_code = $2,
                    rate_limit = COALESCE($3, rate_limit),
                    rate_remaining = COALESCE($4, rate_remaining),
                    rate_reset_at = COALESCE($5, rate_reset_at),
                    updated_at = NOW()
              WHERE id = 1`,
            [Boolean(ok), errorCode || null,
                rate ? rate.limit : null,
                rate ? rate.remaining : null,
                rate && rate.resetSeconds !== null
                    ? new Date(Date.now() + rate.resetSeconds * 1000) : null]
        );
    } catch (err) {
        // Не удалось записать состояние — это не повод ронять сам запрос.
        console.error('Телефония: состояние связи не записано —', err && err.code);
    }
}

// ⚠⚠ ЛИМИТ ОБНОВЛЯЕТСЯ, ТОЛЬКО ЕСЛИ ЗАГОЛОВКИ ПРИШЛИ. На `/oauth/token` их нет
// вовсе — замер 03.09.2026; записать там ноль значило бы соврать «лимит
// исчерпан». Отсутствие числа и число «ноль» — разные вещи.
function readRate(res) {
    const num = (name) => {
        const raw = res.headers.get(name);
        if (raw === null) return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    };
    const limit = num('x-ratelimit-limit');
    const remaining = num('x-ratelimit-remaining');
    const resetSeconds = num('x-ratelimit-reset');
    if (limit === null && remaining === null && resetSeconds === null) return null;
    return { limit, remaining, resetSeconds };
}

// ⚠⚠ ОСТАТОК ЛИМИТА ВИДЕН В ЖУРНАЛЕ СЛУЖБЫ — это дословный проверяемый итог
// плана для Е0. Печатать его на каждый запрос значило бы утопить журнал, поэтому
// говорим тогда, когда это ЗНАЧИМО: на первом ответе после старта, когда остаток
// перешёл через сотню и когда его стало мало. Молчание при полном лимите — не
// пропуск, а тишина по делу.
const RATE_LOUD_BELOW = 100;
let lastReported = null;
function reportRate(rate) {
    if (!rate || rate.remaining === null) return;
    const first = lastReported === null;
    const low = rate.remaining < RATE_LOUD_BELOW;
    const crossedHundred = lastReported !== null
        && Math.floor(lastReported / 100) !== Math.floor(rate.remaining / 100);
    lastReported = rate.remaining;
    if (!first && !low && !crossedHundred) return;
    console.log(`Телефония: остаток часового лимита ${rate.remaining}`
        + (rate.limit !== null ? ` из ${rate.limit}` : '')
        + (rate.resetSeconds !== null ? `, счётчик сбросится через ${rate.resetSeconds} с` : '')
        + (low ? ' — ⚠ мало, 429 стоит часа простоя' : ''));
}

// ---------------------------------------------------------------- токен
async function fetchToken(pool) {
    const keys = await readKeys(pool);
    if (!keys.id || !keys.secret) {
        const err = new Error('Ключи телефонии не заданы');
        err.code = 'pbx_not_configured';
        throw err;
    }

    let res;
    try {
        res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: Object.assign({
                'Content-Type': 'application/x-www-form-urlencoded'
            }, BASE_HEADERS),
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: keys.id,
                client_secret: keys.secret
            })
        });
    } catch (netErr) {
        // ⛔ НАРУЖУ УХОДИТ КОД, А НЕ СООБЩЕНИЕ: в тексте сетевой ошибки `fetch`
        // называет адрес, а отладчик рядом покажет и тело запроса.
        await noteExchange(pool, {
            ok: false, errorCode: netErr && netErr.code ? String(netErr.code) : 'network'
        });
        const err = new Error('Станция недоступна');
        err.code = 'pbx_unreachable';
        throw err;
    }

    const rate = readRate(res);
    if (!res.ok) {
        await noteExchange(pool, { ok: false, errorCode: 'http_' + res.status, rate });
        const err = new Error('Станция не выдала токен');
        err.code = res.status === 401 || res.status === 403 ? 'pbx_denied' : 'pbx_token_failed';
        err.status = res.status;
        throw err;
    }

    let body;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!body || !body.access_token) {
        await noteExchange(pool, { ok: false, errorCode: 'token_missing', rate });
        const err = new Error('В ответе станции нет токена');
        err.code = 'pbx_token_failed';
        throw err;
    }

    // ⚠ Выдача токена — тоже удачный обмен со станцией, и время она двигает:
    // 200 здесь означает, что канал до АТС жив и ключи опознаны.
    await noteExchange(pool, { ok: true, errorCode: null, rate });

    const lifetimeMs = (Number(body.expires_in) || 3600) * 1000;
    cached = { token: body.access_token, expiresAt: Date.now() + lifetimeMs - EXPIRY_MARGIN_MS };
    return cached.token;
}

async function getToken(pool) {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return fetchToken(pool);
}

// ---------------------------------------------------------------- запрос к API
//
// ⚠ ЗАВЕРШАЮЩИЙ СЛЕШ В АДРЕСЕ ЗНАЧИМ — документация выносит это отдельным
// предупреждением (стр. 41): он есть при работе со списками и отсутствует у
// единичного объекта. Путь передаётся вызывающим как есть и здесь не правится.
//
// ⚠⚠ ОДНА ПОВТОРНАЯ ПОПЫТКА, И ТОЛЬКО НА 401. Документация советует запрашивать
// токен заново при ошибке авторизации, не дожидаясь `expires_in`. Это не цикл
// повторов: попытка ровно одна и только после сброса кэша.
async function apiGet(pool, path, { retried = false } = {}) {
    const token = await getToken(pool);
    let res;
    try {
        res = await fetch(API_BASE + path, {
            headers: Object.assign({ Authorization: 'Bearer ' + token }, BASE_HEADERS)
        });
    } catch (netErr) {
        await noteExchange(pool, {
            ok: false, errorCode: netErr && netErr.code ? String(netErr.code) : 'network'
        });
        const err = new Error('Станция недоступна');
        err.code = 'pbx_unreachable';
        throw err;
    }

    const rate = readRate(res);

    if (res.status === 401 && !retried) {
        cached = null;
        return apiGet(pool, path, { retried: true });
    }

    if (!res.ok) {
        await noteExchange(pool, { ok: false, errorCode: 'http_' + res.status, rate });
        const err = new Error('Станция ответила отказом');
        err.code = res.status === 429 ? 'pbx_rate_limited' : 'pbx_request_failed';
        err.status = res.status;
        throw err;
    }

    await noteExchange(pool, { ok: true, errorCode: null, rate });
    reportRate(rate);

    try { return await res.json(); } catch (e) { return null; }
}

// ---------------------------------------------------------------- состояние наружу
//
// ТРИ ПРИЗНАКА, А НЕ ГОТОВЫЙ ТЕКСТ. Что показать человеку — дело экрана и
// дизайн-сессии (задача 58); служба отвечает на вопрос «как есть».
async function readState(pool) {
    try {
        const found = await pool.query(
            'SELECT available, last_exchange_at FROM pbx_state WHERE id = 1');
        const row = found.rows[0];
        if (!row) return { available: false, lastKnownAt: null };
        return {
            available: Boolean(row.available),
            lastKnownAt: row.last_exchange_at ? row.last_exchange_at.toISOString() : null
        };
    } catch (err) {
        // ⚠ Таблицы может не быть на старой базе — это не повод ронять экран
        // «Звонков»: он тогда скажет то же, что говорил до этой работы.
        console.error('Телефония: состояние связи не прочитано —', err && err.code);
        return { available: false, lastKnownAt: null };
    }
}

// ---------------------------------------------------------------- сверка при старте
//
// ПЛАН 7.2: при запуске один запрос «что идёт прямо сейчас» — АТС знает своё
// состояние лучше нас, и так подтягивается то, что мы пропустили, пока лежали.
//
// ⚠⚠ ЗАМЕР 03.09.2026 ЗАСТАВИЛ ПОСТРОИТЬ ЭТО ИНАЧЕ, ЧЕМ ЗВУЧИТ ПЛАН. Сверка по
// добавочным сотрудников сегодня сделала бы НОЛЬ запросов: `employees.pbx_extension`
// в бою пуст у обоих сотрудников (`/api/calls/meta` отдаёт `extension: null`).
// А без единого запроса `available` не стал бы истинным НИКОГДА — то есть полоса
// отказа врала бы дальше, только с другой стороны. Поэтому:
//   · токен берётся ВСЕГДА — сам по себе он и есть проба канала;
//   · `current_calls` спрашивается по тем добавочным, что связаны с сотрудниками;
//   · если не связан ни один — так и говорится в журнале, а не молчится.
//
// ⛔ СТАРТ НЕ ПАДАЕТ НИ ПРИ КАКОМ ОТВЕТЕ СТАНЦИИ. Недоступная АТС — это состояние
// системы, а не поломка службы: экран «Звонков» обязан открыться и сказать правду.
//
// ⚠ ВЫКЛЮЧАТЕЛЬ ЗАВЕДЁН НАРОЧНО, И ВОТ ЗАЧЕМ. Без него КАЖДЫЙ старт сервера —
// включая стенды приёмки, поднимающие его десятками раз, — стучался бы в БОЕВУЮ
// АТС и жёг общий часовой лимит в 1000 запросов. Умолчание — включено, потому что
// в бою сверка нужна; стенды выключают её сами. Приём тот же, что у планировщика
// (`SCHEDULER_ENABLED`), и по той же причине.
async function checkAtStart(pool) {
    if (String(process.env.PBX_STARTUP_CHECK || '').toLowerCase() === 'false') {
        console.log('Телефония: сверка при старте выключена (PBX_STARTUP_CHECK=false)');
        return;
    }

    try {
        await getToken(pool);
    } catch (err) {
        if (err && err.code === 'pbx_not_configured') {
            console.log('Телефония: ключи не заданы — сверка при старте пропущена');
        } else {
            console.error('Телефония: связи со станцией при старте нет —', err && err.code);
        }
        return;
    }
    console.log('Телефония: токен взят, связь со станцией есть');

    let extensions = [];
    try {
        const found = await pool.query(
            `SELECT DISTINCT pbx_extension_id AS id
               FROM employees
              WHERE pbx_extension_id IS NOT NULL AND pbx_extension_id <> ''
              ORDER BY 1`
        );
        extensions = found.rows.map((r) => r.id);
    } catch (err) {
        console.error('Телефония: список добавочных не прочитан —', err && err.code);
        return;
    }

    if (!extensions.length) {
        // ⚠ Молчать здесь нельзя: «сверка прошла» и «сверять было нечего» —
        // разные вещи, и различить их потом будет уже не по чему.
        console.log('Телефония: сверять нечего — добавочный не заполнен ни у одного сотрудника');
        return;
    }

    let live = 0;
    for (const id of extensions) {
        try {
            // ⚠ Завершающий слеш значим (документация, стр. 41): это список.
            const answer = await apiGet(pool, `/extension/${encodeURIComponent(id)}/current_calls/`);
            const list = answer && Array.isArray(answer.call_list) ? answer.call_list : [];
            live += list.length;
        } catch (err) {
            console.error(`Телефония: добавочный ${id} не опрошен —`, err && err.code);
        }
    }
    console.log(`Телефония: сверка при старте — добавочных ${extensions.length},`
        + ` идущих разговоров ${live}`);
}

module.exports = { readKeys, apiGet, getToken, readState, checkAtStart, TOKEN_URL, API_BASE };
