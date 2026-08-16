// --- modal.js: модальное окно сотрудника (шаги, заполнение, сохранение) ---

import {
    fetchEmployeeById,
    fetchEmployeeDocuments,
    fetchManagerList,
    createEmployee,
    updateEmployee,
    uploadEmployeeDocument,
    DOCUMENT_TYPE_MAP
} from './storage.js';
import { showToast } from './toast.js';
import { validatePhone, validateEmail, formatPhone } from './validation.js';
import { renderTable } from './render.js';
import { parseShiftInput, parseWorkDaysInput, formatShiftInput } from './scheduleTime.js';
import { getScheduleState, loadMonth } from './scheduleView.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// DOM-элементы
const modal = document.getElementById('employeeModal');
const modalTitle = document.getElementById('modalTitle');
const stepIndicator = document.getElementById('stepIndicator');
const submitBtn = document.getElementById('submitBtn');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const addEmployeeBtn = document.getElementById('addEmployeeBtn');

const form = document.getElementById('employeeForm');
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const nextStepBtn = document.getElementById('nextStepBtn');
const prevStepBtn = document.getElementById('prevStepBtn');

const firstNameInput = document.getElementById('firstName');
const lastNameInput = document.getElementById('lastName');
const emailInput = document.getElementById('email');
const phoneInput = document.getElementById('phone');
const positionInput = document.getElementById('position');
const departmentInput = document.getElementById('department');
const hireDateInput = document.getElementById('hireDate');
const statusSelect = document.getElementById('status');
const middleNameInput = document.getElementById('middleName');
const whatsappInput = document.getElementById('whatsapp');
const telegramInput = document.getElementById('telegram');
const managerSelect = document.getElementById('manager');
const terminationDateInput = document.getElementById('terminationDate');
const lineTypeInput = document.getElementById('lineType');
const workScheduleInput = document.getElementById('workSchedule');
const shiftTimeInput = document.getElementById('shiftTime');
const passwordInput = document.getElementById('password');

// Подсказки блока «График работы» — дословно из макета. Держим их здесь,
// потому что подпись под полем меняется на три состояния: обычная, пустое поле
// (предупреждение) и ошибка формата.
const WORK_SCHEDULE_HINT = 'Рабочих дней подряд и выходных подряд: 5/2, 3/3, 2/2, 4/2. Справочная запись: выходные при заполнении месяца отмечает администратор, из этого поля они не считаются.';
const SHIFT_TIME_HINT = 'С минутами, 24 часа. Смена через полночь — 22:00-06:00.';
const SHIFT_TIME_EMPTY_HINT = 'Без времени смены месяц по этому сотруднику заполнить нельзя, а в меню дня пункт «Смена» неактивен. Поле «Дни» на заполнение не влияет — пустым оно ничего не ломает.';

const countrySelect = document.getElementById('country');
const registrationInput = document.getElementById('registration');
const passportSeriesInput = document.getElementById('passportSeries');
const passportNumberInput = document.getElementById('passportNumber');
const issuedByInput = document.getElementById('issuedBy');
const issueDateInput = document.getElementById('issueDate');
const innInput = document.getElementById('inn');
const bankInput = document.getElementById('bank');
const accountInput = document.getElementById('account');
const passportFrontInput = document.getElementById('passportFront');
const passportBackInput = document.getElementById('passportBack');
const patentInput = document.getElementById('patent');
const contractInput = document.getElementById('contract');
const additionalAgreementInput = document.getElementById('additionalAgreement');

// --- Единая схема текстовых полей формы ---
const FIELD_SCHEMA = [
    { key: 'lastName', input: lastNameInput },
    { key: 'firstName', input: firstNameInput },
    { key: 'middleName', input: middleNameInput },
    { key: 'email', input: emailInput },
    { key: 'phone', input: phoneInput },
    { key: 'whatsapp', input: whatsappInput },
    { key: 'telegram', input: telegramInput },
    { key: 'position', input: positionInput },
    { key: 'department', input: departmentInput },
    { key: 'managerId', input: managerSelect },
    { key: 'hireDate', input: hireDateInput },
    { key: 'status', input: statusSelect },
    { key: 'terminationDate', input: terminationDateInput },
    { key: 'lineType', input: lineTypeInput },
    { key: 'workSchedule', input: workScheduleInput },
    // Одно поле формы — две колонки в базе: собирается из shiftStart/shiftEnd
    // при заполнении и разбирается обратно при сохранении (dialog.md, Б1).
    { key: 'shiftTime', input: shiftTimeInput, fromEmployee: (emp) => formatShiftInput(emp.shiftStart, emp.shiftEnd) },
    { key: 'password', input: passwordInput },
    { key: 'country', input: countrySelect },
    { key: 'registration', input: registrationInput },
    { key: 'passportSeries', input: passportSeriesInput },
    { key: 'passportNumber', input: passportNumberInput },
    { key: 'issuedBy', input: issuedByInput },
    { key: 'issueDate', input: issueDateInput },
    { key: 'inn', input: innInput },
    { key: 'bank', input: bankInput },
    { key: 'account', input: accountInput }
];

// --- Единая схема полей документов ---
const FILE_FIELD_SCHEMA = [
    { key: 'passportFront', input: passportFrontInput },
    { key: 'passportBack', input: passportBackInput },
    { key: 'patent', input: patentInput },
    { key: 'contract', input: contractInput },
    { key: 'additionalAgreement', input: additionalAgreementInput }
];

let editingId = null;
let originalFormData = {};
let currentStep = 1;

// --- Наполняет <select> "Руководитель" активными сотрудниками (кроме самого редактируемого) ---
async function populateManagerSelect(excludeId) {
    managerSelect.innerHTML = '<option value="">Без руководителя</option>';
    let managers = [];
    try {
        managers = await fetchManagerList(excludeId);
    } catch (err) {
        showToast(err.message, 'error');
    }
    managers.forEach(m => {
        const opt = document.createElement('option');
        opt.value = String(m.id);
        opt.textContent = m.fullName;
        managerSelect.appendChild(opt);
    });
}

// --- Открытие модалки (новый или редактирование) ---
export async function openEmployeeModal(title, employee = null) {
    modal.style.display = 'flex';
    modalTitle.textContent = employee ? `${title} (ID: ${String(employee.id).padStart(4, '0')})` : title;
    goToStep(1);

    // Файловые input'ы (и подписи с прошлого открытия модалки) могли сохранить выбор файла —
    // очищаем, чтобы каждая сессия редактирования начиналась без "призрачного" выбора файла.
    FILE_FIELD_SCHEMA.forEach(({ input }) => {
        input.value = '';
        const wrapper = input.closest('.file-upload-area');
        if (!wrapper) return;
        const nameSpan = wrapper.querySelector('.file-name');
        const icon = wrapper.querySelector('.file-status-icon');
        if (nameSpan) nameSpan.textContent = '';
        if (icon) icon.style.display = 'none';
    });

    await populateManagerSelect(employee ? employee.id : null);

    if (employee) {
        fillForm(employee);
        submitBtn.textContent = 'Сохранить изменения';
        editingId = employee.id;
    } else {
        form.reset();
        statusSelect.value = 'active';
        passwordInput.value = '';
        countrySelect.value = 'Российская Федерация';
        submitBtn.textContent = 'Добавить сотрудника';
        editingId = null;
    }

    resetScheduleFieldHints();

    // Сохраняем исходные данные для отслеживания изменений
    captureOriginalData();
}

// --- Заполнение формы данными сотрудника ---
function fillForm(emp) {
    FIELD_SCHEMA.forEach(({ key, input, fromEmployee }) => {
        input.value = (fromEmployee ? fromEmployee(emp) : emp[key]) || '';
    });
    FILE_FIELD_SCHEMA.forEach(({ key, input }) => {
        const wrapper = input.closest('.file-upload-area');
        if (!wrapper) return;
        const nameSpan = wrapper.querySelector('.file-name');
        const icon = wrapper.querySelector('.file-status-icon');
        const fileName = (emp[key] && emp[key].name) || '';
        if (nameSpan) {
            nameSpan.textContent = fileName;
        }
        if (icon) {
            icon.style.display = fileName ? 'inline-block' : 'none';
        }
    });
}

// --- Сохраняем исходные данные формы ---
function captureOriginalData() {
    originalFormData = {};
    FIELD_SCHEMA.forEach(({ key, input }) => {
        originalFormData[key] = input.value;
    });
    FILE_FIELD_SCHEMA.forEach(({ key }) => {
        originalFormData[key] = '';
    });
}

// --- Навигация по шагам ---
function goToStep(step) {
    currentStep = step;
    step1.style.display = step === 1 ? 'block' : 'none';
    step2.style.display = step === 2 ? 'block' : 'none';
    if (stepIndicator) {
        stepIndicator.textContent = `Шаг ${step} из 2`;
    }
}

// --- Закрытие модалки (с проверкой изменений) ---
export async function closeEmployeeModal(skipConfirm = false) {
    if (!skipConfirm && modal.style.display === 'flex') {
        const currentData = getCurrentFormData();
        let isChanged = false;
        for (let key in originalFormData) {
            if (originalFormData[key] !== currentData[key]) {
                isChanged = true;
                break;
            }
        }
        if (isChanged) {
            const confirmed = await import('./confirmModal.js').then(m => m.showCloseConfirm('Есть несохранённые изменения. Закрыть без сохранения?'));
            if (!confirmed) return;
        }
    }
    modal.style.display = 'none';
    editingId = null;
}

function getCurrentFormData() {
    const data = {};
    FIELD_SCHEMA.forEach(({ key, input }) => {
        data[key] = input.value;
    });
    FILE_FIELD_SCHEMA.forEach(({ key, input }) => {
        data[key] = input.files.length ? input.files[0].name : '';
    });
    return data;
}

// --- Блок «График работы»: проверка формата на клиенте ---
//
// Проверка есть и здесь, и на сервере: форма — не единственный вход в
// PUT /api/employees/:id. Тексты ошибок одни и те же, дословно из макета.

function setScheduleFieldState(input, { error = false, warn = false, text }) {
    const group = input.closest('.schedule-field');
    if (!group) return;
    group.classList.toggle('bad', error);
    const hint = group.querySelector('.field-hint');
    if (!hint) return;
    hint.classList.toggle('warn', warn);
    hint.textContent = text;
}

// Проверяет и НОРМАЛИЗУЕТ значение. Нормализация видна сразу: если ввод
// остаётся как набрали, а в таблице появляется другое, человек решит, что
// система поправила его молча и неизвестно как.
function validateWorkDaysField() {
    const result = parseWorkDaysInput(workScheduleInput.value);
    if (result.error) {
        setScheduleFieldState(workScheduleInput, { error: true, text: result.error });
        return null;
    }
    workScheduleInput.value = result.value || '';
    setScheduleFieldState(workScheduleInput, { text: WORK_SCHEDULE_HINT });
    return result;
}

function validateShiftTimeField() {
    const result = parseShiftInput(shiftTimeInput.value);
    if (result.error) {
        setScheduleFieldState(shiftTimeInput, { error: true, text: result.error });
        return null;
    }
    shiftTimeInput.value = formatShiftInput(result.start, result.end);
    setScheduleFieldState(shiftTimeInput, {
        warn: !result.start,
        text: result.start ? SHIFT_TIME_HINT : SHIFT_TIME_EMPTY_HINT
    });
    return result;
}

// Возврат подписей к исходному виду при открытии модалки: ошибка от прошлого
// сотрудника не должна висеть на новом.
function resetScheduleFieldHints() {
    const hasTime = Boolean(shiftTimeInput.value.trim());
    setScheduleFieldState(workScheduleInput, { text: WORK_SCHEDULE_HINT });
    setScheduleFieldState(shiftTimeInput, {
        warn: !hasTime,
        text: hasTime ? SHIFT_TIME_HINT : SHIFT_TIME_EMPTY_HINT
    });
}

// --- Читает файл как base64 (data URL) ---
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// --- Загружает на сервер только реально изменившиеся (выбранные) документы ---
async function uploadChangedDocuments(employeeId) {
    const errors = [];
    for (const { key, input } of FILE_FIELD_SCHEMA) {
        if (input.files.length) {
            const file = input.files[0];
            try {
                const data = await readFileAsDataUrl(file);
                await uploadEmployeeDocument(employeeId, DOCUMENT_TYPE_MAP[key], file.name, data);
            } catch (err) {
                errors.push(`${file.name}: ${err.message}`);
            }
        }
    }
    return errors;
}

// --- Переводит фокус на первое невалидное обязательное поле шага 1 ---
function focusFirstInvalidStep1Field(lastName, firstName, email, phone) {
    if (!lastName) { lastNameInput.focus(); return; }
    if (!firstName) { firstNameInput.focus(); return; }
    if (!email || !validateEmail(email)) { emailInput.focus(); return; }
    if (!phone || !validatePhone(phone)) { phoneInput.focus(); return; }
}

// --- Сохранение сотрудника (обработчик submit) ---
export async function handleEmployeeSubmit(e) {
    e.preventDefault();
    if (currentStep !== 2) {
        showToast('Сначала заполните все поля на первой странице и нажмите "Далее"', 'error');
        return;
    }

    const lastName = lastNameInput.value.trim();
    const firstName = firstNameInput.value.trim();
    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    if (!lastName || !firstName || !email || !phone) {
        showToast('Заполните обязательные поля: Фамилия, Имя, Email, Телефон', 'error');
        focusFirstInvalidStep1Field(lastName, firstName, email, phone);
        return;
    }
    if (!validateEmail(email)) {
        showToast('Введите корректный email', 'error');
        focusFirstInvalidStep1Field(lastName, firstName, email, phone);
        return;
    }
    if (!validatePhone(phone)) {
        showToast('Номер должен соответствовать форматам: +7 9xx xxx-xx-xx (Россия), +7 7xx xxx-xx-xx (Казахстан), +998 xx xxx-xx-xx (Узбекистан), +996 xx xxx-xx-xx (Кыргызстан)', 'error');
        focusFirstInvalidStep1Field(lastName, firstName, email, phone);
        return;
    }

    // Блок «График работы»: сохранить непонятное значение нельзя. Ошибка
    // показывается второй раз (первый — при уходе из поля).
    const workDays = validateWorkDaysField();
    const shiftTimes = validateShiftTimeField();
    if (!workDays || !shiftTimes) {
        const invalid = !workDays ? workScheduleInput : shiftTimeInput;
        showToast('Проверьте блок «График работы»: значение не распознано', 'error');
        invalid.focus();
        return;
    }

    const empData = {
        lastName,
        firstName,
        middleName: middleNameInput.value.trim(),
        email,
        phone: formatPhone(phone),
        whatsapp: whatsappInput.value.trim(),
        telegram: telegramInput.value.trim(),
        position: positionInput.value.trim(),
        department: departmentInput.value.trim(),
        managerId: managerSelect.value ? Number(managerSelect.value) : null,
        hireDate: hireDateInput.value,
        status: statusSelect.value,
        terminationDate: terminationDateInput.value,
        lineType: lineTypeInput.value.trim(),
        workSchedule: workDays.value,
        shiftStart: shiftTimes.start,
        shiftEnd: shiftTimes.end,
        password: passwordInput.value.trim(),
        country: countrySelect.value,
        registration: registrationInput.value.trim(),
        passportSeries: passportSeriesInput.value.trim(),
        passportNumber: passportNumberInput.value.trim(),
        issuedBy: issuedByInput.value.trim(),
        issueDate: issueDateInput.value,
        inn: innInput.value.trim(),
        bank: bankInput.value.trim(),
        account: accountInput.value.trim()
    };

    let savedEmployee;
    try {
        savedEmployee = editingId !== null
            ? await updateEmployee(editingId, empData)
            : await createEmployee(empData);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    const docErrors = await uploadChangedDocuments(savedEmployee.id);

    await renderTable();
    // Если режим «График» уже загружен в этой вкладке — перечитываем месяц:
    // время смены и «Дни» показываются в строке сетки, и оставить их устаревшими
    // значит показывать неправду до перезагрузки страницы.
    const scheduleState = getScheduleState();
    if (scheduleState.loaded && scheduleState.month) {
        await loadMonth(scheduleState.month);
    }
    closeEmployeeModal(true);

    if (docErrors.length > 0) {
        showToast(`Сотрудник сохранён, но не удалось загрузить документы: ${docErrors.join('; ')}`, 'error');
    } else {
        showToast(editingId !== null ? 'Изменения сохранены' : 'Сотрудник добавлен', 'success');
    }
}

// --- Инициализация обработчиков модалки ---
export function initModal() {
    // Кнопка "Добавить"
    addEmployeeBtn.addEventListener('click', () => openEmployeeModal('Новый сотрудник'));

    // Закрытие
    modalCloseBtn.addEventListener('click', () => closeEmployeeModal());
    modalCancelBtn.addEventListener('click', () => closeEmployeeModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) closeEmployeeModal(); });

    // Навигация
    nextStepBtn.addEventListener('click', () => {
        const lastName = lastNameInput.value.trim();
        const firstName = firstNameInput.value.trim();
        const email = emailInput.value.trim();
        const phone = phoneInput.value.trim();
        if (!lastName || !firstName || !email || !phone) {
            showToast('Пожалуйста, заполните обязательные поля: Фамилия, Имя, Email, Телефон', 'error');
            focusFirstInvalidStep1Field(lastName, firstName, email, phone);
            return;
        }
        if (!validateEmail(email)) {
            showToast('Введите корректный email', 'error');
            focusFirstInvalidStep1Field(lastName, firstName, email, phone);
            return;
        }
        if (!validatePhone(phone)) {
            showToast('Номер должен соответствовать форматам: +7 9xx xxx-xx-xx (Россия), +7 7xx xxx-xx-xx (Казахстан), +998 xx xxx-xx-xx (Узбекистан), +996 xx xxx-xx-xx (Кыргызстан)', 'error');
            focusFirstInvalidStep1Field(lastName, firstName, email, phone);
            return;
        }
        goToStep(2);
    });

    prevStepBtn.addEventListener('click', () => goToStep(1));

    // Ошибка формата показывается при уходе из поля и повторно при сохранении.
    workScheduleInput.addEventListener('blur', validateWorkDaysField);
    shiftTimeInput.addEventListener('blur', validateShiftTimeField);

    // Генерация пароля
    document.getElementById('generatePasswordBtn').addEventListener('click', () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
        let password = '';
        for (let i = 0; i < 10; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        passwordInput.value = password;
    });

    // Обработка отправки формы
    form.addEventListener('submit', handleEmployeeSubmit);

    // --- Инициализация красивых загрузчиков файлов ---
    const fileUploadAreas = document.querySelectorAll('#employeeModal .file-upload-area');
    fileUploadAreas.forEach(area => {
        const input = area.querySelector('.hidden-file-input');
        const nameSpan = area.querySelector('.file-name');
        const icon = area.querySelector('.file-status-icon');
        const triggerBtn = area.querySelector('.file-trigger');

        if (input && triggerBtn && nameSpan && icon) {
            // Клик по кнопке открывает диалог выбора файла
            triggerBtn.addEventListener('click', () => input.click());

            // Отслеживаем выбор файла
            input.addEventListener('change', function() {
                if (this.files && this.files.length > 0) {
                    const file = this.files[0];
                    if (file.size > MAX_FILE_SIZE) {
                        showToast('Файл слишком большой (максимум 5 МБ)', 'error');
                        this.value = '';
                        nameSpan.textContent = '';
                        icon.style.display = 'none';
                        return;
                    }
                    nameSpan.textContent = file.name;
                    icon.style.display = 'inline-block';
                } else {
                    nameSpan.textContent = '';
                    icon.style.display = 'none';
                }
            });
        }
    });
}

// --- Открыть редактирование по ID (из таблицы) ---
export async function openEditEmployee(id) {
    let emp, documents;
    try {
        emp = await fetchEmployeeById(id);
        documents = await fetchEmployeeDocuments(id);
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    const docsByKey = {};
    documents.forEach(doc => {
        const key = Object.keys(DOCUMENT_TYPE_MAP).find(k => DOCUMENT_TYPE_MAP[k] === doc.documentType);
        if (key) docsByKey[key] = { name: doc.fileName };
    });

    openEmployeeModal('Редактирование сотрудника', { ...emp, ...docsByKey });
}
