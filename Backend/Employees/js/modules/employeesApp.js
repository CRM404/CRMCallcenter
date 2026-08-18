// --- employeesApp.js: раздел «Сотрудники» ---
//
// Два режима в одной панели: «Список» и «График». Список — таблица, фильтры,
// сортировка, пагинация, массовые действия и карточка сотрудника. График —
// сетка месяца, поповер дня и окно заполнения; его данные грузятся лениво, при
// первом переключении.
//
// КОНТРАКТ РАЗДЕЛА (тот же, что у «Реквизитов», «CPA-сетей» и «Лидов»):
//
//     export async function mount(container, ctx)
//     export function unmount()
//
// Переименован из app.js. Прежний файл ждал DOMContentLoaded и брал узлы через
// document — в оболочке это событие давно прошло, а узлов может быть два
// комплекта: раздел живёт в панели, панелей две.
//
// Модули раздела — фабрики на монтирование. Общее правило: состояние живёт в
// замыкании фабрики, а не в переменных уровня модуля, иначе второе открытие
// раздела показывает данные первого.

import { createStorage } from './employeesStorage.js';
import { createColumns } from './employeesColumns.js';
import { createTable } from './employeesTable.js';
import { createCard } from './employeesCard.js';
import { createDepartments } from './employeesDepartments.js';
import { createSchedule } from './employeesSchedule.js';
import { createScheduleDay } from './employeesScheduleDay.js';
import { createScheduleFill } from './employeesScheduleFill.js';
// Путь АБСОЛЮТНЫЙ: физическая структура папок не совпадает с адресами —
// Backend/Shell/ монтируется в корень «/».
import { isAbort } from '/api.js';

let root = null;
let shell = null;
let storage = null;

let columns = null;
let table = null;
let card = null;
let departments = null;
let schedule = null;
let scheduleDay = null;
let scheduleFill = null;

// Слушатель на документе — снимается при закрытии панели, иначе они копятся с
// каждым открытием раздела.
let onDocKeydown = null;

// Номер монтирования: панель закрывают и открывают заново, а ответ на запрос,
// ушедший до закрытия, приходит после.
let generation = 0;

function alive(mountId) {
    return root !== null && mountId === generation;
}

export async function mount(container, ctx) {
    const my = ++generation;
    root = container;
    shell = ctx;
    storage = createStorage(ctx.api);

    const isAlive = () => alive(my);
    const deps = { storage, toast: ctx.toast, isAlive, isAbort };

    columns = createColumns(container, {
        ...deps,
        // Настройки колонок меняют только вид таблицы — данные перезапрашивать
        // незачем, но перерисовать нужно.
        onApplied: () => table.render()
    });

    table = createTable(container, {
        ...deps,
        confirmDanger: ctx.confirmDanger,
        getHiddenColumns: () => columns.getHiddenColumns(),
        onEdit: (id) => card.openById(id),
        // Список изменился — если график уже загружен, его строки показывают
        // время смены и «Дни» из тех же карточек, и оставить их устаревшими
        // значит показывать неправду до перезагрузки.
        onDataChanged: async () => {
            const state = schedule.getState();
            if (state.loaded && state.month) await schedule.loadMonth(state.month);
        }
    });

    card = createCard(container, {
        ...deps,
        confirm: ctx.confirm,
        onSaved: () => table.refresh()
    });

    departments = createDepartments(container, {
        ...deps,
        confirmDanger: ctx.confirmDanger,
        // Отдел мог быть переименован или удалён — списки фильтров и колонка
        // «Отдел» в таблице обязаны это показать.
        onChanged: () => table.refresh()
    });

    schedule = createSchedule(container, deps);
    scheduleDay = createScheduleDay(container, { ...deps, schedule });
    scheduleFill = createScheduleFill(container, { ...deps, schedule });

    columns.init();
    table.init();
    card.init();
    departments.init();
    schedule.init();
    scheduleDay.init();
    scheduleFill.init();

    // Esc закрывает верхнее открытое окно раздела. Окна раздела разметочные
    // (сложные формы, а не подтверждения), поэтому Esc им даётся вручную;
    // окна слоя и поповер дня обрабатывают его сами.
    onDocKeydown = (e) => {
        if (e.key !== 'Escape' || !root) return;
        if (document.querySelector('.ui-modal--screen')) return;   // окно подтверждения из слоя
        if (scheduleDay.isOpen()) return;                          // поповер закрывает себя сам
        const open = Array.from(root.querySelectorAll('.emp-modal')).filter((m) => !m.hidden);
        if (open.length === 0) return;
        open[open.length - 1].hidden = true;
    };
    document.addEventListener('keydown', onDocKeydown);

    try {
        await table.reloadAllForFilters();
        if (!isAlive()) return;
        await table.render();
    } catch (err) {
        if (!isAlive() || isAbort(err)) return;
        shell.toast(err.message, 'error');
    }
}

export function unmount() {
    generation += 1;   // всё, что было в полёте, теперь чужое

    // Отложенный поиск, слушатели документа и окна — снимаются здесь.
    if (table) table.destroy();
    if (scheduleDay) scheduleDay.destroy();
    if (scheduleFill) scheduleFill.destroy();
    if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown);

    onDocKeydown = null;
    root = null;
    shell = null;
    storage = null;
    columns = null;
    table = null;
    card = null;
    departments = null;
    schedule = null;
    scheduleDay = null;
    scheduleFill = null;
}
