// --- mainStorage.js: клиент REST API раздела «Реквизиты» ---
//
// ЧТО ИЗМЕНИЛОСЬ ПРИ ПЕРЕЕЗДЕ В ОБОЛОЧКУ.
//
// Транспорт (функция request с fetch, разбором JSON и обработкой ошибки) был
// здесь дословной копией такой же функции из пяти других storage-модулей.
// Копия убрана — транспорт живёт в Shell/api.js.
//
// Доменные методы остались тут: сливать их в общий файл на шесть разделов
// значило бы заменить шесть копий одним монолитом, это не улучшение.
//
// ОБРАЗЕЦ ДЛЯ ОСТАЛЬНЫХ РАЗДЕЛОВ — фабрика, а не свободные функции.
// Раздел получает от оболочки ctx.api, привязанный к жизни его панели, и
// строит storage поверх него:
//
//     const storage = createStorage(ctx.api);
//
// Так закрытие панели обрывает незавершённые запросы раздела. Со свободными
// функциями, импортирующими общий request напрямую, это было бы невозможно:
// ответ пришёл бы в уже размонтированный раздел.

export function createStorage(api) {
    return {
        fetchOrganization: () =>
            api.get('/organization'),

        createOrganization: (data) =>
            api.post('/organization', data),

        updateOrganization: (id, data) =>
            api.put(`/organization/${id}`, data),

        createBankAccount: (organizationId, data) =>
            api.post(`/organization/${organizationId}/bank-accounts`, data),

        updateBankAccount: (organizationId, accountId, data) =>
            api.put(`/organization/${organizationId}/bank-accounts/${accountId}`, data),

        deleteBankAccount: (organizationId, accountId) =>
            api.del(`/organization/${organizationId}/bank-accounts/${accountId}`),

        createTax: (organizationId, data) =>
            api.post(`/organization/${organizationId}/taxes`, data),

        updateTax: (organizationId, taxId, data) =>
            api.put(`/organization/${organizationId}/taxes/${taxId}`, data),

        deleteTax: (organizationId, taxId) =>
            api.del(`/organization/${organizationId}/taxes/${taxId}`)
    };
}
