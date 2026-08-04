// --- storage.js: загрузка / сохранение данных ---

import { showToast } from './toast.js';

let employees = [];
let currentId = 1;

// Загружает данные из localStorage или создаёт демо-сотрудников
export function loadEmployees() {
    const stored = localStorage.getItem('employees');
    if (stored) {
        try {
            employees = JSON.parse(stored);
            currentId = employees.length ? Math.max(...employees.map(e => e.id)) + 1 : 1;
        } catch (e) {
            employees = [];
            currentId = 1;
        }
    } else {
        // Демо-данные
        employees = [
            { id: currentId++, firstName: 'Анна', lastName: 'Смирнова', middleName: '', email: 'anna@company.ru', phone: '+7 900 111-22-33', whatsapp: '', telegram: '', position: 'Старший оператор', department: 'Поддержка', manager: '', hireDate: '2025-01-15', status: 'active', password: '', country: 'Российская Федерация', registration: '', passportSeries: '', passportNumber: '', issuedBy: '', issueDate: '', inn: '', bank: '', account: '' },
            { id: currentId++, firstName: 'Максим', lastName: 'Иванов', middleName: '', email: 'maxim@company.ru', phone: '+7 900 222-33-44', whatsapp: '', telegram: '', position: 'Оператор', department: 'Продажи', manager: '', hireDate: '2025-02-20', status: 'inactive', password: '', country: 'Казахстан', registration: '', passportSeries: '', passportNumber: '', issuedBy: '', issueDate: '', inn: '', bank: '', account: '' }
        ];
        saveEmployees();
    }
    return employees;
}

export function saveEmployees() {
    try {
        localStorage.setItem('employees', JSON.stringify(employees));
    } catch (e) {
        showToast('Не удалось сохранить данные (возможно, переполнено хранилище)', 'error');
    }
}

export function getEmployees() {
    return employees;
}

export function getCurrentId() {
    return currentId;
}

export function incrementId() {
    return currentId++;
}

export function setEmployees(newData) {
    employees = newData;
}