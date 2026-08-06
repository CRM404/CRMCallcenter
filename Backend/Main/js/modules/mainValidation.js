// --- mainValidation.js: валидация полей "Реквизиты" по типу данных (dialog.md, п.7) ---
// Все поля ниже остаются опциональными — проверка формата срабатывает только
// когда значение непустое (пустая строка не ошибка, сервер превратит её в NULL).
// Дублируется на бэке (routes/organization.js) — источник истины там, т.к. на
// API можно постучаться напрямую, мимо формы (то же соображение, что для
// санитайзера в задаче про rich-text).

export function validateInn(value) {
    if (!value) return null;
    return /^(\d{10}|\d{12})$/.test(value) ? null : 'ИНН должен содержать 10 или 12 цифр';
}

export function validateKpp(value) {
    if (!value) return null;
    return /^\d{9}$/.test(value) ? null : 'КПП должен содержать 9 цифр';
}

export function validateOgrn(value) {
    if (!value) return null;
    return /^(\d{13}|\d{15})$/.test(value) ? null : 'ОГРН должен содержать 13 или 15 цифр';
}

export function validateBik(value) {
    if (!value) return null;
    return /^\d{9}$/.test(value) ? null : 'БИК должен содержать 9 цифр';
}

export function validateAuthorizedCapital(value) {
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? null : 'Уставный капитал должен быть неотрицательным числом';
}

export const ORG_FIELD_VALIDATORS = {
    inn: validateInn,
    kpp: validateKpp,
    ogrn: validateOgrn,
    authorizedCapital: validateAuthorizedCapital
};

export const BANK_ACCOUNT_FIELD_VALIDATORS = {
    bik: validateBik
};

// Возвращает текст первой найденной ошибки или null, если все поля прошли.
export function validateFields(data, validators) {
    for (const [key, validate] of Object.entries(validators)) {
        const error = validate(data[key]);
        if (error) return error;
    }
    return null;
}
