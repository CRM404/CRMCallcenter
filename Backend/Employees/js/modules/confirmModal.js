// --- confirmModal.js: подтверждение удаления и закрытия ---

import { deleteEmployee } from './storage.js';
import { showToast } from './toast.js';
import { renderTable } from './render.js';

let closeConfirmResolve = null;
let deleteTargetId = null;

// --- Подтверждение закрытия с несохранёнными изменениями ---
export function showCloseConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('closeConfirmModal');
        document.getElementById('closeConfirmMessage').textContent = message || 'Есть несохранённые изменения. Закрыть без сохранения?';
        modal.style.display = 'flex';
        closeConfirmResolve = resolve;
    });
}

function closeCloseConfirm(confirmed) {
    document.getElementById('closeConfirmModal').style.display = 'none';
    if (closeConfirmResolve) {
        closeConfirmResolve(confirmed);
        closeConfirmResolve = null;
    }
}

// --- Подтверждение удаления одного сотрудника ---
export function showDeleteConfirm(id) {
    deleteTargetId = id;
    document.getElementById('deleteModal').style.display = 'flex';
}

async function confirmDelete() {
    if (deleteTargetId !== null) {
        try {
            await deleteEmployee(deleteTargetId);
            await renderTable();
            showToast('Сотрудник успешно удален', 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
        document.getElementById('deleteModal').style.display = 'none';
        deleteTargetId = null;
    }
}

// --- Подтверждение массового удаления ---
export function showMassDeleteConfirm(ids) {
    return new Promise((resolve) => {
        const modal = document.getElementById('deleteModal');
        const message = document.querySelector('#deleteModal p');
        if (message) message.textContent = `Вы действительно хотите удалить ${ids.length} сотрудников? Действие необратимо.`;
        const confirmBtn = document.getElementById('deleteConfirmBtn');
        const cancelBtn = document.getElementById('deleteCancelBtn');
        const closeBtn = document.getElementById('deleteModalCloseBtn');
        modal.style.display = 'flex';

        const cleanup = function() {
            confirmBtn.removeEventListener('click', confirmHandler);
            cancelBtn.removeEventListener('click', cancelHandler);
            closeBtn.removeEventListener('click', cancelHandler);
            modal.removeEventListener('click', backdropHandler);
        };

        const confirmHandler = async function() {
            let deletedCount = 0;
            let failedCount = 0;
            for (const id of ids) {
                try {
                    await deleteEmployee(id);
                    deletedCount++;
                } catch (err) {
                    failedCount++;
                }
            }
            await renderTable();
            if (failedCount === 0) {
                showToast(`Удалено ${deletedCount} сотрудников`, 'success');
            } else {
                showToast(`Удалено ${deletedCount} из ${ids.length}, ${failedCount} не удалось удалить`, 'error');
            }
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };
        const cancelHandler = function() {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };
        const backdropHandler = function(e) {
            if (e.target === modal) {
                modal.style.display = 'none';
                cleanup();
                resolve(false);
            }
        };
        confirmBtn.addEventListener('click', confirmHandler);
        cancelBtn.addEventListener('click', cancelHandler);
        closeBtn.addEventListener('click', cancelHandler);
        modal.addEventListener('click', backdropHandler);
    });
}

// --- Инициализация обработчиков модалок подтверждения ---
export function initConfirmModals() {
    // Закрытие с изменениями
    document.getElementById('closeConfirmOkBtn').addEventListener('click', () => closeCloseConfirm(true));
    document.getElementById('closeConfirmCancelBtn').addEventListener('click', () => closeCloseConfirm(false));
    document.getElementById('closeConfirmCloseBtn').addEventListener('click', () => closeCloseConfirm(false));
    document.getElementById('closeConfirmModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeCloseConfirm(false);
    });

    // Удаление
    document.getElementById('deleteConfirmBtn').addEventListener('click', confirmDelete);
    document.getElementById('deleteCancelBtn').addEventListener('click', () => {
        document.getElementById('deleteModal').style.display = 'none';
        deleteTargetId = null;
    });
    document.getElementById('deleteModalCloseBtn').addEventListener('click', () => {
        document.getElementById('deleteModal').style.display = 'none';
        deleteTargetId = null;
    });
}