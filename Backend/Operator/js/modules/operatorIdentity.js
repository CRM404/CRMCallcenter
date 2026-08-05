// --- operatorIdentity.js: идентичность оператора в sessionStorage ---
// Отдельный ключ от identifiedEmployeeId (настройки колонок на "Сотрудниках") —
// это полноценный вход, а не разовая лёгкая проверка, смешивать их нельзя.

const STORAGE_KEY = 'operatorIdentity';

export function getOperatorIdentity() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

export function setOperatorIdentity(identity) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function clearOperatorIdentity() {
    sessionStorage.removeItem(STORAGE_KEY);
}

// Вызывать в начале инициализации operator.html — редиректит на экран входа,
// если валидной идентичности нет. Возвращает identity или null (если уже редиректнул).
export function requireOperatorIdentity() {
    const identity = getOperatorIdentity();
    if (!identity || !identity.id) {
        window.location.replace('/operator-login.html');
        return null;
    }
    return identity;
}
