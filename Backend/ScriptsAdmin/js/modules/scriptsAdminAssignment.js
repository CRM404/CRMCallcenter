// --- scriptsAdminAssignment.js: назначение скрипта операторам (employee_scripts, многие-ко-многим) ---
// Один оператор теперь может вести сразу несколько скриптов (разные линии) —
// employees.script_id больше нет, связь — employee_scripts (employeeId, scriptId).
// Ограничение "нельзя назначить черновик" снято (решение владельца, 2026-08-05) —
// операторов назначают до активации скрипта, статус скрипта тут ни при чём.

import { addScriptToEmployee, removeScriptFromEmployee } from './scriptsAdminStorage.js';
import { showToast } from './scriptsAdminToast.js';
import { askReassignChoice } from './scriptsAdminReassignModal.js';

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
export function renderAssignmentPanel(container, script, employees, onChanged) {
    if (!employees.length) {
        container.innerHTML = '<h2>Операторы</h2><div class="sa-empty-state">Нет сотрудников в системе.</div>';
        return;
    }

    const assigned = employees.filter((emp) => emp.scriptIds.includes(script.id));
    const available = employees.filter((emp) => !emp.scriptIds.includes(script.id));

    const selectOptions = available.map((emp) => {
        const note = emp.scriptIds.length ? ' (есть другие скрипты — уточним при выборе)' : '';
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
        <div class="form-group" style="max-width:320px;">
            <label for="saAssignSelect">Назначить оператора</label>
            <select id="saAssignSelect" ${available.length ? '' : 'disabled'}>
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
        const employee = available.find((emp) => emp.id === employeeId);
        select.disabled = true;

        try {
            if (employee.scriptIds.length > 0) {
                const choice = await askReassignChoice(
                    `У оператора «${employeeFullName(employee)}» уже есть назначенные скрипты. Что сделать?`
                );
                if (choice === 'cancel') {
                    select.value = '';
                    select.disabled = false;
                    return;
                }
                if (choice === 'replace') {
                    for (const oldScriptId of employee.scriptIds) {
                        await removeScriptFromEmployee(employeeId, oldScriptId);
                    }
                }
            }
            await addScriptToEmployee(employeeId, script.id);
            showToast('Скрипт назначен', 'success');
            onChanged();
        } catch (e) {
            showToast(e.message, 'error');
            select.value = '';
            select.disabled = false;
        }
    });

    container.querySelectorAll('[data-action="remove"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const employeeId = Number(btn.dataset.id);
            btn.disabled = true;
            try {
                await removeScriptFromEmployee(employeeId, script.id);
                showToast('Назначение снято', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
                btn.disabled = false;
            }
        });
    });
}
