// --- scriptsAdminScriptList.js: таблица скриптов (черновики + активные) ---
// Колонки: Скрипт (название + подстрока наполненности) / Статус / Действия.
// Колонки «Операторов» больше нет — ручная привязка операторов к скриптам
// отменена, скрипт назначается лиду на странице «Лиды». «Удалить» по той же
// причине больше ничем не блокируется: у лидов привязка обнуляется сама
// (ON DELETE SET NULL), подтверждено владельцем вместе с макетом.

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

function pluralObjections(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} возражение`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} возражения`;
    return `${count} возражений`;
}

// Подстрока наполненности — единственное добавление сверх прежней
// функциональности: показывает уже существующие данные (агрегаты приходят из
// GET /api/admin/scripts одним JOIN, без N+1 запросов отсюда).
function fillSummary(script) {
    const parts = [];
    if (script.hasMainText) parts.push('основной текст');
    if (script.objectionsCount > 0) parts.push(pluralObjections(script.objectionsCount));
    return parts.length ? parts.join(' · ') : 'Пока не наполнен';
}

// onOpen(script) — открыть панель наполнения; onChanged() — перезагрузить список.
export function renderScriptList(container, scripts, selectedId, onOpen, onChanged) {
    if (!scripts.length) {
        container.innerHTML = '<div class="sa-empty-state" style="padding:40px 20px; text-align:center;">Пока нет ни одного скрипта — создайте первый.</div>';
        return;
    }

    const rows = scripts.map((script) => {
        const chip = script.status === 'active'
            ? '<span class="status-chip active">Активен</span>'
            : '<span class="status-chip draft">Черновик</span>';
        const statusToggleBtn = script.status === 'draft'
            ? `<button type="button" class="btn btn-ghost btn-sm" data-action="activate" data-id="${script.id}">Активировать</button>`
            : `<button type="button" class="btn btn-ghost btn-sm" data-action="deactivate" data-id="${script.id}">В черновик</button>`;

        return `
            <tr class="${script.id === selectedId ? 'sa-selected' : ''}" data-row-id="${script.id}">
                <td>
                    <div class="script-title">${escapeHtml(script.title)}</div>
                    <div class="script-sub">${escapeHtml(fillSummary(script))}</div>
                </td>
                <td>${chip}</td>
                <td class="col-actions">
                    <div class="sa-actions">
                        <button type="button" class="btn btn-ghost btn-sm" data-action="open" data-id="${script.id}">Открыть</button>
                        ${statusToggleBtn}
                        <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${script.id}">Удалить</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table>
            <thead>
                <tr><th>Скрипт</th><th>Статус</th><th class="col-actions">Действия</th></tr>
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

    container.querySelectorAll('[data-action="activate"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            const ok = await confirmAction(`Активировать скрипт «${script.title}»? Он станет доступен для выбора на странице «Лиды».`);
            if (!ok) return;
            try {
                await updateScript(script.id, { title: script.title, status: 'active' });
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
            const ok = await confirmAction(`Вернуть скрипт «${script.title}» в черновик? Он пропадёт из выбора на «Лидах»; у лидов, где он уже назначен, ничего не изменится.`);
            if (!ok) return;
            try {
                await updateScript(script.id, { title: script.title, status: 'draft' });
                showToast('Скрипт переведён в черновик', 'success');
                onChanged();
            } catch (e) {
                showToast(e.message, 'error');
            }
        });
    });

    container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const script = scripts.find((s) => s.id === Number(btn.dataset.id));
            const ok = await confirmAction(`Удалить скрипт «${script.title}» вместе с основным текстом и возражениями? У лидов, где он был назначен, поле скрипта очистится. Это необратимо.`);
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
