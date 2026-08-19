// --- mainLetterhead.js: правая колонка — счета, налоги, бланк письма --------
//
// Всё, что здесь рисуется, правится СВОИМИ ОКНАМИ: на эту колонку режим
// правки формы организации не распространяется (правило макета).
//
// Бланк письма до сегодняшнего дня собирался автоматически из реквизитов и
// не правился вовсе. По макету у него своё окно с полями «Шапка» и
// «Подпись». Прежнее поведение сохранено как УМОЛЧАНИЕ: пока поля пусты,
// бланк собирается сам — иначе у всех, кто уже работает, он в один день стал
// бы пустым.

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Номер счёта в строке списка: начало и хвост, середина скрыта.
 * Двадцать цифр подряд в узкой колонке не читаются, а по первым и последним
 * счёт узнаётся — так и в макете.
 */
function maskAccount(value) {
    const digits = String(value || '').replace(/\s/g, '');
    if (digits.length <= 12) return digits;
    return `${digits.slice(0, 8)}…${digits.slice(-4)}`;
}

// ---------------------------------------------------------------- счета

export function renderAccounts(container, accounts) {
    const list = Array.isArray(accounts) ? accounts : [];

    if (!list.length) {
        container.innerHTML = `
            <div class="ui-empty ui-empty--inline">
                <div class="ui-empty__title">Счетов пока нет</div>
                <p class="ui-empty__text">Добавьте расчётный счёт — он подставляется в шапку документов и в реквизиты для оплаты.</p>
            </div>`;
        return;
    }

    // «Основной» — первый счёт организации. Отдельного признака в базе нет и
    // заводить его незачем: бланк письма и так берёт первый счёт, а окно счёта
    // в макете такого переключателя не содержит. Порядок задаётся сервером
    // (ORDER BY id), то есть порядком добавления.
    container.innerHTML = list.map((account, index) => `
        <div class="m-acct" data-account="${account.id}">
            <span class="m-acct-main">
                <span class="m-acct-bank">${escapeHtml(account.bankName)}</span>
                <span class="m-acct-num">${escapeHtml(maskAccount(account.checkingAccount))}${account.bik ? ` · БИК ${escapeHtml(account.bik)}` : ''}</span>
            </span>
            <span class="ui-pill ${index === 0 ? 'ui-pill--ok' : 'ui-pill--mute'}">${index === 0 ? 'Основной' : 'Резервный'}</span>
            <span class="m-acct-acts">
                <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-account-edit="${account.id}" title="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                <button type="button" class="ui-btn ui-btn--icon ui-btn--sm ui-btn--danger" data-account-del="${account.id}" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </span>
        </div>`).join('');
}

// ---------------------------------------------------------------- налоги

export function renderTaxes(container, taxes) {
    const list = Array.isArray(taxes) ? taxes : [];

    if (!list.length) {
        container.innerHTML = `
            <div class="ui-empty ui-empty--inline">
                <div class="ui-empty__title">Налоговых записей пока нет</div>
                <p class="ui-empty__text">Добавьте систему налогообложения — она нужна в договорах и счетах.</p>
            </div>`;
        return;
    }

    // Каждая запись — тремя парами «метка → значение», как в макете. Действия
    // строкой ниже: пар в записи три, и прятать их под наведение в колонке
    // шириной в треть панели значит прятать насовсем.
    container.innerHTML = list.map((tax) => `
        <div class="m-tax" data-tax="${tax.id}">
            <dl class="m-kv">
                <dt>Вид налога</dt><dd>${escapeHtml(tax.taxType)}</dd>
                <dt>Ставка</dt><dd class="m-mono${tax.rate ? '' : ' m-empty-val'}">${tax.rate ? escapeHtml(tax.rate) : 'не заполнено'}</dd>
                <dt>Периодичность</dt><dd class="${tax.periodicity ? '' : 'm-empty-val'}">${tax.periodicity ? escapeHtml(tax.periodicity) : 'не заполнено'}</dd>
            </dl>
            <div class="m-tax-acts">
                <button type="button" class="ui-btn ui-btn--icon ui-btn--sm" data-tax-edit="${tax.id}" title="Изменить"><i class="fas fa-pen" aria-hidden="true"></i></button>
                <button type="button" class="ui-btn ui-btn--icon ui-btn--sm ui-btn--danger" data-tax-del="${tax.id}" title="Удалить"><i class="fas fa-trash" aria-hidden="true"></i></button>
            </div>
        </div>`).join('');
}

// ---------------------------------------------------------------- бланк

/**
 * Текст бланка по умолчанию — из реквизитов организации. Ровно то, что
 * раздел показывал до появления окна: название, ИНН, юридический адрес.
 */
export function defaultLetterhead(organization) {
    const org = organization || {};
    const parts = [];
    const first = [org.name, org.inn ? `ИНН ${org.inn}` : ''].filter(Boolean).join(', ');
    if (first) parts.push(first);
    if (org.legalAddress) parts.push(org.legalAddress);
    return parts.join('\n');
}

export function defaultSignature(organization) {
    const org = organization || {};
    return org.generalDirector ? `Генеральный директор ${org.generalDirector}` : '';
}

export function renderLetterhead(container, organization) {
    const header = (organization && organization.letterheadHeader) || defaultLetterhead(organization);
    const signature = (organization && organization.letterheadSignature) || defaultSignature(organization);

    if (!header && !signature) {
        container.innerHTML = `
            <div class="ui-empty ui-empty--inline">
                <div class="ui-empty__title">Пока нечего показать</div>
                <p class="ui-empty__text">Бланк соберётся сам, как только будут заполнены название, ИНН и адрес организации.</p>
            </div>`;
        return;
    }

    container.innerHTML = `
        <div class="m-letterhead">${escapeHtml(header).replace(/\n/g, '<br>')}${signature ? `<br><span class="m-lh-sign">${escapeHtml(signature)}</span>` : ''}</div>
        <p class="m-note">Подставляется в документы, которые формирует CRM.</p>`;
}
