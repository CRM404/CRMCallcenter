// --- modal.js: модальное окно сотрудника (шаги, заполнение, сохранение) ---

import { getEmployees, saveEmployees, incrementId, setEmployees } from './storage.js';
import { showToast } from './toast.js';
import { validatePhone, validateEmail, formatPhone } from './validation.js';
import { renderTable } from './render.js';

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
const managerInput = document.getElementById('manager');
const passwordInput = document.getElementById('password');

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
    { key: 'manager', input: managerInput },
    { key: 'hireDate', input: hireDateInput },
    { key: 'status', input: statusSelect },
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

// --- Открытие модалки (новый или редактирование) ---
export function openEmployeeModal(title, employee = null) {
    modal.style.display = 'flex';
    modalTitle.textContent = employee ? `${title} (ID: ${String(employee.id).padStart(4, '0')})` : title;
    goToStep(1);

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

    // Сохраняем исходные данные для отслеживания изменений
    captureOriginalData();
}

// --- Заполнение формы данными сотрудника ---
function fillForm(emp) {
    FIELD_SCHEMA.forEach(({ key, input }) => {
        input.value = emp[key] || '';
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

// --- Читает файл как base64 (data URL) ---
function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// --- Собирает данные документов: новый выбранный файл (base64) либо ранее сохранённые данные ---
async function collectFileFields(existingEmp) {
    const result = {};
    for (const { key, input } of FILE_FIELD_SCHEMA) {
        if (input.files.length) {
            const file = input.files[0];
            const data = await readFileAsDataUrl(file);
            result[key] = { name: file.name, data };
        } else {
            result[key] = (existingEmp && existingEmp[key]) || '';
        }
    }
    return result;
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

    const phoneDigits = phone.replace(/\D/g, '');
    const employees = getEmployees();
    const duplicatePhone = employees.some(emp => {
        const empPhoneDigits = emp.phone ? emp.phone.replace(/\D/g, '') : '';
        return empPhoneDigits === phoneDigits && emp.id !== editingId;
    });
    if (duplicatePhone) {
        showToast('Сотрудник с таким номером телефона уже существует', 'error');
        return;
    }
    const duplicateEmail = employees.some(emp =>
        (emp.email || '').toLowerCase() === email.toLowerCase() && emp.id !== editingId
    );
    if (duplicateEmail) {
        showToast('Сотрудник с таким email уже существует', 'error');
        return;
    }

    const existingEmp = editingId !== null ? employees.find(emp => emp.id === editingId) : null;
    const fileData = await collectFileFields(existingEmp);

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
        manager: managerInput.value.trim(),
        hireDate: hireDateInput.value,
        status: statusSelect.value,
        password: passwordInput.value.trim(),
        country: countrySelect.value,
        registration: registrationInput.value.trim(),
        passportSeries: passportSeriesInput.value.trim(),
        passportNumber: passportNumberInput.value.trim(),
        issuedBy: issuedByInput.value.trim(),
        issueDate: issueDateInput.value,
        inn: innInput.value.trim(),
        bank: bankInput.value.trim(),
        account: accountInput.value.trim(),
        ...fileData
    };

    if (editingId !== null) {
        const index = employees.findIndex(emp => emp.id === editingId);
        if (index !== -1) {
            employees[index] = { id: editingId, ...empData };
            saveEmployees();
            renderTable();
            closeEmployeeModal(true);
            showToast('Изменения сохранены', 'success');
        } else {
            showToast('Ошибка: сотрудник не найден', 'error');
        }
    } else {
        const newEmp = { id: incrementId(), ...empData };
        employees.push(newEmp);
        saveEmployees();
        renderTable();
        closeEmployeeModal(true);
        showToast('Сотрудник добавлен', 'success');
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
export function openEditEmployee(id) {
    const employees = getEmployees();
    const emp = employees.find(e => e.id === id);
    if (!emp) return;
    openEmployeeModal('Редактирование сотрудника', emp);
}
