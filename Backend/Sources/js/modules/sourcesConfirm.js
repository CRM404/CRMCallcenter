// --- sourcesConfirm.js: общая модалка подтверждения удаления (источник /
// площадка / массовое удаление — один компонент на все три случая, тот же
// паттерн, что cpaConfirm.js) ---

let resolveCurrent = null;

export function initConfirmModal() {
    const overlay = document.getElementById('confirmModal');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    const okBtn = document.getElementById('confirmModalOkBtn');
    const closeBtn = document.getElementById('confirmModalCloseBtn');

    function close(result) {
        overlay.hidden = true;
        if (resolveCurrent) {
            resolveCurrent(result);
            resolveCurrent = null;
        }
    }

    cancelBtn.addEventListener('click', () => close(false));
    closeBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    okBtn.addEventListener('click', () => close(true));
}

// Возвращает Promise<boolean> — true, если пользователь подтвердил.
export function confirmAction(message) {
    const overlay = document.getElementById('confirmModal');
    document.getElementById('confirmModalMessage').textContent = message;
    overlay.hidden = false;
    return new Promise((resolve) => {
        resolveCurrent = resolve;
    });
}
