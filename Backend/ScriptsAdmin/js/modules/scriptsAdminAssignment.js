// --- scriptsAdminAssignment.js: назначение скрипта операторам (employees.script_id) ---
// Один скрипт может быть назначен нескольким операторам; у оператора — ровно один
// скрипт, поэтому выбор в выпадающем списке просто перезаписывает employees.script_id.

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
// (иначе от старого назначения не избавиться, не активируя скрипт заново).
// Поэтому список "выбранных" с кнопкой снятия показывается всегда; для черновика
// заблокирован только сам выпадающий список (новых добавить нельзя).
export function renderAssignmentPanel(container, script, employees, onChanged) {
    if (!employees.length) {
        container.innerHTML = '<h2>Операторы</h2><div class="sa-empty-state">Нет сотрудников в системе.</div>';
        return;
    }

    const isDraft = script.status !== 'active';
    const assigned = employees.filter((emp) => emp.scriptId === script.id);
    const available = employees.filter((emp) => emp.scriptId !== script.id);

    const draftNote = isDraft
        ? '<p class="sa-empty-state" style="text-align:left; padding:0 0 12px;">Скрипт сейчас черновик — новых операторов назначить нельзя (активируйте скрипт), но уже назначенных можно снять.</p>'
        : '';

    const selectDisabled = isDraft || !available.length;
    const selectOptions = available.map((emp) => {
        const note = emp.scriptId ? ' (уже назначен на другой скрипт — переключится на этот)' : '';
        return `<option value="${emp.id}">${escapeHtml(employeeFullName(emp))}${note}</option>`;
    }).join('');

    const selectedRows = assigned.length
        ? assigned.map((emp) => `
            <div class="sa-selected-row" data-employee-id="${emp.id}">
                <span>${escapeHtml(employeeFullName(emp))}</span>
                <button type="button" class="btn btn-danger btn-sm" data-action="remove" data-id="${emp.id}">&times;</button>
            </div>
        `).join('')
        : '<div class="sa-empty-state">Пока никто не назначен.</div>';

    container.innerHTML = `
        <h2>Операторы, использующие этот скрипт</h2>
        ${draftNote}
        <div class="form-group" style="max-width:320px;">
            <label for="saAssignSelect">Назначить оператора</label>
            <select id="saAssignSelect" ${selectDisabled ? 'disabled' : ''}>
                <option value="">${available.length ? '— выберите —' : 'Нет доступных сотрудников'}</option>
                ${selectOptions}
            </select>
        </div>
        <div class="sa-assign-selected-list">${selectedRows}</div>
    `;

    const select = container.querySelector('#saAssignSelect');
    select.addEventListener('change', async () => {
        if (!select.value) return;
        const employeeId = Number(select.value);
        select.disabled = true;
        try {
            await assignScriptToEmployee(employeeId, script.id);
            showToast('Скрипт назначен', 'success');
            onChanged();
        } catch (e) {
            showToast(e.message, 'error');
            select.value = '';
            select.disabled = selectDisabled;
        }
    });

    container.querySelectorAll('[data-action="remove"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const employeeId = Number(btn.dataset.id);
            btn.disabled = true;
            try {
                await assignScriptToEmployee(employeeId, null);
                showToast('Назначение снято', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
                btn.disabled = false;
            }
        });
    });
}
