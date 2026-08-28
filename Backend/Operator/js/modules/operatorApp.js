// --- operatorApp.js: страница оператора (operator.html) ---
//
// Список лидов заменён ОЧЕРЕДЬЮ (решение владельца, 15.08.2026). Оператор не
// выбирает, с кем работать: система выдаёт по одной карточке, сохранение сразу
// открывает следующую. Промежуточного экрана со списком нет.
//
// Три взаимоисключающих состояния рабочей области:
//   • работа с лидом — скрипт 55 % + карточка 45 %;
//   • пустая очередь — «Нет активных лидов» и счётчик ожидания;
//   • не на линии — «Новые лиды не поступают» с реальным состоянием.
//
// Кнопка «Сохранить» — ВРЕМЕННЫЙ механизм выдачи следующего лида. Целевая
// модель: карточка открывается сама, когда телефония начала исходящий звонок
// (future_implementation_notes.md п.24). Поэтому вокруг кнопки ничего не
// построено — она вызывает ту же функцию, что и опрос очереди.

import { requireOperatorIdentity } from './operatorIdentity.js';
import { initOperatorNav } from './operatorNav.js';
import { showToast } from './operatorToast.js';
import {
    fetchNextLead, completeLead, closeByWrapupTimeout, fetchFunnelStatuses, fetchScript,
    fetchEmployee, fetchParamLists
} from './operatorStorage.js';
import { createScriptView } from './operatorScript.js';
import { renderLeadForm, clearFlash } from './operatorLeadForm.js';
import { createWorkStatePanel } from './operatorWorkState.js';
import { createObjectionsPanel } from './operatorObjections.js';

// Опрос очереди на экране ожидания. Кнопки «Обновить» нет намеренно: она
// провоцирует дёргать страницу вместо того, чтобы ждать.
const QUEUE_POLL_MS = 15000;
const FLASH_MS = 2000;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', async function () {
    const identity = requireOperatorIdentity();
    if (!identity) return; // уже редиректнуло на operator-login.html

    const workArea = document.getElementById('opWorkArea');

    let statuses = [];
    // Справочники карточки клиента грузятся один раз при заходе на страницу и
    // живут в памяти — внутри рабочего дня их правит владелец, и перечитывать их
    // на каждую выданную карточку незачем.
    let paramLists = {};
    let currentLead = null;
    // Что СЕЙЧАС НАРИСОВАНО на экране. Отдельно от currentLead: на перерыве лид
    // остаётся закреплён (currentLead не пуст), но на экране висит «не на
    // линии», и сравнивать «пришёл тот же лид» надо именно с нарисованным —
    // иначе возврат на линию не перерисовывал бы карточку.
    let renderedLeadId = null;
    let pollTimer = null;
    let flashTimer = null;
    let cardForm = null;

    let employee = {};
    try {
        employee = await fetchEmployee(identity.id);
    } catch (e) {
        showToast(e.message, 'error');
    }

    const workState = createWorkStatePanel({
        employeeId: identity.id,
        identity: { ...identity, lineType: employee.lineType },
        onStateChange: () => { refreshQueue({ silent: true }); },
        // ПОСТ-ОБРАБОТКА КОНЧИЛАСЬ САМА (заход 6). До него маршрут был построен и
        // не звался ниоткуда: включать его было нельзя, пока не появился статус
        // «Нет результата», — иначе карточка закрывалась бы в никуда.
        //
        // Возвращает false, когда закрывать ещё нечего: карточка собирается
        // двумя запросами, и предел может истечь раньше, чем она дорисована.
        // Счётчик по этому ответу понимает, что заявку надо повторить.
        onWrapupExpired: () => requestTimeoutClose()
    });
    const objections = createObjectionsPanel();

    initOperatorNav({
        employeeId: identity.id,
        // Выход закрывает открытый интервал состояния: иначе «На линии»
        // накрутило бы всю ночь, и таймеры, ради которых всё делается, врали бы
        // с первого дня (решение куратора, dialog.md C3).
        beforeLogout: () => workState.setState('off')
    });

    try {
        statuses = await fetchFunnelStatuses();
    } catch (e) {
        showToast(e.message, 'error');
    }

    try {
        paramLists = await fetchParamLists();
    } catch (e) {
        // Карточка остаётся рабочей и без справочников: выпадающие списки
        // окажутся пустыми, но уже сохранённые значения не потеряются —
        // каждое из них показывается отдельным пунктом «— вне списка».
        showToast('Справочники не загрузились — выпадающие списки будут пустыми', 'error');
    }

    await workState.refresh();

    // ---- Экраны ------------------------------------------------------------

    function stopPolling() {
        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startPolling() {
        if (pollTimer !== null) return;
        pollTimer = setInterval(() => { refreshQueue({ silent: true }); }, QUEUE_POLL_MS);
    }

    function renderOfflineScreen() {
        renderedLeadId = null;
        const label = document.getElementById('opStateName').textContent;
        workArea.innerHTML = `
            <div class="op-screen">
                <div class="op-halo"><i class="fas fa-mug-hot" aria-hidden="true"></i></div>
                <h2>Новые лиды не поступают</h2>
                <p>Вы в состоянии «${escapeHtml(label)}». Очередь остановлена${currentLead
                    ? ', текущий лид остаётся закреплён за вами и откроется, как только вы вернётесь на линию.'
                    : ' и возобновится, как только вы вернётесь на линию.'}</p>
                <button type="button" class="btn btn-primary" id="opBackOnlineBtn">Вернуться на линию</button>
            </div>
        `;
        document.getElementById('opBackOnlineBtn').addEventListener('click', () => workState.setState('on_line'));
    }

    // Счётчик на экране ожидания идёт с момента ПОЯВЛЕНИЯ ЭКРАНА: это ответ на
    // вопрос «сколько я жду лида», а не «сколько я на смене» — второе видно в
    // панели состояний (dialog.md G8).
    function renderEmptyQueueScreen() {
        renderedLeadId = null;
        if (workArea.querySelector('.op-screen.waiting')) return; // не сбрасываем счётчик на каждом опросе
        workArea.innerHTML = `
            <div class="op-screen waiting">
                <div class="op-halo"><i class="fas fa-inbox" aria-hidden="true"></i></div>
                <h2>Нет активных лидов</h2>
                <p>Вы на линии — следующий лид откроется здесь автоматически, как только поступит.</p>
                <div class="op-wait-timer">Ожидание: <b data-live-timer="${workState.serverNow()}">00:00</b></div>
            </div>
        `;
    }

    async function renderLeadScreen(lead, flash) {
        workArea.innerHTML = `
            <div class="op-detail-grid">
                <section class="op-panel op-script-panel" id="opScriptPanel"></section>
                <section class="op-panel" id="opCardPanel"></section>
            </div>
        `;
        const scriptPanel = document.getElementById('opScriptPanel');
        const cardPanel = document.getElementById('opCardPanel');

        // СПРАВОЧНИК СТАТУСОВ ПЕРЕЧИТЫВАЕТСЯ НА КАЖДУЮ КАРТОЧКУ (часть 9,
        // заход 5). Прежде он читался один раз при входе — и этого хватало,
        // пока признаки статуса менялись ТОЛЬКО миграцией, то есть выкаткой, а
        // выкатка перезагружает всё.
        //
        // Теперь предел попыток задаёт руководитель на вкладке «События», живьём:
        // экран, открытый на смену, показывал бы вчерашнее число часами. Сервер
        // при этом не отстаёт ни на секунду — расходилась бы только надпись, и
        // это ровно тот случай, когда экран обещает не то, что сделает система.
        //
        // Место выбрано по тому же доводу, что у скрипта строкой ниже: карточка
        // и так собирается заново, лишнего обхода это не добавляет. Отказ не
        // ломает карточку — остаётся прежний список, он не хуже вчерашнего.
        // Тоста здесь нет намеренно: оператор не просил обновлять справочник и
        // не должен разбираться, почему тот не обновился. Строка в консоль —
        // чтобы поломка не была молчаливой.
        try {
            statuses = await fetchFunnelStatuses();
        } catch (e) {
            console.error('Справочник статусов не обновился', e);
        }

        // Скрипт зависит от ТЕКУЩЕГО статуса лида (этапы 5–6 — скрипт для
        // повторных), поэтому запрашивается на каждую карточку заново.
        try {
            const script = await fetchScript(lead.id);
            if (script) {
                createScriptView(scriptPanel, script);
            } else {
                scriptPanel.innerHTML = '<p class="op-script-end">Для этого статуса скрипт не назначен</p>';
            }
        } catch (e) {
            showToast(e.message, 'error');
            scriptPanel.innerHTML = '';
        }

        renderedLeadId = lead.id;
        // Ссылка на форму нужна второму пути закрытия: истёкшая пост-обработка
        // сохраняет ровно то же набранное, что и «Сохранить», и собирает его тем
        // же кодом — иначе часть введённого терялась бы молча.
        cardForm = renderLeadForm(cardPanel, lead, statuses, paramLists, (data, nextCallAt, validationError) => {
            if (validationError) {
                showToast(validationError, 'error');
                return;
            }
            save(lead.id, data, nextCallAt);
        }, { flash });

        if (flash) {
            if (flashTimer !== null) clearTimeout(flashTimer);
            flashTimer = setTimeout(() => clearFlash(cardPanel), FLASH_MS);
        }
    }

    // ---- Очередь -----------------------------------------------------------

    async function showLead(lead, flash) {
        currentLead = lead;
        // Предел пост-обработки приезжает ВМЕСТЕ С КАРТОЧКОЙ и свой у каждой:
        // длительность задана парой «линия + скрипт» этого разговора. Считает
        // его сервер (`resolveWrapupSeconds`); null — пары нет, пост-обработка не
        // кончается сама, и это законное состояние.
        workState.setOpenedAt(lead ? lead.openedAt : null, lead ? lead.wrapupSeconds : null);
        // Карточка ушла — форма, с которой её собирали, больше не годится.
        if (!lead) cardForm = null;
        // Кнопка возражений привязана к КАРТОЧКЕ НА ЭКРАНЕ, а не к закреплённому
        // лиду: на перерыве лид остаётся за оператором, но скрипта на экране нет
        // и искать в нём нечего.
        const cardOnScreen = workState.isOnline() && !!lead;
        objections.setLead(cardOnScreen ? lead.id : null);

        if (!workState.isOnline()) {
            stopPolling();
            renderOfflineScreen();
            return;
        }
        if (!lead) {
            startPolling();
            renderEmptyQueueScreen();
            return;
        }
        stopPolling();
        await renderLeadScreen(lead, flash);
    }

    async function refreshQueue({ silent } = {}) {
        // Не на линии — очередь не опрашиваем вообще: сервер всё равно ничего не
        // выдаст, а лишний запрос раз в 15 секунд не нужен никому.
        if (!workState.isOnline()) {
            await showLead(currentLead, false);
            return;
        }
        try {
            const result = await fetchNextLead(identity.id);
            const lead = result && result.lead;
            // Та же карточка И она уже на экране — не перерисовываем поверх
            // работы оператора: он мог заполнить половину полей.
            if (lead && lead.id === renderedLeadId) return;
            await showLead(lead || null, false);
        } catch (e) {
            if (!silent) showToast(e.message, 'error');
        }
    }

    async function save(leadId, data, nextCallAt) {
        const button = document.getElementById('opSaveLeadBtn');
        if (button) button.disabled = true;
        try {
            const result = await completeLead(leadId, identity.id, data, nextCallAt);
            await showLead(result.next || null, !!result.next);
            showToast(result.next ? 'Сохранено · выдан следующий лид' : 'Сохранено · свободных лидов больше нет', 'success');
        } catch (e) {
            if (e.status === 409) {
                // Лид успел уйти по времени или его перехватили. Данные НЕ
                // сохранены — оператор должен это увидеть, а не догадаться.
                showToast(e.message, 'error');
                await refreshQueue({ silent: true });
                return;
            }
            showToast(e.message, 'error');
            if (button) button.disabled = false;
        }
    }

    /**
     * Пост-обработка кончилась по времени — карточка закрывается сама.
     *
     * НАБРАННОЕ СОХРАНЯЕТСЯ, А НЕ ВЫБРАСЫВАЕТСЯ. Пометка «заполнена частично»
     * говорит «работа сделана, просто не вся»; выбросить введённое и поставить
     * эту пометку значило бы соврать — работы не осталось бы никакой.
     *
     * ОПЕРАТОР УЗНАЁТ ОБ ЭТОМ СЛОВАМИ. Карточка меняется у него на глазах, и
     * молчаливая подмена читалась бы как сбой: он решил бы, что потерял работу.
     */
    /**
     * Готовы ли закрывать прямо сейчас. Ответ синхронный, и это важно: по нему
     * счётчик решает, взводить ли свой одноразовый флаг или повторить заявку на
     * следующем тике.
     */
    function requestTimeoutClose() {
        if (!currentLead || renderedLeadId !== currentLead.id || !cardForm) return false;
        closeByTimeout();
        return true;
    }

    async function closeByTimeout() {
        const leadId = currentLead.id;
        try {
            const result = await closeByWrapupTimeout(leadId, identity.id, cardForm.collect());
            await showLead(result.next || null, !!result.next);
            // ТЕКСТ ПО К235. Первая редакция называла два факта системы и ни
            // одного факта человека: у оператора в этот момент три вопроса, и
            // первый из них — «что с тем, что я набрал». Порядок фраз и слово
            // «введённые данные» — не вкус: ровно этими словами говорит отказ
            // того же маршрута (`routes/leads.js`), и успех с отказом обязаны
            // называть одно и то же одинаково.
            //
            // Две половины по `result.next` и разделитель ` · ` — приём соседнего
            // тоста сохранения, а не новый. Статус здесь не называется: оператор
            // его не выбирал, изменить не может и карточки уже не видит.
            showToast('Время пост-обработки вышло · введённые данные сохранены, карточка помечена '
                + '«заполнена частично» · '
                + (result.next ? 'выдан следующий лид' : 'свободных лидов больше нет'), 'info');
        } catch (e) {
            // Отказ здесь не должен ломать экран: карточка либо уже закрыта
            // сторожем, либо ушла к другому. Обновляем очередь и говорим прямо.
            showToast(e.message, 'error');
            await refreshQueue({ silent: true });
        }
    }

    // Если карточка была открыта до перезагрузки страницы, сервер вернёт ЕЁ же:
    // opened_at не сбрасывается, и начатая работа не теряется.
    await refreshQueue();

    // На всякий случай синхронизируем состояние и суммы, когда вкладка снова
    // становится видимой: за время в фоне таймеры браузера могли отстать.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) workState.refresh();
    });
});

// Открытая карточка остаётся за оператором и после закрытия вкладки — это
// сознательное правило («лид держится за оператором»), поэтому opened_at здесь
// НЕ сбрасывается. Забирает такого лида обратно только правило освобождения
// удержанного лида на сервере (services/leadDistribution.js).
