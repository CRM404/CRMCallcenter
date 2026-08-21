// --- employeesCard.js: окно сотрудника (два шага, заполнение, сохранение) ---
//
// Переименован из modal.js и переведён на фабрику: раньше сорок с лишним узлов
// брались через document на верхнем уровне модуля — один раз, при импорте. В
// оболочке модуль импортируется один раз, а монтируется много: ссылки
// указывали бы на поля первой панели даже после её закрытия.
//
// Подтверждение «закрыть без сохранения» больше не своё окно, а ctx.confirm из
// слоя. Удаление сотрудника подтверждает таблица, тоже слоем.

import { DOCUMENT_TYPE_MAP } from './employeesStorage.js';
import { validatePhone, validateEmail, formatPhone } from './employeesValidation.js';
import { parseShiftInput, parseWorkDaysInput, formatShiftInput } from './employeesScheduleTime.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Ключ поля -> id в разметке. Раньше это был список ссылок на узлы; теперь
// список имён, а узел берётся в границах своей панели.
const FIELDS = [
    'lastName', 'firstName', 'middleName', 'email', 'phone', 'whatsapp', 'telegram',
    'position', 'department', 'hireDate', 'status', 'terminationDate', 'lineType',
    'workSchedule', 'password', 'country', 'registration', 'passportSeries',
    'passportNumber', 'issuedBy', 'issueDate', 'inn', 'bank', 'account'
];
// Два поля не совпадают с ключом данных: список руководителей и время смены,
// которое в базе лежит двумя колонками.
const MANAGER_FIELD = 'managerId';
const SHIFT_FIELD = 'shiftTime';

const DOC_FIELDS = ['passportFront', 'passportBack', 'patent', 'contract', 'additionalAgreement'];

// Подписи блока «График работы» — под полем три состояния: обычное,
// предупреждение о пустом времени и ошибка формата.
const WORK_SCHEDULE_HINT = 'Рабочих дней подряд и выходных подряд: 5/2, 3/3, 2/2, 4/2. Справочная запись: выходные при заполнении месяца отмечает администратор, из этого поля они не считаются.';
const SHIFT_TIME_HINT = 'С минутами, 24 часа. Смена через полночь — 22:00-06:00.';
const SHIFT_TIME_EMPTY_HINT = 'Без времени смены месяц по этому сотруднику заполнить нельзя, а в меню дня пункт «Смена» неактивен. Поле «Дни» на заполнение не влияет — пустым оно ничего не ломает.';

function fieldId(key) {
    return '#emp' + key.charAt(0).toUpperCase() + key.slice(1);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, confirm, isAlive, isAbort, onSaved }
 */
export function createCard(root, deps) {
    const { storage, toast, confirm, isAlive, isAbort, onSaved } = deps;

    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));
    const modal = $('[data-role="employee-modal"]');
    const saveBtn = $('[data-role="employee-save"]');

    let editingId = null;
    let currentStep = 1;
    let originalFormData = {};
    let saving = false;

    function docInput(key) {
        return $(`[data-doc="${key}"]`);
    }

    // ------------------------------------------------------------ форма

    async function populateManagerSelect(excludeId) {
        const select = $('#empManager');
        select.innerHTML = '<option value="">Без руководителя</option>';
        let managers = [];
        try {
            managers = await storage.fetchManagerList(excludeId);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }
        managers.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = String(m.id);
            opt.textContent = m.fullName;
            select.appendChild(opt);
        });
    }

    function fillForm(emp) {
        FIELDS.forEach((key) => { $(fieldId(key)).value = emp[key] || ''; });
        $('#empManager').value = emp[MANAGER_FIELD] || '';
        $('#empShiftTime').value = formatShiftInput(emp.shiftStart, emp.shiftEnd) || '';
        DOC_FIELDS.forEach((key) => {
            const input = docInput(key);
            const area = input.closest('.file-upload-area');
            const nameSpan = area.querySelector('.file-name');
            const icon = area.querySelector('.file-status-icon');
            const fileName = (emp[key] && emp[key].name) || '';
            nameSpan.textContent = fileName;
            icon.hidden = !fileName;
        });
    }

    function clearForm() {
        FIELDS.forEach((key) => { $(fieldId(key)).value = ''; });
        $('#empManager').value = '';
        $('#empShiftTime').value = '';
        $('#empStatus').value = 'active';
        $('#empCountry').value = 'Российская Федерация';
    }

    function clearFileInputs() {
        DOC_FIELDS.forEach((key) => {
            const input = docInput(key);
            input.value = '';
            const area = input.closest('.file-upload-area');
            area.querySelector('.file-name').textContent = '';
            area.querySelector('.file-status-icon').hidden = true;
        });
    }

    function currentFormData() {
        const data = {};
        FIELDS.forEach((key) => { data[key] = $(fieldId(key)).value; });
        data[MANAGER_FIELD] = $('#empManager').value;
        data[SHIFT_FIELD] = $('#empShiftTime').value;
        DOC_FIELDS.forEach((key) => {
            const input = docInput(key);
            data[key] = input.files.length ? input.files[0].name : '';
        });
        return data;
    }

    function captureOriginalData() {
        originalFormData = currentFormData();
    }

    function goToStep(step) {
        currentStep = step;
        $('[data-role="step-1-fields"]').hidden = step !== 1;
        $('[data-role="step-2-fields"]').hidden = step !== 2;
        $('[data-role="step-indicator"]').textContent = `Шаг ${step} из 2`;
        $('[data-role="prev-step"]').hidden = step !== 2;
        $('[data-role="next-step"]').hidden = step !== 1;
        saveBtn.hidden = step !== 2;
    }

    // ------------------------------------------------------------ «График работы»

    function setScheduleFieldState(fieldRole, { error = false, warn = false, text }) {
        const group = $(`[data-role="${fieldRole}"]`);
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
        const input = $('#empWorkSchedule');
        const result = parseWorkDaysInput(input.value);
        if (result.error) {
            setScheduleFieldState('work-days-field', { error: true, text: result.error });
            return null;
        }
        input.value = result.value || '';
        setScheduleFieldState('work-days-field', { text: WORK_SCHEDULE_HINT });
        return result;
    }

    function validateShiftTimeField() {
        const input = $('#empShiftTime');
        const result = parseShiftInput(input.value);
        if (result.error) {
            setScheduleFieldState('shift-time-field', { error: true, text: result.error });
            return null;
        }
        input.value = formatShiftInput(result.start, result.end);
        setScheduleFieldState('shift-time-field', {
            warn: !result.start,
            text: result.start ? SHIFT_TIME_HINT : SHIFT_TIME_EMPTY_HINT
        });
        return result;
    }

    // Ошибка от прошлого сотрудника не должна висеть на новом.
    function resetScheduleFieldHints() {
        const hasTime = Boolean($('#empShiftTime').value.trim());
        setScheduleFieldState('work-days-field', { text: WORK_SCHEDULE_HINT });
        setScheduleFieldState('shift-time-field', {
            warn: !hasTime,
            text: hasTime ? SHIFT_TIME_HINT : SHIFT_TIME_EMPTY_HINT
        });
    }

    // ------------------------------------------------------------ открытие/закрытие

    async function open(title, employee = null) {
        modal.hidden = false;
        $('[data-role="employee-modal-title"]').textContent = employee
            ? `${title} (ID: ${String(employee.id).padStart(4, '0')})`
            : title;
        goToStep(1);

        // Выбор файла с прошлого открытия мог остаться — иначе каждая новая
        // карточка начиналась бы с «призрачного» файла.
        clearFileInputs();

        await populateManagerSelect(employee ? employee.id : null);
        if (!isAlive()) return;

        if (employee) {
            fillForm(employee);
            saveBtn.textContent = 'Сохранить изменения';
            editingId = employee.id;
        } else {
            clearForm();
            saveBtn.textContent = 'Добавить сотрудника';
            editingId = null;
        }

        resetScheduleFieldHints();
        captureOriginalData();
    }

    async function close(skipConfirm = false) {
        if (!skipConfirm && !modal.hidden) {
            const data = currentFormData();
            const changed = Object.keys(originalFormData).some((key) => originalFormData[key] !== data[key]);
            if (changed) {
                // Вопрос стоит в ЗАГОЛОВКЕ, последствие — в тексте (К92).
                // Было наоборот: заголовок существительным, вопрос уехал в
                // сообщение, — и окно спрашивало дважды в разных местах.
                const ok = await confirm({
                    title: 'Закрыть без сохранения?',
                    message: 'Введённые данные сотрудника не сохранятся.',
                    confirmLabel: 'Закрыть без сохранения'
                });
                if (!ok || !isAlive()) return;
            }
        }
        modal.hidden = true;
        editingId = null;
    }

    // ------------------------------------------------------------ сохранение

    function focusFirstInvalidStep1Field(lastName, firstName, email, phone) {
        if (!lastName) { $('#empLastName').focus(); return; }
        if (!firstName) { $('#empFirstName').focus(); return; }
        if (!email || !validateEmail(email)) { $('#empEmail').focus(); return; }
        if (!phone || !validatePhone(phone)) { $('#empPhone').focus(); }
    }

    // Общая проверка первого шага: она же на кнопке «Далее» и на сохранении.
    function checkStep1() {
        const lastName = $('#empLastName').value.trim();
        const firstName = $('#empFirstName').value.trim();
        const email = $('#empEmail').value.trim();
        const phone = $('#empPhone').value.trim();

        if (!lastName || !firstName || !email || !phone) {
            toast('Заполните обязательные поля: Фамилия, Имя, Email, Телефон', 'error');
            focusFirstInvalidStep1Field(lastName, firstName, email, phone);
            return null;
        }
        if (!validateEmail(email)) {
            toast('Введите корректный email', 'error');
            focusFirstInvalidStep1Field(lastName, firstName, email, phone);
            return null;
        }
        if (!validatePhone(phone)) {
            toast('Номер должен соответствовать форматам: +7 9xx xxx-xx-xx (Россия), +7 7xx xxx-xx-xx (Казахстан), +998 xx xxx-xx-xx (Узбекистан), +996 xx xxx-xx-xx (Кыргызстан)', 'error');
            focusFirstInvalidStep1Field(lastName, firstName, email, phone);
            return null;
        }
        return { lastName, firstName, email, phone };
    }

    async function uploadChangedDocuments(employeeId) {
        const errors = [];
        for (const key of DOC_FIELDS) {
            const input = docInput(key);
            if (!input.files.length) continue;
            const file = input.files[0];
            try {
                const data = await readFileAsDataUrl(file);
                await storage.uploadEmployeeDocument(employeeId, DOCUMENT_TYPE_MAP[key], file.name, data);
            } catch (err) {
                if (isAbort(err)) return errors;
                errors.push(`${file.name}: ${err.message}`);
            }
            if (!isAlive()) return errors;
        }
        return errors;
    }

    async function handleSubmit(e) {
        if (e) e.preventDefault();
        // Двойной щелчок по «Сохранить» создавал бы двух сотрудников: запрос
        // идёт секунду, а кнопка всё это время активна.
        if (saving) return;
        if (currentStep !== 2) {
            toast('Сначала заполните поля первого шага и нажмите «Далее»', 'error');
            return;
        }

        const base = checkStep1();
        if (!base) return;

        // Блок «График работы»: сохранить непонятное значение нельзя. Ошибка
        // показывается второй раз (первый — при уходе из поля).
        const workDays = validateWorkDaysField();
        const shiftTimes = validateShiftTimeField();
        if (!workDays || !shiftTimes) {
            toast('Проверьте блок «График работы»: значение не распознано', 'error');
            $(workDays ? '#empShiftTime' : '#empWorkSchedule').focus();
            return;
        }

        const empData = {
            lastName: base.lastName,
            firstName: base.firstName,
            middleName: $('#empMiddleName').value.trim(),
            email: base.email,
            phone: formatPhone(base.phone),
            whatsapp: $('#empWhatsapp').value.trim(),
            telegram: $('#empTelegram').value.trim(),
            position: $('#empPosition').value.trim(),
            department: $('#empDepartment').value.trim(),
            managerId: $('#empManager').value ? Number($('#empManager').value) : null,
            hireDate: $('#empHireDate').value,
            status: $('#empStatus').value,
            terminationDate: $('#empTerminationDate').value,
            lineType: $('#empLineType').value.trim(),
            workSchedule: workDays.value,
            shiftStart: shiftTimes.start,
            shiftEnd: shiftTimes.end,
            password: $('#empPassword').value.trim(),
            country: $('#empCountry').value,
            registration: $('#empRegistration').value.trim(),
            passportSeries: $('#empPassportSeries').value.trim(),
            passportNumber: $('#empPassportNumber').value.trim(),
            issuedBy: $('#empIssuedBy').value.trim(),
            issueDate: $('#empIssueDate').value,
            inn: $('#empInn').value.trim(),
            bank: $('#empBank').value.trim(),
            account: $('#empAccount').value.trim()
        };

        saving = true;
        saveBtn.disabled = true;
        const wasEditing = editingId !== null;
        let saved;
        try {
            saved = wasEditing
                ? await storage.updateEmployee(editingId, empData)
                : await storage.createEmployee(empData);
        } catch (err) {
            if (!isAlive()) return;
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        } finally {
            saving = false;
            saveBtn.disabled = false;
        }
        if (!isAlive()) return;

        const docErrors = await uploadChangedDocuments(saved.id);
        if (!isAlive()) return;

        await close(true);
        if (onSaved) await onSaved();
        if (!isAlive()) return;

        if (docErrors.length > 0) {
            toast(`Сотрудник сохранён, но не удалось загрузить документы: ${docErrors.join('; ')}`, 'error');
        } else {
            toast(wasEditing ? 'Изменения сохранены' : 'Сотрудник добавлен', 'success');
        }
    }

    /** Открыть карточку по id — из таблицы. */
    async function openById(id) {
        let emp;
        let documents;
        try {
            emp = await storage.fetchEmployeeById(id);
            documents = await storage.fetchEmployeeDocuments(id);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }
        const docsByKey = {};
        documents.forEach((doc) => {
            const key = Object.keys(DOCUMENT_TYPE_MAP).find((k) => DOCUMENT_TYPE_MAP[k] === doc.documentType);
            if (key) docsByKey[key] = { name: doc.fileName };
        });
        await open('Редактирование сотрудника', { ...emp, ...docsByKey });
    }

    function init() {
        $('[data-role="add-employee"]').addEventListener('click', () => open('Новый сотрудник'));
        $('[data-role="employee-close"]').addEventListener('click', () => close());
        $('[data-role="employee-cancel"]').addEventListener('click', () => close());
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        $('[data-role="next-step"]').addEventListener('click', () => {
            if (checkStep1()) goToStep(2);
        });
        $('[data-role="prev-step"]').addEventListener('click', () => goToStep(1));

        // Ошибка формата показывается при уходе из поля и повторно при сохранении.
        $('#empWorkSchedule').addEventListener('blur', validateWorkDaysField);
        $('#empShiftTime').addEventListener('blur', validateShiftTimeField);

        $('[data-role="generate-password"]').addEventListener('click', () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
            let password = '';
            for (let i = 0; i < 10; i++) password += chars.charAt(Math.floor(Math.random() * chars.length));
            $('#empPassword').value = password;
        });

        $('[data-role="employee-form"]').addEventListener('submit', handleSubmit);
        saveBtn.addEventListener('click', handleSubmit);

        // Загрузчики файлов
        $$('.file-upload-area').forEach((area) => {
            const input = area.querySelector('.hidden-file-input');
            const nameSpan = area.querySelector('.file-name');
            const icon = area.querySelector('.file-status-icon');
            const trigger = area.querySelector('.file-trigger');
            if (!input || !trigger) return;

            trigger.addEventListener('click', () => input.click());
            input.addEventListener('change', () => {
                if (!input.files || input.files.length === 0) {
                    nameSpan.textContent = '';
                    icon.hidden = true;
                    return;
                }
                const file = input.files[0];
                if (file.size > MAX_FILE_SIZE) {
                    toast('Файл слишком большой (максимум 5 МБ)', 'error');
                    input.value = '';
                    nameSpan.textContent = '';
                    icon.hidden = true;
                    return;
                }
                nameSpan.textContent = file.name;
                icon.hidden = false;
            });
        });
    }

    return { init, open, openById, close, isOpen: () => !modal.hidden };
}
