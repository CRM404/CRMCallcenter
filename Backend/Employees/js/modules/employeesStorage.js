// --- employeesStorage.js: доменные методы раздела «Сотрудники» ---
//
// Транспорта здесь больше нет: request/buildQuery живут в /api.js, один на
// проект. Storage раздела стал фабрикой — она получает ctx.api, привязанный к
// жизни ОДНОЙ панели, и все запросы раздела отменяются вместе с её закрытием.
//
//     const storage = createStorage(ctx.api);
//     const list = await storage.fetchEmployees({ search: 'Пет' });
//
// Переименован из storage.js: все статические папки монтируются в один корень,
// и файл с таким именем рано или поздно столкнётся с чужим.

// Соответствие ключей полей формы (camelCase) типам документов в БД/API (snake_case).
export const DOCUMENT_TYPE_MAP = {
    passportFront: 'passport_front',
    passportBack: 'passport_back',
    patent: 'patent',
    contract: 'contract',
    additionalAgreement: 'additional_agreement'
};

export function createStorage(api) {
    return {
        // --- Сотрудники ---

        fetchEmployees: (filters = {}) => api.get('/employees', filters),

        fetchEmployeeById: (id) => api.get(`/employees/${id}`),

        fetchManagerList: (excludeId) => api.get('/employees/list-for-manager', { excludeId }),

        createEmployee: (data) => api.post('/employees', data),

        updateEmployee: (id, data) => api.put(`/employees/${id}`, data),

        deleteEmployee: (id) => api.del(`/employees/${id}`),

        // --- Документы сотрудника ---

        fetchEmployeeDocuments: (employeeId) => api.get(`/employees/${employeeId}/documents`),

        uploadEmployeeDocument: (employeeId, documentType, fileName, fileData) =>
            api.post(`/employees/${employeeId}/documents`, { documentType, fileName, fileData }),

        // --- Идентификация и настройки видимых колонок ---

        verifyEmployeeIdentity: (employeeId, password) =>
            api.post('/auth/verify-employee', { employeeId, password }),

        fetchColumnSettings: (employeeId) => api.get(`/employees/column-settings/${employeeId}`),

        saveColumnSettings: (employeeId, hiddenColumns) =>
            api.put(`/employees/column-settings/${employeeId}`, { hiddenColumns }),

        // --- Организация (для списка «Юрлицо» в форме отдела) ---

        fetchOrganization: () => api.get('/organization'),

        // --- Отделы ---

        fetchDepartments: () => api.get('/departments'),

        createDepartment: (data) => api.post('/departments', data),

        updateDepartment: (id, data) => api.put(`/departments/${id}`, data),

        deleteDepartment: (id) => api.del(`/departments/${id}`),

        // --- График работы (режим «График» этого же раздела) ---

        // Месяц целиком одним запросом: сотрудники, их дни и серверное «сегодня»
        // в поясе приложения (по нему считаются подсветка колонки и счётчики).
        fetchSchedule: (month) => api.get('/schedule', { month }),

        saveScheduleDay: (payload) => api.put('/schedule/day', payload),

        clearScheduleDay: (employeeId, day) => api.del(`/schedule/day${api.buildQuery({ employeeId, day })}`),

        fillSchedule: (payload) => api.post('/schedule/fill', payload)
    };
}
