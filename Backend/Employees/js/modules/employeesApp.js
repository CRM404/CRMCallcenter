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

    // Колонкам сервер больше не нужен: настройки общие и лежат в
    // sessionStorage до появления входа (см. шапку employeesColumns.js), —
    // поэтому сюда идёт не общий набор зависимостей, а только то, чем модуль
    // пользуется.
    columns = createColumns(container, {
        toast: ctx.toast,
        // Настройки колонок меняют только вид таблицы — данные перезапрашивать
        // незачем, но перерисовать нужно.
        onApplied: () => table.draw()
    });

    table = createTable(container, {
        ...deps,
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
        // Перевыпуск ключа туннеля — необратимое действие: прежний ключ
        // перестаёт работать сразу, и оператор с ним теряет связь. Такое
        // подтверждение накрывает ВЕСЬ экран, а не свою панель (паспорт Р1Б).
        confirmDanger: ctx.confirmDanger,
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

    // Esc здесь больше не обрабатывается: все пять окон раздела собирает слой,
    // и Esc им даёт он же (К110, К111). Прежний общий слушатель ставил
    // hidden = true НАПРЯМУЮ, мимо close() карточки, где живёт проверка
    // изменений, — и карточка с набранной фамилией закрывалась молча (К112).

    try {
        // Один запрос, а не два: при пустом отборе список для таблицы и полный
        // список для выпадающих фильтров — это одно и то же.
        await table.reload();
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
