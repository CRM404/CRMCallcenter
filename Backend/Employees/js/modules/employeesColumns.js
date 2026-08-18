// --- employeesColumns.js: идентификация сотрудника + персональные настройки
// видимых колонок ---
//
// Настройки свои у каждого сотрудника и хранятся на сервере, поэтому перед
// открытием окна человек подтверждает, кто он: выбирает себя и вводит пароль.
// Опознанная личность живёт в sessionStorage — переживает F5, умирает вместе с
// вкладкой (правило проекта: в sessionStorage состояние ИНТЕРФЕЙСА, не данные).
//
// Переименован из columnSettings.js и переведён на фабрику: узлы искались через
// document на верхнем уровне модуля, то есть один раз при импорте. В оболочке
// модуль импортируется один раз, а монтируется много.

const SESSION_KEY = 'crm_identifiedEmployeeId';

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

export function getIdentifiedEmployeeId() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? Number(raw) : null;
}

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, isAlive, isAbort, onApplied }
 */
export function createColumns(root, deps) {
    const { storage, toast, isAlive, isAbort, onApplied } = deps;

    const $ = (sel) => root.querySelector(sel);
    const identityModal = $('[data-role="identity-modal"]');
    const columnsModal = $('[data-role="columns-modal"]');
    const list = $('[data-role="columns-list"]');

    // Кэш скрытых колонок для уже опознанного в этой вкладке сотрудника — чтобы
    // не дёргать сервер на каждую перерисовку таблицы. Сбрасывается при новой
    // идентификации и после «Применить».
    let cachedHiddenColumns = null;

    /**
     * Set ключей СКРЫТЫХ колонок для опознанной личности. Личность не
     * подтверждена — пустой набор: показываем всё, как и раньше.
     */
    async function getHiddenColumns() {
        const employeeId = getIdentifiedEmployeeId();
        if (!employeeId) return new Set();
        if (cachedHiddenColumns) return cachedHiddenColumns;
        try {
            const { hiddenColumns } = await storage.fetchColumnSettings(employeeId);
            if (!isAlive()) return new Set();
            cachedHiddenColumns = new Set(hiddenColumns);
        } catch (err) {
            // Настройки — не то, ради чего стоит ломать открытие раздела:
            // не удалось прочитать, значит показываем все колонки.
            cachedHiddenColumns = new Set();
        }
        return cachedHiddenColumns;
    }

    async function openIdentityModal() {
        $('[data-role="identity-form"]').reset();
        const select = $('#empIdentityEmployee');
        select.innerHTML = '<option value="">Выберите себя…</option>';
        let employees;
        try {
            employees = await storage.fetchEmployees();
            if (!isAlive()) return;
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }
        employees
            .slice()
            .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'ru'))
            .forEach((emp) => {
                const opt = document.createElement('option');
                opt.value = String(emp.id);
                opt.textContent = `${emp.lastName} ${emp.firstName}`;
                select.appendChild(opt);
            });
        identityModal.hidden = false;
    }

    async function openColumnsModal(employeeId) {
        let hidden;
        try {
            const { hiddenColumns } = await storage.fetchColumnSettings(employeeId);
            if (!isAlive()) return;
            hidden = new Set(hiddenColumns);
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }

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

    async function handleGearClick() {
        const employeeId = getIdentifiedEmployeeId();
        if (employeeId) await openColumnsModal(employeeId);
        else await openIdentityModal();
    }

    async function handleIdentitySubmit(e) {
        e.preventDefault();
        const employeeId = $('#empIdentityEmployee').value;
        const password = $('#empIdentityPassword').value;
        if (!employeeId || !password) {
            toast('Выберите себя и введите пароль', 'error');
            return;
        }
        try {
            await storage.verifyEmployeeIdentity(Number(employeeId), password);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAlive()) return;
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }
        sessionStorage.setItem(SESSION_KEY, employeeId);
        cachedHiddenColumns = null;
        identityModal.hidden = true;
        await openColumnsModal(Number(employeeId));
    }

    async function handleApply() {
        const employeeId = getIdentifiedEmployeeId();
        if (!employeeId) return;

        const hiddenColumns = Array.from(list.querySelectorAll('input[type="checkbox"]'))
            .filter((cb) => !cb.checked)
            .map((cb) => cb.dataset.columnKey);

        try {
            await storage.saveColumnSettings(employeeId, hiddenColumns);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAlive()) return;
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }

        cachedHiddenColumns = new Set(hiddenColumns);
        columnsModal.hidden = true;
        if (onApplied) await onApplied();
        if (!isAlive()) return;
        toast('Настройки колонок сохранены', 'success');
    }

    function init() {
        $('[data-role="columns-btn"]').addEventListener('click', handleGearClick);

        $('[data-role="identity-form"]').addEventListener('submit', handleIdentitySubmit);
        $('[data-role="identity-cancel"]').addEventListener('click', () => { identityModal.hidden = true; });
        $('[data-role="identity-close"]').addEventListener('click', () => { identityModal.hidden = true; });
        identityModal.addEventListener('click', (e) => { if (e.target === identityModal) identityModal.hidden = true; });

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
