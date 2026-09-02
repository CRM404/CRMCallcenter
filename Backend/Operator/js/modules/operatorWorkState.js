// --- operatorWorkState.js: блок оператора — пилюля состояния и таймеры ---
//
// Компонент один: пилюля с цветной точкой, названием состояния и идущим
// счётчиком; по клику раскрывается панель с пятью строками «состояние + сумма
// за сегодня + выбор». Ряда кнопок нет намеренно — пять кнопок заняли бы треть
// шапки и давали бы постоянный риск случайного клика; панель ещё и оставляет
// ОДНУ точку входа, куда телефония потом будет писать состояние сама.
//
// Пост-обработка — системное состояние, вручную не выбирается (иначе появился
// бы способ бесконечно не брать лидов) и показывается ТОЛЬКО здесь, синим:
// отдельная планка над карточкой была бы второй копией того же счётчика.
//
// Часы браузера источником правды не являются (dialog.md G5): сервер отдаёт
// startedAt и своё now, клиент считает от их разницы. Расхождение системных
// часов оператора иначе обесценило бы всю затею с таймерами.

import { fetchWorkState, setWorkState } from './operatorStorage.js';
import { showToast } from './operatorToast.js';

// Пульсация пилюли: напоминание, а не блокировка. Забытый «обед» до конца смены
// — реальный сценарий, поэтому мягкий сигнал есть, а запрета нет.
const OFFLINE_NUDGE_SECONDS = 15 * 60;

// ПРЕДЕЛ ПОСТ-ОБРАБОТКИ ЗАДАЁТ СОБЫТИЕ, А ПОРОГ ПУЛЬСАЦИИ — ПРОИЗВОДНЫЙ ОТ НЕГО
// (заход 6, тот же приём, что у порога предупреждения о попытках в заходе 3).
// Пять минут были верны, пока длительность стояла константой; теперь её задаёт
// руководитель парой «линия + скрипт», и зашитый порог при пределе в 90 секунд
// не сработал бы ни разу, а при пределе в час загорелся бы на пятой минуте.
//
// Предела нет вовсе — пары в перечне события нет, и пост-обработка не кончается
// сама. Это законное состояние: тогда порог остаётся прежним, пятиминутным,
// потому что напоминать всё равно надо, а отсчитывать нечего.
const POSTWORK_NUDGE_SHARE = 0.75;
const POSTWORK_NUDGE_FALLBACK = 5 * 60;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function mmss(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// Суммы за день — словами, а не «02:19» (замечание дизайн-сессии на приёмке,
// 15.08.2026). Рядом в пилюле бежит счётчик в формате мм:сс, и два одинаковых с
// виду числа в двух сантиметрах друг от друга означали бы разное: «00:06» в
// пилюле — шесть секунд, «00:06» в панели — шесть минут. Подпись словами делает
// путаницу невозможной.
function hhmm(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    if (hours === 0 && minutes === 0) return `${s % 60} с`;
    if (hours === 0) return `${minutes} мин`;
    return `${hours} ч ${minutes} мин`;
}

export function createWorkStatePanel({ employeeId, identity, onStateChange, onWrapupExpired }) {
    const pill = document.getElementById('opStatePill');
    const pillName = document.getElementById('opStateName');
    const pillTimer = document.getElementById('opStateTimer');
    const panel = document.getElementById('opStatePanel');

    // Смещение серверных часов относительно браузерных. Пересчитывается на
    // каждом ответе сервера.
    let clockOffsetMs = 0;
    let current = { state: 'off', startedAt: null, totals: {}, states: [] };
    // Момент выдачи текущей карточки: от него идёт пост-обработка.
    let openedAt = null;
    // Предел пост-обработки по ЭТОЙ карточке. Считает его сервер: длительность
    // задана парой «линия + скрипт», и собирать её здесь значило бы завести
    // второй экземпляр правила. null — пары нет, пост-обработка не кончается
    // сама, и это законное состояние, а не поломка.
    let wrapupLimit = null;
    let expiredFired = false;

    const initials = [identity.lastName, identity.firstName]
        .filter(Boolean).map((s) => String(s).charAt(0).toUpperCase()).join('') || '—';
    document.getElementById('opIdentityAvatar').textContent = initials;
    document.getElementById('opIdentityName').textContent =
        [identity.lastName, identity.firstName].filter(Boolean).join(' ') || 'Оператор';
    // Линия — РЕАЛЬНАЯ («Входящая»/«Исходящая»). Выдуманных названий линий в
    // интерфейсе быть не должно: такой сущности в базе нет (dialog.md G7).
    document.getElementById('opIdentityLine').textContent =
        identity.lineType ? `Линия: ${identity.lineType}` : 'Линия не назначена';

    function serverNow() {
        return Date.now() + clockOffsetMs;
    }

    function stateLabel(key) {
        const found = (current.states || []).find((s) => s.key === key);
        if (found) return found.label;
        return key === 'off' ? 'Не в системе' : key;
    }

    function secondsInState() {
        if (!current.startedAt) return 0;
        return (serverNow() - new Date(current.startedAt).getTime()) / 1000;
    }

    // Пост-обработка идёт ВНУТРИ «на линии», а не вместо него, и не может быть
    // длиннее текущего пребывания на линии: оператор, ушедший на перерыв с
    // открытой карточкой, вернувшись, увидел бы в счётчике весь перерыв.
    function postworkSeconds() {
        if (!openedAt) return 0;
        const from = Math.max(new Date(openedAt).getTime(), current.startedAt ? new Date(current.startedAt).getTime() : 0);
        return (serverNow() - from) / 1000;
    }

    function isPostwork() {
        return current.state === 'on_line' && !!openedAt;
    }

    // Порог пульсации: три четверти предела, а без предела — прежние пять минут.
    function postworkNudgeSeconds() {
        return wrapupLimit ? Math.round(wrapupLimit * POSTWORK_NUDGE_SHARE) : POSTWORK_NUDGE_FALLBACK;
    }

    /**
     * Предел истёк — сказать об этом ОДИН раз на карточку.
     *
     * Тик идёт раз в секунду, и без флага заявка на закрытие уходила бы каждую
     * секунду, пока сервер отвечает. Флаг снимается вместе с карточкой, в
     * `setOpenedAt`: новая карточка — новый отсчёт.
     *
     * ⚠ ФЛАГ ВЗВОДИТСЯ ТОЛЬКО ТОГДА, КОГДА ЗАКРЫТИЕ ДЕЙСТВИТЕЛЬНО НАЧАЛОСЬ.
     * Первая редакция взводила его безусловно — и предел, истёкший раньше, чем
     * карточка дорисовалась (а она собирается двумя запросами), закрывал
     * заявку навсегда: экран досчитывал до предела, ничего не делал и молчал.
     * Поймано браузерной проверкой с пределом в одну секунду; чтением такое не
     * видно, потому что код выглядит правильным.
     */
    function checkWrapupExpired(seconds) {
        if (!wrapupLimit || expiredFired || seconds < wrapupLimit) return;
        if (!onWrapupExpired) return;
        expiredFired = onWrapupExpired() !== false;
    }

    function renderPill() {
        const post = isPostwork();
        const seconds = post ? postworkSeconds() : secondsInState();
        const classes = ['op-state'];
        if (post) classes.push('post');
        else if (current.state === 'on_line') classes.push('online');
        if (post) checkWrapupExpired(seconds);
        if (post && seconds > postworkNudgeSeconds()) classes.push('nudge');
        if (!post && current.state !== 'on_line' && secondsInState() > OFFLINE_NUDGE_SECONDS) classes.push('nudge');
        pill.className = classes.join(' ');
        pillName.textContent = post ? 'Пост-обработка' : stateLabel(current.state);
        pillTimer.textContent = mmss(seconds);
    }

    function renderPanel() {
        const rows = (current.states || []).map((s) => {
            const today = (current.totals && current.totals[s.key]) || 0;
            const live = s.key === current.state ? secondsInState() : 0;
            return `
                <button type="button" class="op-state-row${s.key === current.state ? ' is-current' : ''}" data-state="${escapeHtml(s.key)}">
                    <span class="dot"></span>
                    <span class="name">${escapeHtml(s.label)}</span>
                    <span class="sum">${hhmm(today + live)}</span>
                </button>
            `;
        }).join('');
        panel.innerHTML = `
            <div class="op-state-panel-head">Состояние и время за сегодня</div>
            ${rows}
            <div class="op-state-panel-foot">Лиды поступают только в состоянии «На линии». Пост-обработка включается сама, пока карточка открыта.</div>
        `;
        panel.querySelectorAll('[data-state]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.state;
                closePanel();
                if (key === current.state) return;
                changeState(key);
            });
        });
    }

    function openPanel() {
        renderPanel();
        panel.hidden = false;
        pill.setAttribute('aria-expanded', 'true');
    }

    function closePanel() {
        panel.hidden = true;
        pill.setAttribute('aria-expanded', 'false');
    }

    function applyServerState(data) {
        if (!data) return;
        clockOffsetMs = new Date(data.now).getTime() - Date.now();
        current = {
            state: data.state,
            startedAt: data.startedAt,
            totals: data.totals || {},
            states: data.states || current.states
        };
        renderPill();
        if (!panel.hidden) renderPanel();
        if (data.releasedLeadNotice) {
            showToast('Лид, который был за вами, вернулся в общую очередь', 'info');
        }
    }

    async function changeState(key) {
        try {
            const data = await setWorkState(employeeId, key);
            applyServerState(data);
            showToast(key === 'on_line' ? 'Вы на линии — очередь возобновлена' : `Состояние: ${stateLabel(key)}`, 'success');
            if (onStateChange) onStateChange(current.state);
        } catch (e) {
            showToast(e.message, 'error');
        }
    }

    pill.addEventListener('click', (event) => {
        event.stopPropagation();
        if (panel.hidden) openPanel(); else closePanel();
    });
    document.addEventListener('click', (event) => {
        if (!panel.hidden && !panel.contains(event.target) && !event.target.closest('#opStatePill')) closePanel();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePanel();
    });

    // Один общий тик на страницу: пилюля, а также счётчики на экранах ожидания
    // (их обновляет тот, кто их нарисовал, — по data-атрибуту).
    setInterval(() => {
        renderPill();
        if (!panel.hidden) renderPanel();
        document.querySelectorAll('[data-live-timer]').forEach((el) => {
            const from = Number(el.dataset.liveTimer);
            el.textContent = mmss((serverNow() - from) / 1000);
        });
    }, 1000);

    return {
        async refresh() {
            try {
                applyServerState(await fetchWorkState(employeeId));
            } catch (e) {
                showToast(e.message, 'error');
            }
        },
        setState(key) { return changeState(key); },
        getState() { return current.state; },
        isOnline() { return current.state === 'on_line'; },
        // Карточка выдана/закрыта — от этого зависит, показывать ли пост-обработку.
        // Вместе с ней приезжает и её предел: он свой у каждой карточки, потому
        // что задан парой «линия + скрипт» этого разговора.
        setOpenedAt(value, limitSeconds) {
            openedAt = value || null;
            const limit = Number(limitSeconds);
            wrapupLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
            expiredFired = false;
            renderPill();
        },
        serverNow
    };
}
