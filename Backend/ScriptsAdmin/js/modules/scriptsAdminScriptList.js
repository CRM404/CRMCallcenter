import { plural } from '/plural.js';

// --- scriptsAdminScriptList.js: таблица скриптов (черновики + активные) ---
// Колонки: Скрипт (название + подстрока наполненности) / Статус / Действия.
// Колонки «Операторов» больше нет — ручная привязка операторов к скриптам
// отменена, скрипт назначается лиду на странице «Лиды». «Удалить» по той же
// причине больше ничем не блокируется: у лидов привязка обнуляется сама
// (ON DELETE SET NULL), подтверждено владельцем вместе с макетом.
//
// ЧТО ИЗМЕНИЛОСЬ ПРИ ПЕРЕЕЗДЕ В ОБОЛОЧКУ: модуль только рисует строки и ничего
// не знает ни про запросы, ни про подтверждения, ни про тосты — раньше он сам
// дёргал storage, confirmAction и showToast и вешал слушатель на каждую кнопку.
// Теперь клики ловит раздел одним делегированием на своём контейнере: при
// перерисовке списка не нужно снимать десятки слушателей, а раздел остаётся
// единственным местом, которое ходит в API.

export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Кавычки — обязательно: значения попадают в атрибуты (value="…",
        // title="…"), и без этого название с кавычкой обрывало разметку.
        // На прежней странице этого не было видно: там значения присваивались
        // через .value, а не собирались строкой.
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function pluralObjections(count) {
    return `${count} ${plural(count, 'возражение', 'возражения', 'возражений')}`;
}

// Подстрока наполненности показывает уже существующие данные: агрегаты
// приходят из GET /api/admin/scripts одним JOIN, без N+1 запросов отсюда.
function fillSummary(script) {
    const parts = [];
    if (script.hasMainText) parts.push('основной текст');
    if (script.objectionsCount > 0) parts.push(pluralObjections(script.objectionsCount));
    return parts.length ? parts.join(' · ') : 'Пока не наполнен';
}

/** Разметка строк таблицы. Клики ловит раздел по data-action / data-id. */
export function renderScriptRows(scripts, selectedId) {
    return scripts.map((script) => {
        const chip = script.status === 'active'
            ? '<span class="ui-pill ui-pill--ok">Активен</span>'
            : '<span class="ui-pill ui-pill--mute">Черновик</span>';
        const statusToggleBtn = script.status === 'draft'
            ? `<button type="button" class="ui-btn ui-btn--ghost" data-action="activate" data-id="${script.id}">Активировать</button>`
            : `<button type="button" class="ui-btn ui-btn--ghost" data-action="deactivate" data-id="${script.id}">В черновик</button>`;

        return `
            <tr class="${script.id === selectedId ? 'ui-table__row--selected' : ''}" data-row-id="${script.id}">
                <td>
                    <div class="scr-title">${escapeHtml(script.title)}</div>
                    <div class="scr-sub">${escapeHtml(fillSummary(script))}</div>
                </td>
                <td>${chip}</td>
                <td class="ui-table__acts">
                    <button type="button" class="ui-btn ui-btn--ghost" data-action="open" data-id="${script.id}">Открыть</button>
                    ${statusToggleBtn}
                    <button type="button" class="ui-btn ui-btn--icon ui-btn--danger ui-btn--row" data-action="delete" data-id="${script.id}" title="Удалить" aria-label="Удалить"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-trash"></use></svg></button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Тексты подтверждений. ЗАГОЛОВОК СПРАШИВАЕТ, ТЕКСТ НАЗЫВАЕТ ПОСЛЕДСТВИЯ
 * (К161) — раньше текст дословно повторял заголовок («Активировать скрипт?» →
 * «Активировать скрипт «X»?»), и вопрос, заданный дважды, занимал место
 * последствия. То же правило уже применялось к окну закрытия в К92.
 */
export const CONFIRM_TEXTS = {
    activate: (title) => `Скрипт «${title}» станет доступен для выбора на странице «Лиды».`,
    deactivate: () => 'Он пропадёт из выбора на «Лидах»; у лидов, где он уже назначен, ничего не изменится.',
    remove: (title) => `Скрипт «${title}» будет удалён вместе с основным текстом и возражениями. У лидов, где он был назначен, поле скрипта очистится. Это необратимо.`
};
