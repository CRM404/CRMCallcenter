// --- scriptsAdminOffers.js: список офферов (просмотр + добавление, без редактирования/удаления) ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function renderOffersList(container, offers) {
    if (!offers.length) {
        container.innerHTML = '<div class="sa-empty-state">Пока нет ни одного оффера.</div>';
        return;
    }
    container.innerHTML = `<ul class="sa-offers-list">${offers.map((o) => `<li>${escapeHtml(o.name)}</li>`).join('')}</ul>`;
}
