// --- employeesColumns.js: настройка видимых колонок таблицы сотрудников ---
//
// НАСТРОЙКИ ОБЩИЕ, А НЕ ПЕРСОНАЛЬНЫЕ. Решение владельца от 19.08.2026: пока в
// проекте нет входа, спрашивать пароль ради галочек в таблице — плата без
// покупки. Окно «Подтвердите личность» (выбор себя из списка + пароль) из
// сценария колонок убрано целиком вместе с разметкой и обработчиками
// (Н10 дизайн-сессии, К28 приёмки «Сотрудников»).
//
// ФОРМА ХРАНЕНИЯ НЕ СЛОМАНА — второе условие того же решения. Серверная
// сторона осталась ровно как была и НИЧЕГО из неё не удалено:
//   - таблица employee_column_settings (employee_id, hidden_columns);
//   - маршруты GET/PUT /api/employees/column-settings/:employeeId;
//   - методы storage.fetchColumnSettings / saveColumnSettings.
// Хранится тот же самый список — массив ключей СКРЫТЫХ колонок, — так что
// возврат к персональным настройкам, когда появится вход, это вернуть сюда
// employeeId и заменить два обращения к общему хранилищу вида двумя
// обращениями к storage. Ни схему, ни формат при этом трогать не придётся.
//
// ГДЕ ХРАНИТСЯ ДО ВХОДА. В общем хранилище настроек вида — /viewPrefs.js,
// localStorage. Раньше здесь был свой ключ в sessionStorage, и одно и то же
// окно помнило выбор по-разному в двух разделах: у «Сотрудников» — до закрытия
// вкладки, у «Лидов» — до закрытия панели (К53). Состав колонок это не
// состояние сеанса, а настройка: до К28 он жил на сервере и переживал всё.
//
// Переименован из columnSettings.js и переведён на фабрику: узлы искались через
// document на верхнем уровне модуля, то есть один раз при импорте. В оболочке
// модуль импортируется один раз, а монтируется много.

import { readHiddenColumns, writeHiddenColumns } from '/viewPrefs.js';

const SECTION = 'employees';

// Порядок и подписи — ровно те колонки, что есть в таблице.
// ID и «Действия» сюда не входят: это структурные элементы, показываются всегда.
export const CONFIGURABLE_COLUMNS = [
    { key: 'lastName', label: 'Фамилия' },
    { key: 'firstName', label: 'Имя' },
    { key: 'middleName', label: 'Отчество' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Телефон' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'telegram', label: 'Telegram' },
    { key: 'position', label: 'Должность' },
    { key: 'department', label: 'Отдел' },
    { key: 'managerName', label: 'Руководитель' },
    { key: 'hireDate', label: 'Дата найма' },
    { key: 'status', label: 'Статус' },
    { key: 'terminationDate', label: 'Дата увольнения' },
    { key: 'lineType', label: 'Тип линии' },
    { key: 'workSchedule', label: 'График работы' }
];

const KNOWN_KEYS = CONFIGURABLE_COLUMNS.map((c) => c.key);

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { toast, onApplied }
 */
export function createColumns(root, deps) {
    const { toast, onApplied } = deps;

    const $ = (sel) => root.querySelector(sel);
    const columnsModal = $('[data-role="columns-modal"]');
    const list = $('[data-role="columns-list"]');

    /** Set ключей СКРЫТЫХ колонок. Пусто — показываем всё. */
    function getHiddenColumns() {
        return new Set(readHiddenColumns(SECTION, KNOWN_KEYS));
    }

    // Окно открывается сразу по нажатию «Колонки» — ни запроса, ни ожидания
    // между нажатием и окном больше нет.
    function openColumnsModal() {
        const hidden = getHiddenColumns();
        list.innerHTML = '';
        CONFIGURABLE_COLUMNS.forEach((col) => {
            const label = document.createElement('label');
            label.className = 'column-checkbox-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.columnKey = col.key;
            checkbox.checked = !hidden.has(col.key);
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(col.label));
            list.appendChild(label);
        });
        columnsModal.hidden = false;
    }

    async function handleApply() {
        const hiddenColumns = Array.from(list.querySelectorAll('input[type="checkbox"]'))
            .filter((cb) => !cb.checked)
            .map((cb) => cb.dataset.columnKey);

        writeHiddenColumns(SECTION, hiddenColumns);
        columnsModal.hidden = true;
        if (onApplied) await onApplied();
        toast('Настройки колонок сохранены', 'success');
    }

    function init() {
        $('[data-role="columns-btn"]').addEventListener('click', openColumnsModal);

        $('[data-role="columns-reset"]').addEventListener('click', () => {
            list.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
        });
        $('[data-role="columns-apply"]').addEventListener('click', handleApply);
        $('[data-role="columns-cancel"]').addEventListener('click', () => { columnsModal.hidden = true; });
        $('[data-role="columns-close"]').addEventListener('click', () => { columnsModal.hidden = true; });
        columnsModal.addEventListener('click', (e) => { if (e.target === columnsModal) columnsModal.hidden = true; });
    }

    return { init, getHiddenColumns };
}
