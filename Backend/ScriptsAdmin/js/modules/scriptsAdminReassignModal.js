// --- scriptsAdminReassignModal.js: модалка выбора при назначении оператора, у которого
// уже есть другой скрипт (многие-ко-многим) — добавить ещё один или переназначить.

let resolveCurrent = null;

export function initReassignModal() {
    const overlay = document.getElementById('reassignModal');
    const cancelBtn = document.getElementById('reassignModalCancelBtn');
    const replaceBtn = document.getElementById('reassignModalReplaceBtn');
    const addBtn = document.getElementById('reassignModalAddBtn');
    const closeBtn = document.getElementById('reassignModalCloseBtn');

    function close(result) {
        overlay.hidden = true;
        if (resolveCurrent) {
            resolveCurrent(result);
            resolveCurrent = null;
        }
    }

    cancelBtn.addEventListener('click', () => close('cancel'));
    closeBtn.addEventListener('click', () => close('cancel'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('cancel'); });
    replaceBtn.addEventListener('click', () => close('replace'));
    addBtn.addEventListener('click', () => close('add'));
}

// Возвращает Promise<'add'|'replace'|'cancel'>.
export function askReassignChoice(message) {
    const overlay = document.getElementById('reassignModal');
    document.getElementById('reassignModalMessage').textContent = message;
    overlay.hidden = false;
    return new Promise((resolve) => {
        resolveCurrent = resolve;
    });
}
