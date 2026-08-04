// --- massActions.js: массовые операции над выбранными сотрудниками ---

import { getEmployees, saveEmployees } from './storage.js';
import { showToast } from './toast.js';
import { renderTable } from './render.js';

let selectedIds = new Set();

export function updateSelectedCount() {
    const checkboxes = document.querySelectorAll('.row-checkbox:checked');
    selectedIds = new Set(Array.from(checkboxes).map(cb => parseInt(cb.dataset.id)));
    const countEl = document.getElementById('selectedCount');
    if (countEl) countEl.textContent = `Выбрано: ${selectedIds.size}`;
    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
        const allCheckboxes = document.querySelectorAll('.row-checkbox');
        selectAll.checked = allCheckboxes.length > 0 && allCheckboxes.length === checkboxes.length;
    }
}

function clearSelection() {
    document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = false);
    selectedIds.clear();
    updateSelectedCount();
    const selectAll = document.getElementById('selectAll');
    if (selectAll) selectAll.checked = false;
}

export function initMassActions() {
    // Обработчик "Выбрать все"
    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.addEventListener('change', function() {
            document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = this.checked);
            updateSelectedCount();
        });
    }

    // Обработчики чекбоксов (делегирование)
    document.getElementById('employeeTableBody').addEventListener('change', function(e) {
        if (e.target.classList.contains('row-checkbox')) {
            updateSelectedCount();
        }
    });

    // Кнопка "Применить"
    document.getElementById('massApplyBtn').addEventListener('click', function() {
        const action = document.getElementById('massActionSelect').value;
        if (!action) {
            showToast('Выберите действие', 'error');
            return;
        }
        if (selectedIds.size === 0) {
            showToast('Выберите хотя бы одного сотрудника', 'error');
            return;
        }

        if (action === 'inactive') {
            // Массовое изменение статуса
            const employees = getEmployees();
            let changed = false;
            employees.forEach(emp => {
                if (selectedIds.has(emp.id) && emp.status !== 'inactive') {
                    emp.status = 'inactive';
                    changed = true;
                }
            });
            if (changed) {
                saveEmployees();
                renderTable();
                showToast(`Статус обновлён для ${selectedIds.size} сотрудников`, 'success');
                clearSelection();
            } else {
                showToast('Нет сотрудников для изменения (уже неактивные)', 'info');
            }
        } else if (action === 'delete') {
            // Массовое удаление с подтверждением
            import('./confirmModal.js').then(m => {
                m.showMassDeleteConfirm(Array.from(selectedIds)).then(() => {
                    clearSelection();
                });
            });
        }
    });
}
