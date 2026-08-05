// --- operatorLeadList.js: список своих лидов (первое состояние "Рабочего стола") ---

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('ru-RU');
}

function leadFullName(lead) {
    const parts = [lead.lastName, lead.firstName, lead.middleName].filter(Boolean);
    return parts.length ? parts.join(' ') : '—';
}

// statusesById: Map<id, {statusName, stageName}>
export function renderLeadList(container, leads, statusesById, onSelectLead) {
    if (!leads.length) {
        container.innerHTML = '<div class="op-empty-state">Нет лидов</div>';
        return;
    }

    const rows = leads.map((lead) => {
        const status = statusesById.get(lead.funnelStatusId);
        const statusLabel = status ? escapeHtml(status.statusName) : '—';
        return `
            <tr data-lead-id="${lead.id}">
                <td>${escapeHtml(leadFullName(lead))}</td>
                <td>${escapeHtml(lead.phone)}</td>
                <td>${statusLabel}</td>
                <td>${formatDate(lead.createdAt)}</td>
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <table class="op-lead-table">
            <thead>
                <tr>
                    <th>ФИО</th>
                    <th>Телефон</th>
                    <th>Статус</th>
                    <th>Создан</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    container.querySelectorAll('tbody tr').forEach((tr) => {
        tr.addEventListener('click', () => onSelectLead(Number(tr.dataset.leadId)));
    });
}
