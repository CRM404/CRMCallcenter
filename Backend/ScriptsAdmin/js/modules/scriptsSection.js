// --- scriptsSection.js: раздел «Скрипты» в оболочке ---
//
// Контракт раздела (бриф, 3.2):
//     export async function mount(container, ctx)
//     export function unmount()
//
// Бывший scriptsAdminApp.js. Что изменилось против страницы scripts-admin.html:
//
// 1. Состояние живёт В ЭКЗЕМПЛЯРЕ, а не в модуле. ES-модуль — синглтон: при
//    двух открытых панелях модульные переменные были бы общими, и разделы
//    перетирали бы друг другу открытый скрипт и режим редактирования.
// 2. Никаких document.getElementById — только поиск по data-role в границах
//    своего контейнера. Глобальных id в разделе не осталось.
// 3. Свои тост, модалка подтверждения и навигация удалены: они пришли из слоя
//    элементов и оболочки (ctx.toast, ctx.confirm, ctx.confirmDanger).
// 4. Запросы идут через ctx.api — транспорт, привязанный к жизни панели.
//    Закрытие панели обрывает их, isAbort() гасит ложный тост про связь.
//
// Тексты — из кода страницы как есть (правило брифа: источник истины по
// текстам — код, а не макет).

import { openModal } from '/ui/modal.js';
import { isAbort } from '/api.js';
import { createStorage } from './scriptsAdminStorage.js';
import { renderScriptRows, CONFIRM_TEXTS } from './scriptsAdminScriptList.js';
import { renderNodesPanel } from './scriptsAdminNodes.js';

// Открытые экземпляры раздела. Оболочка зовёт unmount() без аргументов, а
// панелей с одним и тем же разделом больше одной быть не может (panels.js
// переводит фокус на существующую), но список честнее одиночной переменной:
// он не соврёт, если правило когда-нибудь изменится.
const instances = [];

export async function mount(container, ctx) {
    // Панель могли закрыть, пока прошлый экземпляр грузил данные: оболочка в
    // этом случае не успевает получить ссылку на unmount и не зовёт его.
    // Подчищаем таких по признаку «контейнер уже вырезан из документа».
    purgeDetached();

    const state = {
        container,
        // Панель нужна окнам: затемнение накрывает свою панель, а не весь
        // экран, — иначе непонятно, к какой из двух открытых панелей окно
        // относится.
        panel: container.closest('.shell-panel'),
        ctx,
        storage: createStorage(ctx.api),
        scripts: [],
        selectedScript: null,
        nodes: [],
        nodesUi: emptyNodesUi(),
        destroyed: false
    };
    instances.push(state);

    bindEvents(state);
    await reloadScripts(state);
}

// Состояние наполнения: что сейчас открыто на правку. rootCreating — редактор
// пустого основного текста, развёрнутый кнопкой пустого состояния: до нажатия
// его нет, иначе пустой блок с открытым полем читается как сломанное поле.
function emptyNodesUi() {
    return { rootEditing: false, rootCreating: false, addingObjection: false, editingObjectionId: null };
}

export function unmount() {
    const state = instances.pop();
    if (state) state.destroyed = true;
    purgeDetached();
}

function purgeDetached() {
    for (let i = instances.length - 1; i >= 0; i--) {
        if (!document.contains(instances[i].container)) {
            instances[i].destroyed = true;
            instances.splice(i, 1);
        }
    }
}

/** Слушатели висят на узлах контейнера — оболочка очищает его после unmount. */
function $(state, role) {
    return state.container.querySelector(`[data-role="${role}"]`);
}

// ---------------------------------------------------------------- данные

async function reloadScripts(state) {
    try {
        const scripts = await state.storage.fetchScripts();
        if (state.destroyed) return;
        state.scripts = scripts;
        renderStats(state);
        renderList(state);

        if (state.selectedScript) {
            const refreshed = scripts.find((s) => s.id === state.selectedScript.id);
            if (!refreshed) {
                // Скрипт удалили — открытая карточка больше ни на что не ссылается.
                hideOpened(state);
            } else {
                state.selectedScript = refreshed;
                syncOpenStatus(state);
            }
        }
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}

async function reloadNodes(state) {
    try {
        const nodes = await state.storage.fetchScriptNodes(state.selectedScript.id);
        if (state.destroyed) return;
        state.nodes = nodes;
        renderNodes(state);
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}

// ---------------------------------------------------------------- отрисовка

// Счётчики считаются из уже загруженного списка — отдельного эндпоинта под три
// числа заводить не нужно (решение куратора).
function renderStats(state) {
    $(state, 'stat-total').textContent = state.scripts.length;
    $(state, 'stat-active').textContent = state.scripts.filter((s) => s.status === 'active').length;
    $(state, 'stat-draft').textContent = state.scripts.filter((s) => s.status === 'draft').length;
}

function renderList(state) {
    const selectedId = state.selectedScript ? state.selectedScript.id : null;
    $(state, 'rows').innerHTML = renderScriptRows(state.scripts, selectedId);
    $(state, 'empty').hidden = state.scripts.length > 0;
    state.container.querySelector('.ui-table-wrap').hidden = state.scripts.length === 0;
    // Подпись объясняет, что делать со СПИСКОМ, и исчезает в двух случаях:
    // скриптов нет вовсе (там своё пустое состояние со своим следующим шагом)
    // и скрипт уже открыт — сказанное уже сделано.
    $(state, 'list-note').hidden = state.scripts.length === 0 || state.selectedScript !== null;
}

function syncOpenStatus(state) {
    if (!state.selectedScript) return;
    const chip = $(state, 'open-status');
    const active = state.selectedScript.status === 'active';
    chip.className = `ui-pill ${active ? 'ui-pill--ok' : 'ui-pill--mute'}`;
    chip.textContent = active ? 'Активен' : 'Черновик';
}

function renderNodes(state) {
    renderNodesPanel($(state, 'nodes'), state.nodes, state.nodesUi, {
        toast: state.ctx.toast,
        // Блокировка кнопки на время запроса — та же, что у кнопок самого
        // раздела. Панель узлов свои кнопки рисует сама, поэтому получает
        // помощника так же, как тост: одна реализация на раздел.
        busy: withBusy,

        onCreateRootStart: () => { state.nodesUi.rootCreating = true; renderNodes(state); },
        onEditRootStart: () => { state.nodesUi.rootEditing = true; renderNodes(state); },
        onCancelRootEdit: () => {
            state.nodesUi.rootEditing = false;
            state.nodesUi.rootCreating = false;
            renderNodes(state);
        },

        onCreateRoot: async (content) => {
            if (!content || !content.trim()) {
                state.ctx.toast('Укажите текст', 'error');
                return;
            }
            try {
                await state.storage.createScriptNode(state.selectedScript.id, {
                    parentId: null, nodeType: 'statement', label: null, content, sortOrder: 0
                });
                if (state.destroyed) return;
                state.ctx.toast('Основной текст создан', 'success');
                state.nodesUi.rootCreating = false;
                await reloadNodes(state);
                await reloadScripts(state);
            } catch (err) {
                if (!isAbort(err)) state.ctx.toast(err.message, 'error');
            }
        },

        onSaveRoot: async (root, content) => {
            if (!content || !content.trim()) {
                state.ctx.toast('Укажите текст', 'error');
                return;
            }
            try {
                await state.storage.updateScriptNode(root.id, {
                    parentId: null, nodeType: 'statement', label: null, content, sortOrder: root.sortOrder
                });
                if (state.destroyed) return;
                state.ctx.toast('Основной текст сохранён', 'success');
                state.nodesUi.rootEditing = false;
                await reloadNodes(state);
            } catch (err) {
                if (!isAbort(err)) state.ctx.toast(err.message, 'error');
            }
        },

        onAddObjectionStart: () => { state.nodesUi.addingObjection = true; renderNodes(state); },
        onAddObjectionCancel: () => { state.nodesUi.addingObjection = false; renderNodes(state); },

        onCreateObjection: async ({ label, content }) => {
            if (!label || !label.trim()) {
                state.ctx.toast('Укажите метку возражения', 'error');
                return;
            }
            if (!content || !content.trim()) {
                state.ctx.toast('Укажите текст возражения', 'error');
                return;
            }
            const root = state.nodes.find((n) => n.parentId === null);
            const maxSortOrder = state.nodes
                .filter((n) => n.parentId === root.id)
                .reduce((max, n) => Math.max(max, n.sortOrder), 0);
            try {
                await state.storage.createScriptNode(state.selectedScript.id, {
                    parentId: root.id, nodeType: 'objection', label, content, sortOrder: maxSortOrder + 1
                });
                if (state.destroyed) return;
                state.ctx.toast('Возражение добавлено', 'success');
                state.nodesUi.addingObjection = false;
                await reloadNodes(state);
                await reloadScripts(state);
            } catch (err) {
                if (!isAbort(err)) state.ctx.toast(err.message, 'error');
            }
        },

        onEditObjectionStart: (id) => { state.nodesUi.editingObjectionId = id; renderNodes(state); },
        onEditObjectionCancel: () => { state.nodesUi.editingObjectionId = null; renderNodes(state); },

        onSaveObjection: async (node, { label, content }) => {
            if (!label || !label.trim()) {
                state.ctx.toast('Укажите метку возражения', 'error');
                return;
            }
            if (!content || !content.trim()) {
                state.ctx.toast('Укажите текст возражения', 'error');
                return;
            }
            try {
                await state.storage.updateScriptNode(node.id, {
                    parentId: node.parentId, nodeType: 'objection', label, content, sortOrder: node.sortOrder
                });
                if (state.destroyed) return;
                state.ctx.toast('Возражение сохранено', 'success');
                state.nodesUi.editingObjectionId = null;
                await reloadNodes(state);
            } catch (err) {
                if (!isAbort(err)) state.ctx.toast(err.message, 'error');
            }
        },

        onDeleteObjection: async (id) => {
            // Заголовок спрашивает, текст называет последствия и НАЗЫВАЕТ САМО
            // возражение (К161). Прежний текст дословно повторял заголовок —
            // такое окно закрывают не читая, и именно на нём случаются потери.
            const node = state.nodes.find((n) => n.id === id);
            const label = node && node.label ? node.label : '(без метки)';
            const ok = await state.ctx.confirmDanger({
                title: 'Удалить это возражение?',
                message: `Возражение «${label}» будет удалено из скрипта. Это необратимо.`
            });
            if (!ok || state.destroyed) return;
            try {
                await state.storage.deleteScriptNode(id);
                if (state.destroyed) return;
                state.ctx.toast('Возражение удалено', 'success');
                await reloadNodes(state);
                await reloadScripts(state);
            } catch (err) {
                if (!isAbort(err)) state.ctx.toast(err.message, 'error');
            }
        }
    });
}

// ---------------------------------------------------------------- режимы

// «Открыть» — шапка (название + статус) и наполнение (основной текст +
// возражения). СПИСОК ОСТАЁТСЯ НА ЭКРАНЕ (К154), а его строка отмечается: тот,
// кто правит возражения, ходит по двум-трём похожим скриптам подряд и
// переключается «Открыть» → «Открыть». Прячется только подпись под списком —
// она зовёт открыть скрипт, а он уже открыт.
async function openScript(state, script) {
    state.selectedScript = script;
    state.nodesUi = emptyNodesUi();
    $(state, 'opened').hidden = false;
    $(state, 'meta-title').value = script.title;
    syncOpenStatus(state);
    renderList(state);
    await reloadNodes(state);
}

function hideOpened(state) {
    state.selectedScript = null;
    state.nodes = [];
    state.nodesUi = emptyNodesUi();
    $(state, 'opened').hidden = true;
    $(state, 'nodes').innerHTML = '';
    renderList(state);
}

/**
 * Окно «Новый скрипт». Единственное поле — название; после создания скрипт
 * сразу открывается на наполнение.
 *
 * Список при этом ОСТАЁТСЯ НА ЭКРАНЕ. Прежняя карточка показывалась вместо
 * него: нажав «Новый скрипт», человек терял таблицу скриптов целиком и не мог
 * посмотреть, как называются соседние (Н9). Окно берётся из слоя, поэтому
 * заодно приходят Esc, закрытие щелчком по затемнению, ловушка фокуса и
 * блокировка кнопки на время запроса — раздел ничего этого не пишет.
 */
function openCreateModal(state) {
    const body = document.createElement('div');
    body.className = 'ui-form-grid ui-form-grid--single';
    body.innerHTML = '<div class="ui-field">'
        + '<label class="ui-field__label" for="scrNewTitle">Название</label>'
        + '<input type="text" class="ui-field__control" id="scrNewTitle" '
        + 'placeholder="Например: Первичный обзвон — новостройки">'
        + '</div>';
    const input = body.querySelector('#scrNewTitle');

    const modal = openModal({
        title: 'Новый скрипт',
        body,
        scope: state.panel,
        size: 'narrow',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: false },
            {
                label: 'Создать',
                // Пустое название проверяется не здесь, а в createScript — там
                // же, где запрос: одно место, где решается судьба окна.
                onClick: () => createScript(state, input.value.trim())
            }
        ]
    });

    // Фокус в поле, а не на кнопке: окно с одним полем открывают, чтобы
    // печатать. Enter отправляет — как в любой однопольной форме.
    input.focus();
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const create = modal.box.querySelectorAll('.ui-modal__actions .ui-btn')[1];
        if (create && !create.disabled) create.click();
    });

    return modal;
}

// ---------------------------------------------------------------- события

function bindEvents(state) {
    const container = state.container;

    container.addEventListener('click', async (event) => {
        const target = event.target;

        if (target.closest('[data-role="new-script"]') || target.closest('[data-role="empty-action"]')) {
            openCreateModal(state);
            return;
        }

        const saveBtn = target.closest('[data-role="meta-save"]');
        if (saveBtn) {
            await withBusy(saveBtn, () => saveMeta(state));
            return;
        }

        if (target.closest('[data-role="hide-nodes"]')) {
            hideOpened(state);
            await reloadScripts(state);
            return;
        }

        // Действия строки списка. Идентификатор читается с самой кнопки —
        // подниматься до строки не нужно, и «кнопка вернулась сама собой»
        // ничего не ломает.
        const rowBtn = target.closest('[data-action]');
        if (!rowBtn || !$(state, 'rows').contains(rowBtn)) return;
        const script = state.scripts.find((s) => s.id === Number(rowBtn.dataset.id));
        if (!script) return;

        if (rowBtn.dataset.action === 'open') {
            await openScript(state, script);
        } else if (rowBtn.dataset.action === 'activate') {
            await changeStatus(state, script, 'active');
        } else if (rowBtn.dataset.action === 'deactivate') {
            await changeStatus(state, script, 'draft');
        } else if (rowBtn.dataset.action === 'delete') {
            await removeScript(state, script);
        }
    });
}

/**
 * Кнопка на время запроса выключается: без этого двойной клик по «Сохранить»
 * шлёт два PUT подряд. Кнопкам окна это делает слой — там своя блокировка.
 */
async function withBusy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
        await fn();
    } finally {
        btn.disabled = false;
        btn.classList.remove('is-busy');
    }
}

// ---------------------------------------------------------------- действия

/**
 * Создаёт скрипт по названию из окна.
 *
 * Возвращает false, когда окно закрывать НЕЛЬЗЯ: пустое название и отказ
 * сервера. Это язык кнопок слоя — false оставляет окно открытым и разблокирует
 * кнопку, чтобы набранное не пропало вместе с окном.
 */
async function createScript(state, title) {
    if (!title) {
        state.ctx.toast('Укажите название скрипта', 'error');
        return false;
    }
    try {
        const created = await state.storage.createScript({ title });
        if (state.destroyed) return true;
        state.ctx.toast('Скрипт создан', 'success');
        await reloadScripts(state);
        if (state.destroyed) return true;
        await openScript(state, created);
        return true;
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
        return false;
    }
}

async function saveMeta(state) {
    const title = $(state, 'meta-title').value.trim();
    if (!title) {
        state.ctx.toast('Название не может быть пустым', 'error');
        return;
    }
    try {
        await state.storage.updateScript(state.selectedScript.id, { title, status: state.selectedScript.status });
        if (state.destroyed) return;
        state.ctx.toast('Название сохранено', 'success');
        await reloadScripts(state);
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}

async function changeStatus(state, script, status) {
    const message = status === 'active'
        ? CONFIRM_TEXTS.activate(script.title)
        : CONFIRM_TEXTS.deactivate();
    const ok = await state.ctx.confirm({
        // Окно то же и правило то же, что у удалений: заголовок спрашивает (К92).
        title: status === 'active' ? 'Активировать скрипт?' : 'Вернуть скрипт в черновик?',
        message,
        confirmLabel: status === 'active' ? 'Активировать' : 'В черновик'
    });
    if (!ok || state.destroyed) return;
    try {
        await state.storage.updateScript(script.id, { title: script.title, status });
        if (state.destroyed) return;
        state.ctx.toast(status === 'active' ? 'Скрипт активирован' : 'Скрипт переведён в черновик', 'success');
        await reloadScripts(state);
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}

// Удаление необратимо и уносит с собой наполнение — подтверждение на весь
// экран, а не в границах панели (правило слоя: ui-modal--screen для того, что
// нельзя отменить).
async function removeScript(state, script) {
    const ok = await state.ctx.confirmDanger({
        title: 'Удалить скрипт?',
        message: CONFIRM_TEXTS.remove(script.title)
    });
    if (!ok || state.destroyed) return;
    try {
        await state.storage.deleteScript(script.id);
        if (state.destroyed) return;
        state.ctx.toast('Скрипт удалён', 'success');
        if (state.selectedScript && state.selectedScript.id === script.id) hideOpened(state);
        await reloadScripts(state);
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}
