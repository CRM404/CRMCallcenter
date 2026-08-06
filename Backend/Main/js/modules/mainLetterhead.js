// --- mainLetterhead.js: сводка заполненности организации (кольцо в шапке) +
// предпросмотр "Летерхед" (как реквизиты организации/банка увидят в
// формируемом счёте). Обе части — производные от того же объекта
// organization, что и форма в mainRequisites.js, обновляются вместе с ним
// (после успешного save/create), не в реальном времени по каждому вводу.

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Те же 11 полей, что ORG_GENERAL_FIELDS + ORG_LEGAL_FIELDS в mainRequisites.js
// (продублировано намеренно — отдельный модуль, без общего импорта ради
// простоты; порядок/состав держать в синхроне при добавлении новых полей).
const COMPLETION_FIELDS = [
    'name', 'legalForm', 'generalDirector', 'registrationCountry', 'registrationDate', 'legalAddress',
    'inn', 'kpp', 'ogrn', 'okved', 'authorizedCapital'
];

export function renderCompletion(container, organization) {
    const org = organization || {};
    const filled = COMPLETION_FIELDS.filter((key) => org[key] !== null && org[key] !== undefined && org[key] !== '').length;
    const total = COMPLETION_FIELDS.length;
    const percent = Math.round((filled / total) * 100);
    container.innerHTML = `
        <div class="m-completion-ring" style="background: conic-gradient(var(--m-good) 0 ${percent}%, var(--m-line-soft) ${percent}% 100%)"></div>
        <div class="m-completion-text"><b>${filled} из ${total}</b><span>заполнено</span></div>
    `;
}

function renderLetterheadRow(label, value) {
    if (!value) return '';
    return `<div><b>${escapeHtml(label)}</b>${escapeHtml(value)}</div>`;
}

export function renderPreview(container, organization) {
    if (organization === null) {
        container.innerHTML = `
            <div class="m-preview-tag">Так это увидят в счёте</div>
            <div class="m-letterhead">
                <div class="m-empty-state">Появится после заполнения организации.</div>
            </div>
        `;
        return;
    }

    const org = organization;
    const bank = org.bankAccounts && org.bankAccounts[0];

    container.innerHTML = `
        <div class="m-preview-tag">Так это увидят в счёте</div>
        <div class="m-letterhead">
            <div class="m-lh-name">${escapeHtml(org.name)}</div>
            <div class="m-lh-form">Действует на основании Устава</div>
            <div class="m-lh-ids">
                ${renderLetterheadRow('ИНН', org.inn)}
                ${renderLetterheadRow('КПП', org.kpp)}
                ${renderLetterheadRow('ОГРН', org.ogrn)}
            </div>
            ${org.legalAddress ? `<div class="m-lh-addr">${escapeHtml(org.legalAddress)}</div>` : ''}
            <div class="m-lh-rule"></div>
            <div class="m-lh-sub">Банковские реквизиты</div>
            ${bank ? `
                <div class="m-lh-bank">${escapeHtml(bank.bankName)}</div>
                <div class="m-lh-bank-rows">
                    ${renderLetterheadRow('Р/с', bank.checkingAccount)}
                    ${renderLetterheadRow('БИК', bank.bik)}
                </div>
            ` : '<div class="m-lh-bank-empty">Банковские реквизиты ещё не добавлены.</div>'}
        </div>
        <div class="m-lh-foot">Обновится автоматически при сохранении формы слева.</div>
    `;
}
