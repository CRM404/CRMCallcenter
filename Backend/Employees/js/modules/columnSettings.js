// --- columnSettings.js: идентификация сотрудника + персональные настройки видимых колонок ---

import { fetchEmployees, verifyEmployeeIdentity, fetchColumnSettings, saveColumnSettings } from './storage.js';
import { showToast } from './toast.js';
import { renderTable } from './render.js';

// Порядок и подписи — ровно те колонки, что уже есть в таблице сегодня.
// ID и "Действия" сюда не входят — это структурные элементы, показываются всегда.
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

const SESSION_KEY = 'crm_identifiedEmployeeId';

// Кэш скрытых колонок для уже опознанного в этой вкладке сотрудника — чтобы не
// дёргать сервер на каждый renderTable(), сбрасывается при новой идентификации и после "Применить".
let cachedHiddenColumns = null;

const gearBtn = document.getElementById('columnSettingsBtn');

const identityModal = document.getElementById('identityModal');
const identityForm = document.getElementById('identityForm');
const identitySelect = document.getElementById('identityEmployee');
const identityPasswordInput = document.getElementById('identityPassword');
const identityCancelBtn = document.getElementById('identityCancelBtn');
const identityCloseBtn = document.getElementById('identityCloseBtn');

const columnSettingsModal = document.getElementById('columnSettingsModal');
const columnCheckboxList = document.getElementById('columnCheckboxList');
const columnSettingsResetBtn = document.getElementById('columnSettingsResetBtn');
const columnSettingsApplyBtn = document.getElementById('columnSettingsApplyBtn');
const columnSettingsCancelBtn = document.getElementById('columnSettingsCancelBtn');
const columnSettingsCloseBtn = document.getElementById('columnSettingsCloseBtn');

export function getIdentifiedEmployeeId() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? Number(raw) : null;
}

// Возвращает Set ключей СКРЫТЫХ колонок для текущей опознанной (в этой вкладке) личности.
// Если личность ещё не подтверждена — пустой набор (показывать всё, как раньше).
export async function getHiddenColumns() {
    const employeeId = getIdentifiedEmployeeId();
    if (!employeeId) return new Set();
    if (cachedHiddenColumns) return cachedHiddenColumns;
    try {
        const { hiddenColumns } = await fetchColumnSettings(employeeId);
        cachedHiddenColumns = new Set(hiddenColumns);
    } catch (err) {
        cachedHiddenColumns = new Set();
    }
    return cachedHiddenColumns;
}

export function initColumnSettings() {
    gearBtn.addEventListener('click', handleGearClick);

    identityForm.addEventListener('submit', handleIdentitySubmit);
    identityCancelBtn.addEventListener('click', closeIdentityModal);
    identityCloseBtn.addEventListener('click', closeIdentityModal);
    identityModal.addEventListener('click', (e) => { if (e.target === identityModal) closeIdentityModal(); });

    columnSettingsResetBtn.addEventListener('click', () => {
        columnCheckboxList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    });
    columnSettingsApplyBtn.addEventListener('click', handleApplySettings);
    columnSettingsCancelBtn.addEventListener('click', closeColumnSettingsModal);
    columnSettingsCloseBtn.addEventListener('click', closeColumnSettingsModal);
    columnSettingsModal.addEventListener('click', (e) => { if (e.target === columnSettingsModal) closeColumnSettingsModal(); });
}

async function handleGearClick() {
    const employeeId = getIdentifiedEmployeeId();
    if (employeeId) {
        await openColumnSettingsModal(employeeId);
    } else {
        await openIdentityModal();
    }
}

async function openIdentityModal() {
    identityForm.reset();
    identitySelect.innerHTML = '<option value="">Выберите себя...</option>';
    try {
        const employees = await fetchEmployees();
        employees
            .slice()
            .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'ru'))
            .forEach((emp) => {
                const opt = document.createElement('option');
                opt.value = String(emp.id);
                opt.textContent = `${emp.lastName} ${emp.firstName}`;
                identitySelect.appendChild(opt);
            });
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    identityModal.style.display = 'flex';
}

function closeIdentityModal() {
    identityModal.style.display = 'none';
}

async function handleIdentitySubmit(e) {
    e.preventDefault();
    const employeeId = identitySelect.value;
    const password = identityPasswordInput.value;
    if (!employeeId || !password) {
        showToast('Выберите себя и введите пароль', 'error');
        return;
    }
    try {
        await verifyEmployeeIdentity(Number(employeeId), password);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }
    sessionStorage.setItem(SESSION_KEY, employeeId);
    cachedHiddenColumns = null;
    closeIdentityModal();
    await openColumnSettingsModal(Number(employeeId));
}

async function openColumnSettingsModal(employeeId) {
    let hidden;
    try {
        const { hiddenColumns } = await fetchColumnSettings(employeeId);
        hidden = new Set(hiddenColumns);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    columnCheckboxList.innerHTML = '';
    CONFIGURABLE_COLUMNS.forEach((col) => {
        const label = document.createElement('label');
        label.className = 'column-checkbox-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.columnKey = col.key;
        checkbox.checked = !hidden.has(col.key);
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(col.label));
        columnCheckboxList.appendChild(label);
    });

    columnSettingsModal.style.display = 'flex';
}

function closeColumnSettingsModal() {
    columnSettingsModal.style.display = 'none';
}

async function handleApplySettings() {
    const employeeId = getIdentifiedEmployeeId();
    if (!employeeId) return;

    const hiddenColumns = Array.from(columnCheckboxList.querySelectorAll('input[type="checkbox"]'))
        .filter((cb) => !cb.checked)
        .map((cb) => cb.dataset.columnKey);

    try {
        await saveColumnSettings(employeeId, hiddenColumns);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    cachedHiddenColumns = new Set(hiddenColumns);
    closeColumnSettingsModal();
    await renderTable();
    showToast('Настройки колонок сохранены', 'success');
}
