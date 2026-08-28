// --- operatorStorage.js: клиент REST API для страницы оператора ---

import { getOperatorIdentity } from './operatorIdentity.js';

export const API_BASE_URL = '/api';

// КТО И С КАКОЙ СТРАНИЦЫ — для журнала изменений (часть 3, Б2.7).
//
// Страница оператора — единственное место в проекте, где браузер знает, кто за
// экраном: после входа он держит номер сотрудника и прикладывает его к
// запросам. Проверить этот номер сервер не может — прислать чужой ничто не
// мешает, — поэтому в журнале он записывается как «указан браузером», и в
// интерфейсе так и написано. Это честная пометка, а не обман.
function auditHeaders() {
    const identity = getOperatorIdentity();
    const id = identity && identity.id;
    return {
        'X-CRM-Page': 'operator',
        ...(id ? { 'X-CRM-Actor': String(id) } : {})
    };
}

async function request(path, options = {}) {
    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...auditHeaders(), ...(options.headers || {}) }
        });
    } catch (e) {
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
        const err = new Error((body && body.error) || 'Произошла ошибка на сервере');
        err.status = response.status;
        throw err;
    }
    return body;
}

function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            usp.set(key, value);
        }
    });
    const query = usp.toString();
    return query ? `?${query}` : '';
}

export function operatorLogin(email, password) {
    return request('/auth/operator-login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
    });
}

export function fetchLead(id, employeeId) {
    return request(`/leads/${id}${buildQuery({ employeeId })}`);
}

// Очередь оператора (15.08.2026). Списка лидов больше нет: сервер сам решает,
// с какой карточкой оператор работает сейчас, и отдаёт её вместе со своим
// «сейчас» — счётчик пост-обработки считается от серверного времени.
export function fetchNextLead(employeeId) {
    return request(`/leads/next${buildQuery({ employeeId })}`);
}

// «Сохранить» — один запрос: сохраняет карточку, применяет правила статуса
// звонка и сразу возвращает следующего лида. Парой запросов это делать нельзя:
// между ними лид успевает уйти другому оператору.
export function completeLead(id, employeeId, data, nextCallAt) {
    return request(`/leads/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ ...data, employeeId, nextCallAt: nextCallAt || null })
    });
}

/**
 * Пост-обработка кончилась по времени: карточка закрывается со всем набранным.
 *
 * Отдельный адрес, а не `/complete` с пустым статусом: тот статуса требует и без
 * него отвечает отказом — и правильно делает, иначе один щелчок по «— не
 * выбран —» терял бы лида навсегда. Здесь статуса нет и быть не может: время
 * вышло, оператор его не поставил.
 */
export function closeByWrapupTimeout(id, employeeId, data) {
    return request(`/leads/${id}/wrapup-timeout`, {
        method: 'POST',
        body: JSON.stringify({ ...data, employeeId })
    });
}

export function fetchFunnelStatuses() {
    return request('/lead-funnel-statuses');
}

// "На линии" (report_2026-08-01.md, 13.08.2026) — читаем актуальное
// состояние с сервера при каждой загрузке страницы, не из identity в
// sessionStorage: могло измениться в другой вкладке/сессии.
export function fetchEmployee(id) {
    return request(`/employees/${id}`);
}

// Состояние оператора (15.08.2026) — пять состояний вместо прежнего «на линии»
// да/нет. Ответ содержит текущее состояние, момент его начала, серверное
// «сейчас» и суммы по состояниям за сегодня.
export function fetchWorkState(id) {
    return request(`/employees/${id}/work-state`);
}

export function setWorkState(id, state) {
    return request(`/employees/${id}/work-state`, {
        method: 'PUT',
        body: JSON.stringify({ state })
    });
}

// Справочники карточки клиента (14.08.2026). Те же значения, что у офферов и
// в админской карточке лида: сравнивать лид с офферами можно только пока обе
// стороны выбирают из одного списка.
export function fetchParamLists() {
    return request('/param-lists');
}

// Подсказки адреса — тот же прокси DaData, что на офферах и в админской
// карточке лида. bound задаёт уровень (region|city|area|settlement),
// regionFiasId сужает поиск внутри уже выбранного региона.
export function fetchGeoSuggest(query, { bound, regionFiasId } = {}) {
    return request(`/geo-suggest${buildQuery({ q: query, bound, regionFiasId })}`);
}

// Скрипт привязан к ЛИДУ: администратор выбирает его на странице «Лиды», а
// сервер по текущему статусу лида решает, показать основной скрипт или скрипт
// для повторных (этапы 5–6). employeeId в запросе больше не нужен. null в
// ответе — скрипта для этого состояния нет, это не ошибка (routes/scripts.js).
export function fetchScript(leadId) {
    return request(`/scripts${buildQuery({ leadId })}`);
}

// Возражения того скрипта, который сейчас открыт у оператора. Запрашиваются по
// leadId, а не по scriptId: какой скрипт открыт — решает сервер, и подставить
// чужой идентификатор нельзя. Поиск идёт на клиенте — возражений десятки, и в
// разговоре задержка на запрос заметна.
export function fetchObjections(leadId) {
    return request(`/scripts/objections${buildQuery({ leadId })}`);
}
