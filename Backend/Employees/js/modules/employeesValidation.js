// Переименован из validation.js при переносе в оболочку. Код не тронут:
// модуль чистый, только проверки и форматирование строк.
//
// --- employeesValidation.js: форматирование и валидация телефона/email ---

function normalizeRussian8(digits) {
    if (digits.length === 11 && digits.startsWith('8')) {
        return '7' + digits.slice(1);
    }
    return digits;
}

export function formatPhone(phone) {
    const digits = normalizeRussian8(phone.replace(/\D/g, ''));
    if (digits.length === 0) return '';

    if (digits.length === 11 && digits.startsWith('7')) {
        return `+${digits[0]} ${digits.slice(1,4)} ${digits.slice(4,6)}${digits.slice(6,8)}-${digits.slice(8,10)}${digits.slice(10)}`;
    }
    if (digits.length === 12 && digits.startsWith('998')) {
        return `+998 ${digits.slice(3,5)} ${digits.slice(5,8)}-${digits.slice(8,10)}${digits.slice(10,12)}`;
    }
    if (digits.length === 12 && digits.startsWith('996')) {
        return `+996 ${digits.slice(3,5)} ${digits.slice(5,8)}-${digits.slice(8,10)}${digits.slice(10,12)}`;
    }
    return phone;
}

export function validatePhone(phone) {
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.includes('+') && cleaned.indexOf('+') !== 0) return false;
    const digits = normalizeRussian8(cleaned.replace(/\+/g, ''));
    if (digits.length < 10 || digits.length > 12) return false;
    const validRules = [
        { prefix: '79', len: 11 },
        { prefix: '77', len: 11 },
        { prefix: '998', len: 12 },
        { prefix: '996', len: 12 }
    ];
    return validRules.some(rule => digits.startsWith(rule.prefix) && digits.length === rule.len);
}

export function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}