// --- massActions.js: массовые операции над выбранными сотрудниками ---

import { fetchEmployeeById, updateEmployee } from './storage.js';
import { showToast } from './toast.js';
import { renderTable } from './render.js';

let selectedIds = new Set();

// Плавающая панель массовых операций (Отчёт Дизайн.md, 3.5) — выезжает при
// первом выделенном чекбоксе, .list-section резервирует место снизу, пока
// панель видна (dialog.md, п.9 — иначе последняя строка/пагинация под ней).
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

    document.querySelectorAll('.row-checkbox').forEach((cb) => {
        const row = cb.closest('tr');
        if (row) row.classList.toggle('row-selected', cb.checked);
    });

    const massActionsEl = document.getElementById('massActions');
    const listSection = document.getElementById('listSection');
    const hasSelection = selectedIds.size > 0;
    if (massActionsEl) massActionsEl.classList.toggle('visible', hasSelection);
    if (listSection) listSection.classList.toggle('reserve-mass-actions-space', hasSelection);
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

    // Крестик на плавающей панели — сброс выделения
    const massClearBtn = document.getElementById('massClearBtn');
    if (massClearBtn) {
        massClearBtn.addEventListener('click', clearSelection);
    }

    // Кнопка "Применить"
    document.getElementById('massApplyBtn').addEventListener('click', async function() {
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
            // Массовое изменение статуса — по одному PUT-запросу на сотрудника
            let changedCount = 0;
            let failedCount = 0;
            for (const id of selectedIds) {
                try {
                    const emp = await fetchEmployeeById(id);
                    if (emp.status !== 'inactive') {
                        await updateEmployee(id, { ...emp, status: 'inactive' });
                        changedCount++;
                    }
                } catch (err) {
                    failedCount++;
                }
            }
            await renderTable();
            if (changedCount > 0) {
                showToast(`Статус обновлён для ${changedCount} сотрудников`, 'success');
            } else if (failedCount === 0) {
                showToast('Нет сотрудников для изменения (уже неактивные)', 'info');
            }
            if (failedCount > 0) {
                showToast(`Не удалось обновить ${failedCount} сотрудников`, 'error');
            }
            clearSelection();
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
