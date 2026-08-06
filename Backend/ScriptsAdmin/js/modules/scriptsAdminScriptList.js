// --- scriptsAdminScriptList.js: таблица скриптов (черновики + активные) ---

import { updateScript, deleteScript } from './scriptsAdminStorage.js';
import { confirmAction } from './scriptsAdminConfirm.js';
import { showToast } from './scriptsAdminToast.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// onOpen(script) — открыть работу с узлами/назначением; onEdit(script) — открыть форму
// редактирования названия/оффера; onChanged() — перезагрузить список после действия.
export function renderScriptList(container, scripts, selectedId, onOpen, onEdit, onChanged) {
    if (!scripts.length) {
        container.innerHTML = '<div class="sa-empty-state">Пока нет ни одного скрипта — создайте первый.</div>';
        return;
    }

    const rows = scripts.map((script) => {
        const badge = script.status === 'active'
            ? '<span class="badge active">Активный</span>'
            : '<span class="badge draft">Черновик</span>';
        const isSelected = script.id === selectedId;
        const statusToggleBtn = script.status === 'draft'
            ? `<button type="button" class="btn btn-success btn-sm" data-action="activate" data-id="${script.id}">Активировать</button>`
            : `<button type="button" class="btn btn-secondary btn-sm" data-action="deactivate" data-id="${script.id}">Вернуть в черновик</button>`;
        const isAssigned = script.assignedCount > 0;
        const deleteBtn = !isAssigned
            ? `<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${script.id}">Удалить</button>`
            : `<button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${script.id}" disabled title="Скрипт назначен ${script.assignedCount} оператор(ам) — сначала снимите назначение">Удалить</button>`;

        return `
            <tr class="${isSelected ? 'sa-selected' : ''}" data-row-id="${script.id}">
                <td>${escapeHtml(script.title)}</td>
                <td>${badge}</td>
                <td>${escapeHtml(script.offerName) || '—'}</td>
                <td>${escapeHtml(script.funnelStatusName) || '—'}</td>
                <td>${script.assignedCount === null ? '—' : script.assignedCount}</td>
                <td>
                    <div class="sa-actions">
                        <button type="button" class="btn btn-secondary btn-sm" data-action="open" data-id="${script.id}">Открыть</button>
                        <button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${script.id}">Изменить</button>
                        ${statusToggleBtn}
                        ${deleteBtn}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="sa-script-table">
            <thead>
                <tr><th>Название</th><th>Статус</th><th>Оффер</th><th>Статус воронки</th><th>Операторов</th><th>Действия</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    container.querySelectorAll('[data-action="open"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            onOpen(script);
        });
    });

    container.querySelectorAll('[data-action="edit"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            onEdit(script);
        });
    });

    container.querySelectorAll('[data-action="activate"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            const ok = await confirmAction(`Активировать скрипт «${script.title}»? После этого его можно будет назначать операторам.`);
            if (!ok) return;
            try {
                await updateScript(script.id, { title: script.title, status: 'active', offerId: script.offerId, funnelStatusId: script.funnelStatusId });
                showToast('Скрипт активирован', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });

    container.querySelectorAll('[data-action="deactivate"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            const ok = await confirmAction(`Вернуть скрипт «${script.title}» в черновик? Уже назначенные операторы продолжат его видеть — статус только запрещает НОВЫЕ назначения.`);
            if (!ok) return;
            try {
                await updateScript(script.id, { title: script.title, status: 'draft', offerId: script.offerId, funnelStatusId: script.funnelStatusId });
                showToast('Скрипт переведён в черновик', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });

    container.querySelectorAll('[data-action="delete"]:not(:disabled)').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            const ok = await confirmAction(`Удалить скрипт «${script.title}» вместе со всеми узлами? Это необратимо.`);
            if (!ok) return;
            try {
                await deleteScript(script.id);
                showToast('Скрипт удалён', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });
}
