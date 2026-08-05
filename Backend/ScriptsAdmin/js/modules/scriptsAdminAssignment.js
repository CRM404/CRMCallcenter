// --- scriptsAdminAssignment.js: назначение скрипта операторам (employees.script_id) ---
// Один скрипт может быть назначен нескольким операторам; у оператора — ровно один
// скрипт, поэтому отметка чекбокса здесь просто перезаписывает employees.script_id.

import { assignScriptToEmployee } from './scriptsAdminStorage.js';
import { showToast } from './scriptsAdminToast.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function employeeFullName(emp) {
    return [emp.lastName, emp.firstName].filter(Boolean).join(' ') || `#${emp.id}`;
}

// onChanged() — перезагрузить список сотрудников/скриптов после назначения/снятия.
//
// Черновик блокирует только НОВЫЕ назначения (сервер отклонит попытку назначить
// scriptId черновика) — уже назначенных операторов всё равно нужно уметь снять
// с черновика (иначе от старого назначения не избавиться, не активируя скрипт
// заново). Поэтому список чекбоксов показывается всегда; для черновика просто
// отключены чекбоксы у ещё НЕ назначенных сотрудников.
export function renderAssignmentPanel(container, script, employees, onChanged) {
    if (!employees.length) {
        container.innerHTML = '<h2>Операторы</h2><div class="sa-empty-state">Нет сотрудников в системе.</div>';
        return;
    }

    const isDraft = script.status !== 'active';
    const draftNote = isDraft
        ? '<p class="sa-empty-state" style="text-align:left; padding:0 0 12px;">Скрипт сейчас черновик — новых операторов назначить нельзя (активируйте скрипт), но уже назначенных можно снять.</p>'
        : '';

    const rows = employees.map((emp) => {
        const assignedElsewhere = emp.scriptId && emp.scriptId !== script.id;
        const checked = emp.scriptId === script.id;
        const disableCheckbox = isDraft && !checked;
        const note = assignedElsewhere ? '<span class="sa-assign-note">уже назначен на другой скрипт — переключится на этот</span>' : '';
        return `
            <label class="sa-assign-row">
                <input type="checkbox" data-employee-id="${emp.id}" ${checked ? 'checked' : ''} ${disableCheckbox ? 'disabled' : ''}>
                <span>${escapeHtml(employeeFullName(emp))}</span>
                ${note}
            </label>
        `;
    }).join('');

    container.innerHTML = `<h2>Операторы, использующие этот скрипт</h2>${draftNote}<div class="sa-assign-list">${rows}</div>`;

    container.querySelectorAll('input[type=checkbox]').forEach((checkbox) => {
        checkbox.addEventListener('change', async () => {
            const employeeId = Number(checkbox.dataset.employeeId);
            checkbox.disabled = true;
            try {
                await assignScriptToEmployee(employeeId, checkbox.checked ? script.id : null);
                showToast(checkbox.checked ? 'Скрипт назначен' : 'Назначение снято', 'success');
                onChanged();
            } catch (e) {
                checkbox.checked = !checkbox.checked;
                showToast(e.message, 'error');
            } finally {
                checkbox.disabled = false;
            }
        });
    });
}
