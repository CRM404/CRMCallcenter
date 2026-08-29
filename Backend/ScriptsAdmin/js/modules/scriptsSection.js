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
// Окно отказа — общее на пять разделов (ответ на И118).
import { openDeleteBlocked, isDeleteBlocked } from '/deleteBlocked.js';
import { createStorage } from './scriptsAdminStorage.js';
import { renderScriptRows, CONFIRM_TEXTS, escapeHtml } from './scriptsAdminScriptList.js';
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
        // Вкладка «Статусы воронки» (решение владельца 87). Справочник
        // грузится ОДИН РАЗ и по первому открытию вкладки: полсотни строк
        // не меняются, а разделу они не нужны, пока на них не посмотрят.
        tab: 'scripts',
        funnelStatuses: null,
        destroyed: false
    };
    instances.push(state);

    bindEvents(state);
    await reloadScripts(state);
    // Справочник статусов грузится сразу, но НЕ рисуется: счётчик на вкладке
    // обязан показывать полную полусотню с первого взгляда. Прочерк в счётчике
    // означает «неизвестно», а размер справочника известен всегда — он и
    // закреплён схемой. Отрисовка при этом остаётся ленивой: рисовать
    // полсотни строк тому, кто на них не смотрит, незачем.
    await loadFunnelStatuses(state);
}

// Состояние наполнения: что сейчас открыто на правку. rootCreating — редактор
// пустого основного текста, развёрнутый кнопкой пустого состояния: до нажатия
// его нет, иначе пустой блок с открытым полем читается как сломанное поле.
function emptyNodesUi() {
    return {
        rootEditing: false, rootCreating: false,
        // Фраза для перевода правится одним состоянием на оба случая:
        // «ещё нет» и «уже есть» отличаются только тем, что уйдёт на сервер
        // — создание или правка.
        transferEditing: false,
        addingObjection: false, editingObjectionId: null
    };
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
    $(state, 'tab-scripts-count').textContent = state.scripts.length;
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

        onEditTransferStart: () => { state.nodesUi.transferEditing = true; renderNodes(state); },
        onCancelTransferEdit: () => { state.nodesUi.transferEditing = false; renderNodes(state); },

        /**
         * Сохранение фразы для перевода.
         *
         * ПУСТОЙ ТЕКСТ — ЭТО СНЯТЬ ФРАЗУ, А НЕ ОШИБКА. Поле необязательное
         * (решение 86), и человек, стерший текст и нажавший «Сохранить», хочет
         * именно этого. Отказ «укажите текст» на необязательном поле оставил
         * бы его без способа передумать: другого пути снять фразу на экране
         * нет вовсе.
         */
        onSaveTransfer: async (transfer, content) => {
            const empty = !content || !content.trim();
            try {
                if (empty && transfer) {
                    await state.storage.deleteScriptNode(transfer.id);
                    if (state.destroyed) return;
                    state.ctx.toast('Фраза для перевода снята', 'success');
                } else if (!empty && transfer) {
                    await state.storage.updateScriptNode(transfer.id, {
                        parentId: transfer.parentId, nodeType: 'transfer', label: null,
                        content, sortOrder: transfer.sortOrder
                    });
                    if (state.destroyed) return;
                    state.ctx.toast('Фраза для перевода сохранена', 'success');
                } else if (!empty) {
                    // Фраза висит на корне, как и возражения: корневым узлом
                    // может быть только один, и второй сервер не примет.
                    const root = state.nodes.find((n) => n.parentId === null);
                    await state.storage.createScriptNode(state.selectedScript.id, {
                        parentId: root ? root.id : null, nodeType: 'transfer', label: null,
                        content, sortOrder: 0
                    });
                    if (state.destroyed) return;
                    state.ctx.toast('Фраза для перевода добавлена', 'success');
                }
                state.nodesUi.transferEditing = false;
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

// ---------------------------------------------------------- вкладка статусов

// Слова признаков взяты не по смыслу названия колонки, а по тому, что колонка
// ДЕЛАЕТ (services/leadCallRules.js): releases_lead отцепляет оператора и
// отпускает лида, requires_call_time ставит время, названное клиентом. Имена
// колонок человеку, который пишет скрипты, не говорят ничего.
//
// ⚠ ПРИЗНАКОВ ДВА, А НЕ ТРИ (К220, паспорт Р11 редакции 5). Пилюля «перезвон
// через час» снята вместе с тем, что её делало правдой: `auto_recall`
// заморожена заходом 2, список статусов для обзвона задаёт событие
// «Автоперезвон». Снята ИМЕННО ЭТИМ коммитом, не раньше и не позже: раньше
// незачем, позже опасно — в тот момент, когда вкладку можно править, старая
// пилюля начала бы показывать не то.
const STATUS_PROPS = [
    { key: 'releasesLead', label: 'разговора не было' },
    { key: 'requiresCallTime', label: 'спросит время перезвона' }
];

// ⚠ ДВА ПРИЗНАКА ЗАХОДА 6 — ТОЛЬКО ПИЛЮЛЯМИ, И ОТДЕЛЬНЫМ ПЕРЕЧНЕМ. Положи я их
// в STATUS_PROPS, они приехали бы и в окно статуса галочками — а решение
// владельца 106 говорит: «руководитель признак „системный" не переключает».
// Показать и дать править — разные вещи, и разводит их именно этот второй
// список, а не проверка внутри окна.
//
// СЛОВА ПРО ПОВЕДЕНИЕ, как у двух прежних. «Системный» — свойство, а не
// последствие, поэтому «ставит система» (паспорт Р11 редакции 7).
const SYSTEM_PILLS = [
    { key: 'isSystem', label: 'ставит система' },
    { key: 'awaitsManager', label: 'ждёт решения руководителя' }
];

// Последствие каждой галочки — словами, а не именем колонки. Условие паспорта
// Р11: галочка без написанного последствия — это предложение угадать.
const PROP_HINTS = {
    releasesLead: 'Лид отцепляется от оператора и уходит из его персональной очереди: '
        + 'разговор считается несостоявшимся.',
    requiresCallTime: 'Оператор называет время, о котором договорился с клиентом. '
        + 'Счётчик недозвонов при этом не растёт: он про недозвоны, а не про договорённости.'
};

// Пометка «окончательный / промежуточный» — три состояния, и первым стоит то,
// чем поле заводится.
const MARK_OPTIONS = [
    { value: '', label: '— не размечен —' },
    { value: 'окончательный', label: 'окончательный' },
    { value: 'промежуточный', label: 'промежуточный' }
];

function statusesWord(count) {
    const tail = count % 100;
    if (tail >= 11 && tail <= 14) return 'статусов';
    switch (count % 10) {
        case 1: return 'статус';
        case 2:
        case 3:
        case 4: return 'статуса';
        default: return 'статусов';
    }
}

async function loadFunnelStatuses(state) {
    if (state.funnelStatuses !== null) return;
    try {
        // ДВА ЗАПРОСА ПАРАЛЛЕЛЬНО, А НЕ ДРУГ ЗА ДРУГОМ: они независимы, и
        // последовательная пара удвоила бы ожидание на ровном месте.
        //
        // ⚠ ОПИСАНИЕ ЭТАПОВ — НЕ ПОВОД НЕ ПОКАЗАТЬ СПИСОК. Упади запрос этапов —
        // вкладка обязана открыться и работать: правится описание у одного этапа
        // из восьми, а читают здесь пятьдесят одну строку справочника.
        const [list, stages] = await Promise.all([
            state.storage.fetchFunnelStatuses(),
            state.storage.fetchFunnelStages().catch((err) => {
                if (!isAbort(err)) console.warn('[статусы] Этапы не прочитаны:', err.message);
                return [];
            })
        ]);
        if (state.destroyed) return;
        state.funnelStatuses = list;
        state.funnelStages = stages;
        $(state, 'tab-statuses-count').textContent = list.length;
    } catch (err) {
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}

function renderStatuses(state) {
    const box = $(state, 'statuses-stages');
    const list = state.funnelStatuses || [];
    $(state, 'tab-statuses-count').textContent = list.length;

    // Этапы собираются из самих данных, а не из зашитого перечня: разбивка
    // живёт в схеме, и второй список этапов здесь разошёлся бы с ней молча.
    const stages = [];
    list.forEach((s) => {
        let stage = stages.find((x) => x.number === s.stageNumber);
        if (!stage) { stage = { number: s.stageNumber, name: s.stageName, items: [] }; stages.push(stage); }
        stage.items.push(s);
    });

    // Описание и право правки приезжают со своего маршрута и прикладываются к
    // уже собранным этапам. Не приехали вовсе — коробки рисуются как прежде:
    // описания нет, карандаша нет, поле заведения на месте.
    (state.funnelStages || []).forEach((info) => {
        const stage = stages.find((x) => x.number === info.stageNumber);
        if (!stage) return;
        stage.description = info.description;
        stage.editable = info.editable;
        stage.isSystem = info.isSystem;
    });

    // ПЛАШКА СЧИТАЕТ НЕРАЗМЕЧЕННЫЕ. Пока они есть — она про разметку; кончились
    // — остаётся одна фраза про то, что список правится. Отдельного места для
    // этого числа не нужно: чипов-счётчиков на вкладке нет по решению редакции 3.
    const unmarked = list.filter((s) => !s.mark).length;
    const tail = `Список правится: статус можно завести в его этапе, переименовать и удалить `
        + `— этапы при этом закреплены, их ${stages.length}.`;
    $(state, 'statuses-note').textContent = unmarked
        ? `Разметьте статусы: пока у статуса не сказано, окончательный он или промежуточный, `
          + `система не знает, уходить ли лиду в архив после автоперезвона. `
          + `Не размечено ${unmarked} из ${list.length}. ${tail}`
        : tail;

    box.innerHTML = stages.map((stage) => {
        const rows = stage.items.map((item) => {
            // Свойство стоит СРАЗУ ЗА ИМЕНЕМ, а не отдельной колонкой: пилюля
            // есть у семерых из пятидесяти одного (замер 29.08.2026 на чистой
            // базе схемой `47a8db5`), и колонка пустовала бы в сорока четырёх
            // строках из пятидесяти одной. Считать надо по обоим перечням
            // сразу — STATUS_PROPS и SYSTEM_PILLS, — иначе число выйдет меньше.
            const pills = STATUS_PROPS.concat(SYSTEM_PILLS)
                .filter((prop) => item[prop.key])
                .map((prop) => `<span class="ui-pill ui-pill--mute">${prop.label}</span>`)
                .join('');
            // ПОМЕТКА — СПИСКОМ, А НЕ ПИЛЮЛЕЙ. Три остальных свойства ставит код,
            // их показывает пилюля; пометку ставит человек, значит на её месте
            // стоит орган управления. Значение и орган рядом — это одно и то же,
            // сказанное дважды.
            const options = MARK_OPTIONS.map((opt) => `<option value="${escapeHtml(opt.value)}"`
                + `${(item.mark || '') === opt.value ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`).join('');
            return `
                <div class="scr-status">
                    <span class="scr-status__name">${escapeHtml(item.statusName)}${pills}</span>
                    <select class="ui-field__control ui-field__control--sm scr-status__mark"
                            data-action="status-mark" data-id="${item.id}"
                            aria-label="Пометка статуса">${options}</select>
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--ghost"
                            data-action="status-edit" data-id="${item.id}"
                            aria-label="Настроить статус «${escapeHtml(item.statusName)}»">
                        <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg>
                    </button>
                </div>
            `;
        }).join('');
        // Строка заведения — ячейка той же сетки, последняя после статусов
        // этапа: этап тогда не надо выбирать, человек добавляет туда, куда
        // смотрит. Тот же приём, что в «Настройке списков».
        const add = `
            <div class="ui-field scr-add">
                <div class="ui-field__row">
                    <input type="text" class="ui-field__control" data-role="status-new-${stage.number}"
                           placeholder="Новый статус этапа…"
                           aria-label="Новый статус этапа ${stage.number} · ${escapeHtml(stage.name)}">
                    <button type="button" class="ui-btn ui-btn--secondary"
                            data-action="status-add" data-stage="${stage.number}">Добавить</button>
                </div>
                <div class="ui-field__error" data-role="status-add-error-${stage.number}" hidden></div>
            </div>
        `;
        // ⚠ СТРОКА СЛОВАМИ, А НЕ ПУСТОЕ МЕСТО. Поле заведения стоит в семи
        // коробках из восьми; его молчаливое отсутствие в восьмой читается как
        // поломка или как «мне не дали прав». То же правило, по которому в Р12
        // каждая неработающая строка называет свою причину.
        const systemNote = `
            <p class="scr-card__text">Статусы этого этапа заводит система: вручную сюда не добавляют.</p>
        `;
        // Описание — МЕЖДУ шапкой и списком: оно объясняет, что делают статусы
        // ниже. Под списком оно объясняло бы прочитанное задним числом.
        const text = stage.description
            ? `<p class="scr-card__text">${escapeHtml(stage.description)}</p>`
            : '';
        // Карандаш — только там, где сервер правку РАЗРЕШАЕТ. Кнопка, которая
        // всегда отказывает, хуже отсутствующей.
        const pencil = stage.editable
            ? `<button type="button" class="ui-btn ui-btn--icon ui-btn--ghost"
                       data-action="stage-edit" data-stage="${stage.number}"
                       aria-label="Описание этапа ${stage.number} · ${escapeHtml(stage.name)}">
                   <svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-edit"></use></svg>
               </button>`
            : '';
        return `
            <div class="scr-card">
                <div class="scr-card__head">
                    <h3 class="scr-card__title">${stage.number} · ${escapeHtml(stage.name)}</h3>
                    <span class="scr-card__sub">${stage.items.length} ${statusesWord(stage.items.length)}</span>
                    ${pencil}
                </div>
                ${text}
                <div class="scr-statuses">${rows}</div>
                ${stage.isSystem ? systemNote : add}
            </div>
        `;
    }).join('');
}

// Перечитать справочник и перерисовать вкладку. Список держится в состоянии
// раздела и раздаётся ещё и карточке лида — освежать его надо целиком, а не
// правкой одной строки на месте: иначе после отказа сервера экран показывал бы
// значение, которого в базе нет.
async function reloadStatuses(state) {
    state.funnelStatuses = null;
    // Этапы обнуляются вместе со статусами: описание правится в том же окне,
    // и оставь я старое значение — экран показал бы прежний текст после
    // успешного сохранения.
    state.funnelStages = null;
    await loadFunnelStatuses(state);
    if (state.destroyed || state.funnelStatuses === null) return;
    renderStatuses(state);
}

/**
 * Пометка сохраняется СРАЗУ ПО ВЫБОРУ, кнопки «Сохранить» у вкладки нет:
 * вкладка не форма, а справочник с одним правимым полем.
 *
 * Тоста на успех нет намеренно: разметка пятидесяти статусов подряд дала бы
 * пятьдесят тостов — это шум, а не подтверждение, и повторял бы он то, что и
 * так на виду. Ошибка при этом обязана быть громкой: молча вернувшееся значение
 * читается как «не нажалось», поэтому отказ возвращает список к прежнему
 * значению И говорит причину тостом.
 */
async function setStatusMark(state, select) {
    const id = Number(select.dataset.id);
    const status = (state.funnelStatuses || []).find((s) => s.id === id);
    const previous = status ? (status.mark || '') : '';
    const value = select.value;
    try {
        await state.storage.setFunnelStatusMark(id, value === '' ? null : value);
        if (state.destroyed) return;
        if (status) status.mark = value === '' ? null : value;
        renderStatuses(state);
    } catch (err) {
        if (state.destroyed) return;
        select.value = previous;
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}

/**
 * Завести статус полем в коробке своего этапа.
 *
 * ОШИБКА ПОД СВОИМ ПОЛЕМ, А НЕ ТОСТОМ: «такой статус уже есть» относится к
 * набранному имени, и читать его надо там, где это имя стоит.
 */
async function addStatus(state, button) {
    const stageNumber = Number(button.dataset.stage);
    const input = $(state, `status-new-${stageNumber}`);
    const error = $(state, `status-add-error-${stageNumber}`);
    const name = input.value.trim();
    error.hidden = true;
    input.closest('.ui-field').classList.remove('ui-field--error');
    if (!name) {
        error.textContent = 'Укажите название';
        error.hidden = false;
        input.closest('.ui-field').classList.add('ui-field--error');
        input.focus();
        return;
    }
    try {
        await state.storage.createFunnelStatus({ stageNumber, statusName: name });
        if (state.destroyed) return;
        await reloadStatuses(state);
        if (state.destroyed) return;
        // Курсор возвращается в поле того же этапа: статусы заводят пачками.
        const again = $(state, `status-new-${stageNumber}`);
        if (again) again.focus();
    } catch (err) {
        if (state.destroyed || isAbort(err)) return;
        error.textContent = err.message;
        error.hidden = false;
        input.closest('.ui-field').classList.add('ui-field--error');
        input.focus();
    }
}

/**
 * Окно статуса: имя и два признака. Пометки здесь нет — её ставят пятьдесят раз
 * подряд в самом списке, и окно ради одного значения было бы полсотни лишних
 * движений.
 *
 * ЭТАП — ПОДПИСЬ, А НЕ ПОЛЕ: перенести статус между этапами экран не даёт.
 */
/**
 * Окно «Описание этапа» — правит один абзац у одного этапа из восьми.
 *
 * ПОЧЕМУ ОКНО, А НЕ ПОЛЕ, ОТКРЫТОЕ ВСЕГДА. На эту вкладку приходят ЧИТАТЬ:
 * пятьдесят одна строка справочника против одного правимого абзаца. Открытое
 * поле превратило бы справочник в форму и подставило бы описание под случайную
 * правку. Раздел уже правит сущности окном и уже держит кнопку в шапке коробки —
 * третьего приёма заводить незачем (паспорт Р11 редакции 7).
 *
 * ПОЧЕМУ КНОПКОЙ «Сохранить», А НЕ СРАЗУ. Пометка статуса сохраняется без
 * кнопки, и это верно: там выбор из трёх значений. Текст в две-три фразы так
 * сохранять нельзя — «сразу» у текста означает «на каждую букву» или «молча по
 * уходу из поля».
 */
function openStageModal(state, stage) {
    const body = document.createElement('div');
    body.className = 'ui-form-grid ui-form-grid--single';
    body.innerHTML = `
        <div class="ui-field" data-role="text-field">
            <label class="ui-field__label" for="scrStageText">Описание</label>
            <textarea class="ui-field__control" id="scrStageText"
                      rows="4">${escapeHtml(stage.description || '')}</textarea>
            <div class="ui-field__error" data-role="text-error" hidden></div>
            <div class="ui-field__hint">Кратко: что делает системный статус и в каком случае
                проставляется.</div>
        </div>
    `;
    const input = body.querySelector('#scrStageText');
    const field = body.querySelector('[data-role="text-field"]');
    const error = body.querySelector('[data-role="text-error"]');

    const showError = (text) => {
        error.textContent = text;
        error.hidden = false;
        field.classList.add('ui-field--error');
        input.focus();
        return false;
    };

    async function submit() {
        const text = input.value.trim();
        error.hidden = true;
        field.classList.remove('ui-field--error');
        // ПУСТОТУ ОТБИВАЕТ И СЕРВЕР — его отказ тоже проверен. Здесь она
        // отбивается раньше только чтобы не гонять запрос ради заведомого «нет»;
        // сам запрет живёт в маршруте, а не в этой строке.
        if (!text) return showError('Опишите этап: без описания непонятно, что делают его статусы');
        try {
            await state.storage.updateStageDescription(stage.stageNumber, text);
            if (state.destroyed) return true;
            await reloadStatuses(state);
            return true;
        } catch (err) {
            if (state.destroyed || isAbort(err)) return true;
            return showError(err.message);
        }
    }

    const modal = openModal({
        title: 'Описание этапа',
        sub: `${stage.stageNumber} · ${stage.stageName || ''}`.trim(),
        body,
        scope: state.panel,
        size: 'narrow',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: false },
            { label: 'Сохранить', onClick: submit }
        ]
    });
    input.focus();
    return modal;
}

function openStatusModal(state, status, stage) {
    const isNew = !status;
    const body = document.createElement('div');
    body.className = 'ui-form-grid ui-form-grid--single';
    body.innerHTML = `
        <div class="ui-field" data-role="name-field">
            <label class="ui-field__label" for="scrStatusName">Название</label>
            <input type="text" class="ui-field__control" id="scrStatusName"
                   value="${escapeHtml(isNew ? '' : status.statusName)}">
            <div class="ui-field__error" data-role="name-error" hidden></div>
            ${isNew ? '<div class="ui-field__hint">Статус встанет последним в этом этапе.'
                + ' Перенести его в другой этап нельзя: этапы — структура воронки.</div>' : ''}
        </div>
        ${STATUS_PROPS.map((prop) => `
            <div class="ui-field">
                <label class="ui-choice${!isNew && status[prop.key] ? ' ui-choice--on' : ''}">
                    <input type="checkbox" data-prop="${prop.key}"${!isNew && status[prop.key] ? ' checked' : ''}>${prop.label}
                </label>
                <div class="ui-field__hint">${PROP_HINTS[prop.key]}</div>
            </div>
        `).join('')}
        ${isNew ? `
            <div class="ui-note">
                <svg class="ui-ic ui-ic--sm ui-note__icon" aria-hidden="true"><use href="#ui-ic-info"></use></svg>
                <div class="ui-note__body">
                    <div class="ui-note__text">Статус заводится неразмеченным: пока не разметите его
                    окончательным или промежуточным, целевым в автоперезвоне выбрать его будет нельзя.
                    Разметка — в самом списке, одним движением на строку.</div>
                </div>
            </div>` : ''}
        ${!isNew && status.isSystem ? `
            <div class="ui-note">
                <svg class="ui-ic ui-ic--sm ui-note__icon" aria-hidden="true"><use href="#ui-ic-info"></use></svg>
                <div class="ui-note__body">
                    <div class="ui-note__text">Этот статус ставит система. Переименовать его можно —
                    код ищет статус по записи, а не по названию; но под новым именем его увидят все.</div>
                </div>
            </div>` : ''}
    `;

    const input = body.querySelector('#scrStatusName');
    const nameField = body.querySelector('[data-role="name-field"]');
    const nameError = body.querySelector('[data-role="name-error"]');
    const propValue = (key) => body.querySelector(`[data-prop="${key}"]`).checked;

    // Чип подсвечивается вместе с галочкой — состояние живёт на чипе, как в
    // «CPA-сетях».
    body.querySelectorAll('.ui-choice input').forEach((box) => {
        box.addEventListener('change', () => {
            box.closest('.ui-choice').classList.toggle('ui-choice--on', box.checked);
        });
    });

    const showError = (text) => {
        nameError.textContent = text;
        nameError.hidden = false;
        nameField.classList.add('ui-field--error');
        input.focus();
        return false;
    };

    async function submit() {
        const name = input.value.trim();
        nameError.hidden = true;
        nameField.classList.remove('ui-field--error');
        if (!name) return showError('Укажите название');
        const payload = {
            statusName: name,
            requiresCallTime: propValue('requiresCallTime'),
            releasesLead: propValue('releasesLead')
        };
        try {
            if (isNew) await state.storage.createFunnelStatus({ stageNumber: stage.number, ...payload });
            else await state.storage.updateFunnelStatus(status.id, payload);
            if (state.destroyed) return true;
            await reloadStatuses(state);
            return true;
        } catch (err) {
            if (state.destroyed || isAbort(err)) return true;
            return showError(err.message);
        }
    }

    const actions = [];
    if (!isNew) {
        actions.push({
            label: 'Удалить статус',
            variant: 'danger',
            side: 'start',
            icon: 'trash',
            onClick: async () => {
                const removed = await removeStatus(state, status, stage);
                return removed ? undefined : false;
            }
        });
    }
    actions.push({ label: 'Отмена', variant: 'ghost', value: false });
    actions.push({ label: isNew ? 'Завести' : 'Сохранить', onClick: submit });

    const modal = openModal({
        title: isNew ? 'Новый статус' : 'Статус воронки',
        sub: `Этап ${stage.number} · ${stage.name}`,
        body,
        scope: state.panel,
        size: 'narrow',
        spread: !isNew,
        actions
    });
    input.focus();
    return modal;
}

/**
 * Удаление статуса. Помех у него четыре, и считает их сервер: экран не решает,
 * можно ли удалять, и не считает сам.
 *
 * Возвращает true, если статус удалён, — окно статуса по этому признаку решает,
 * закрываться ему или остаться.
 */
async function removeStatus(state, status, stage) {
    const ok = await state.ctx.confirmDanger({
        title: `Удалить статус «${status.statusName}»?`,
        message: `Статус исчезнет из справочника этапа «${stage.number} · ${stage.name}». `
            + 'Записи о прошлых разговорах не изменятся: у звонка имя статуса хранится снимком '
            + 'рядом с идентификатором.'
    });
    if (!ok || state.destroyed) return false;
    try {
        await state.storage.deleteFunnelStatus(status.id);
        if (state.destroyed) return true;
        state.ctx.toast('Статус удалён', 'success');
        await reloadStatuses(state);
        return true;
    } catch (err) {
        if (state.destroyed) return false;
        if (isDeleteBlocked(err)) {
            openDeleteBlocked({
                scope: state.panel,
                sub: `Статус «${status.statusName}»`,
                lead: 'Статус держат:',
                // К244. ЧЕТВЁРТОЕ МЕСТО НАЗВАНО ОТДЕЛЬНО, И ЭТО НЕ ПОЛНОТА РАДИ
                // ПОЛНОТЫ. Целевой статус пост-обработки — единственная помеха,
                // которую нельзя убрать НИ С ОДНОГО экрана: поле задаётся
                // выкаткой. Не сказав этого, мы отправляли человека искать
                // место, которого нет, — и он искал бы его дольше всего.
                tail: 'Лидов переводят на другой статус в разделе «Лиды», наборы правят в карточке лида, '
                    + 'автоперезвон — на вкладке «События». Целевой статус пост-обработки с экрана не '
                    + 'меняется: он задаётся выкаткой. Пока цела хотя бы одна помеха, статус остаётся на месте.',
                blockers: err.blockers
            });
            return false;
        }
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
        return false;
    }
}

// Кнопка «Новый скрипт» и три чипа уходят вместе со списком: кнопка заводит
// скрипт, чипы считают скрипты, а на вкладке статусов нет ни того, ни другого.
// Кнопка, которая ничего не сделает, и число не про то, что на экране, читаются
// как поломка.
async function switchTab(state, tab) {
    state.tab = tab;
    const onScripts = tab === 'scripts';
    $(state, 'tab-scripts').classList.toggle('ui-tabs__tab--active', onScripts);
    $(state, 'tab-statuses').classList.toggle('ui-tabs__tab--active', !onScripts);
    $(state, 'tab-scripts').setAttribute('aria-selected', String(onScripts));
    $(state, 'tab-statuses').setAttribute('aria-selected', String(!onScripts));
    $(state, 'list-wrap').hidden = !onScripts;
    $(state, 'statuses-wrap').hidden = onScripts;
    state.container.querySelector('.ui-page-chips').hidden = !onScripts;
    state.container.querySelector('[data-role="new-script"]').hidden = !onScripts;
    // Открытый скрипт прячется вместе со списком, но НЕ закрывается: вернувшись
    // на первую вкладку, человек застаёт его там же, где оставил.
    $(state, 'opened').hidden = !onScripts || !state.selectedScript;

    if (!onScripts) {
        await loadFunnelStatuses(state);
        if (state.destroyed || state.funnelStatuses === null) return;
        renderStatuses(state);
    }
}

function bindEvents(state) {
    const container = state.container;

    container.addEventListener('click', async (event) => {
        const target = event.target;

        const tabScripts = target.closest('[data-role="tab-scripts"]');
        const tabStatuses = target.closest('[data-role="tab-statuses"]');
        if (tabScripts || tabStatuses) {
            await switchTab(state, tabScripts ? 'scripts' : 'statuses');
            return;
        }

        if (target.closest('[data-role="new-script"]') || target.closest('[data-role="empty-action"]')) {
            openCreateModal(state);
            return;
        }

        // Вкладка «Статусы воронки». Действия читаются с самой кнопки, как и в
        // списке скриптов: подниматься до строки не нужно.
        const statusAdd = target.closest('[data-action="status-add"]');
        if (statusAdd) {
            await withBusy(statusAdd, () => addStatus(state, statusAdd));
            return;
        }
        const stageEdit = target.closest('[data-action="stage-edit"]');
        if (stageEdit) {
            const number = Number(stageEdit.dataset.stage);
            const info = (state.funnelStages || []).find((s) => s.stageNumber === number);
            const named = (state.funnelStatuses || []).find((s) => s.stageNumber === number);
            if (info) openStageModal(state, { ...info, stageName: info.stageName || (named && named.stageName) });
            return;
        }
        const statusEdit = target.closest('[data-action="status-edit"]');
        if (statusEdit) {
            const id = Number(statusEdit.dataset.id);
            const status = (state.funnelStatuses || []).find((s) => s.id === id);
            if (status) {
                openStatusModal(state, status,
                    { number: status.stageNumber, name: status.stageName });
            }
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

    // Пометка сохраняется по выбору, а не по кнопке: своё событие, и оно
    // делегировано так же, как щелчки, — строки перерисовываются целиком.
    container.addEventListener('change', async (event) => {
        const mark = event.target.closest('[data-action="status-mark"]');
        if (mark) await setStatusMark(state, mark);
    });

    // Enter в поле заведения — как в любой однопольной форме: искать кнопку
    // мышью ради каждого статуса человек не должен.
    container.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const field = event.target.closest('[data-role^="status-new-"]');
        if (!field) return;
        event.preventDefault();
        const button = field.closest('.ui-field__row').querySelector('[data-action="status-add"]');
        if (button && !button.disabled) button.click();
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
        // Раньше скрипт удалялся всегда, а привязка у лидов обнулялась молча —
        // и по какому скрипту с лидом говорили, узнать становилось неоткуда.
        if (isDeleteBlocked(err)) {
            openDeleteBlocked({
                scope: state.panel,
                sub: `Скрипт «${script.title}»`,
                lead: 'К скрипту привязано то, что удалением потерялось бы навсегда:',
                tail: 'Смените скрипт у этих лидов — тогда скрипт удалится.',
                blockers: err.blockers
            });
            return;
        }
        if (!isAbort(err)) state.ctx.toast(err.message, 'error');
    }
}
