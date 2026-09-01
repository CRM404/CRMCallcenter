// --- operatorLeadForm.js: карточка клиента (лид) — форма редактирования ---
// Состав, порядок и раскладка — по согласованному владельцем макету
// дизайн-сессии (report_designer.md, версия «script-order», 14.08.2026).
//
// ПОРЯДОК ПОЛЕЙ — ТРЕБОВАНИЕ, А НЕ ОФОРМЛЕНИЕ. Владелец перечислил поля как
// последовательность вопросов оператора в разговоре, и первая редакция макета,
// сгруппированная «по смыслу», была им отклонена. Два места выглядят
// непривычно и переставлять их нельзя:
//   • «Срок покупки» стоит в секции «Клиент», сразу за ЛПР, — его спрашивают
//     в начале разговора, а не вместе с оплатой;
//   • «Вид клиента» стоит ПОСЛЕ «Способа покупки» — чекбокс «иной заёмщик»
//     зависит от обоих полей, и при обратном порядке оператор, выбрав ипотеку
//     ниже, был бы вынужден возвращаться вверх к появившемуся чекбоксу.
// По той же причине лесенка разрезана по границе «География | Бюджет»: ни один
// каскад не попадает на стык ступеней.

import { initGeoBlocks } from './operatorGeo.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

// Пометка «— автоперезвон» берётся из НАСТРОЙКИ, а не из названия статуса и уже
// не из флага колонки. Сравнение строк вида «Недоступен» сломалось бы молча от
// одного пробела; а колонка `auto_recall` заморожена заходом 2 и соврала бы в
// обе стороны — у статуса с флагом правила может не быть вовсе, а у нового
// статуса флага не будет никогда, хотя правило ему заведут. Оператор должен
// видеть, что после такого статуса лид вернётся в очередь сам, — и видит он это
// тогда и только тогда, когда система действительно перезвонит.
// ⚠ СИСТЕМНЫХ СТАТУСОВ ЗДЕСЬ НЕТ (заход 6). Их ставит система, а не человек:
// «Нет результата» — когда время пост-обработки вышло, «Не ответил после N
// перезвонов» — когда исчерпан предел попыток. Владелец подтвердил прямо:
// оператор поставить их не может.
//
// ТЕКУЩИЙ СТАТУС — ИСКЛЮЧЕНИЕ, и по той же причине, что в карточке лида: у лида
// с системным статусом поле осталось бы пустым, а сохранение обнулило бы статус
// молча. Оператору такой лид не достаётся вовсе — он выпал из очереди, — но
// правило одно на оба экрана, и второго прочтения быть не должно.
function buildFunnelStatusOptions(statuses, selectedId) {
    const byStage = new Map();
    statuses.filter((s) => !s.isSystem || s.id === selectedId).forEach((s) => {
        if (!byStage.has(s.stageNumber)) byStage.set(s.stageNumber, { stageName: s.stageName, items: [] });
        byStage.get(s.stageNumber).items.push(s);
    });
    const stageNumbers = Array.from(byStage.keys()).sort((a, b) => a - b);
    const groups = stageNumbers.map((num) => {
        const { stageName, items } = byStage.get(num);
        const options = items.map((s) => `
            <option value="${s.id}" data-call-time="${s.requiresCallTime ? '1' : ''}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.statusName)}${s.recallMaxAttempts !== null && s.recallMaxAttempts !== undefined ? ' — автоперезвон' : ''}</option>
        `).join('');
        return `<optgroup label="${escapeHtml(`${num}. ${stageName}`)}">${options}</optgroup>`;
    }).join('');
    return `<option value="">— не выбран —</option>${groups}`;
}

function pad(value) {
    return String(value).padStart(2, '0');
}

// Значение для <input type="datetime-local"> — в ЛОКАЛЬНОМ времени оператора:
// он говорит клиенту «наберу через час», глядя на свои часы (dialog.md G6).
// Приведение к поясу приложения делает сервер.
function toLocalInputValue(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Значение, сохранённое у лида, но отсутствующее в справочнике (владелец удалил
// или лид заведён до появления списка), показывается ОТДЕЛЬНЫМ пунктом с
// пометкой — первым после пустого (dialog.md C1/C2).
// Почему не «как у офферов»: там такого поведения нет. Проверено — селект
// оффера при значении вне списка подставляет ПЕРВОЕ значение справочника, и
// следующее сохранение пишет подмену в базу; админская карточка лида в том же
// случае даёт пустую строку и обнуляет поле. Оба варианта теряют данные молча.
function buildOptions(values, selected, emptyLabel) {
    const list = values || [];
    const saved = selected === null || selected === undefined ? '' : String(selected);
    const options = [`<option value="">${escapeHtml(emptyLabel || '— не выбрано —')}</option>`];
    if (saved && !list.includes(saved)) {
        options.push(`<option value="${escapeHtml(saved)}" selected>${escapeHtml(saved)} — вне списка</option>`);
    }
    list.forEach((value) => {
        options.push(`<option value="${escapeHtml(value)}"${value === saved ? ' selected' : ''}>${escapeHtml(value)}</option>`);
    });
    return options.join('');
}

function textField(key, label, lead, type) {
    return `
        <div class="form-group">
            <label for="op-field-${key}">${escapeHtml(label)}</label>
            <input id="op-field-${key}" name="${key}" type="${type || 'text'}" value="${escapeHtml(lead[key])}">
        </div>
    `;
}

function selectField(key, label, values, lead, emptyLabel, hint) {
    const hintHtml = hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : '';
    return `
        <div class="form-group">
            <label for="op-field-${key}">${escapeHtml(label)}${hintHtml}</label>
            <select id="op-field-${key}" name="${key}">${buildOptions(values, lead[key], emptyLabel)}</select>
        </div>
    `;
}

// Пара «от — до»: два поля базы под одной подписью, подпись по центру над
// обеими ячейками, занимает две колонки из трёх.
function rangePair(label, hint, fromKey, toKey, lead) {
    return `
        <div class="form-group centered span-2">
            <label>${escapeHtml(label)} <span class="hint">${escapeHtml(hint)}</span></label>
            <div class="range-pair">
                <input id="op-field-${fromKey}" name="${fromKey}" type="number" value="${escapeHtml(lead[fromKey])}" placeholder="от" aria-label="${escapeHtml(label)} от">
                <span class="sep">—</span>
                <input id="op-field-${toKey}" name="${toKey}" type="number" value="${escapeHtml(lead[toKey])}" placeholder="до" aria-label="${escapeHtml(label)} до">
            </div>
        </div>
    `;
}

const GEO_LEVELS = [
    { level: 'region', label: 'Регион' },
    { level: 'city', label: 'Город' },
    { level: 'district', label: 'Район' },
    { level: 'locality', label: 'Населённый пункт' }
];

// prefix: '' — адрес объекта (region/city/...), 'client' — адрес клиента
// (clientRegion/clientCity/...). Разметка одинаковая, различаются только ключи.
function geoFieldKey(prefix, level) {
    return prefix ? prefix + level.charAt(0).toUpperCase() + level.slice(1) : level;
}

function geoBlock(title, prefix, lead) {
    const fields = GEO_LEVELS.map(({ level, label }) => {
        const key = geoFieldKey(prefix, level);
        return `
            <div class="form-group">
                <label for="op-field-${key}">${label}</label>
                <div class="geo-field">
                    <input id="op-field-${key}" name="${key}" type="text" data-geo-level="${level}"
                           value="${escapeHtml(lead[key])}" placeholder="Начните вводить…" autocomplete="off">
                </div>
            </div>
        `;
    }).join('');
    return `
        <div class="geo-block">
            <div class="geo-block-title"><i class="fas fa-location-dot" aria-hidden="true"></i>${escapeHtml(title)}</div>
            <div class="geo-grid">${fields}</div>
        </div>
    `;
}

// Ключи полей по ступеням лесенки. Разбиение нужно не только для сбора данных
// на сохранение, но и для автораскрытия: ступень раскрывается, если непусто
// хоть одно ЕЁ поле. otherBorrower собирается отдельно — он трёхзначный и
// зависит от каскада.
const GEO_KEYS = GEO_LEVELS.map((g) => g.level).concat(GEO_LEVELS.map((g) => geoFieldKey('client', g.level)));
const ALWAYS_VISIBLE_KEYS = [
    'phone', 'lastName', 'firstName', 'middleName', 'decisionMaker', 'purchaseTimeframe',
    // `notes` ЗДЕСЬ БОЛЬШЕ НЕТ: старое поле не собирается и не отправляется —
    // править его нечем, потому что его нет на экране. На его месте `comment` —
    // НОВАЯ запись ленты, а не значение поля.
    'comment', 'funnelStatusId'
];
const PARAMS_KEYS = [
    'priceFrom', 'priceTo', 'purchaseMethod', 'downPaymentPercent', 'mortgageType', 'clientType',
    'category', 'propertyType', 'propertyClass', 'roomCount', 'areaFrom', 'areaTo', 'finish', 'deliveryDeadline'
];
const FIELD_KEYS = [...ALWAYS_VISIBLE_KEYS, ...GEO_KEYS, ...PARAMS_KEYS];

// Каскады — та же логика, что в форме оффера (cpaApp.js), включая нестрогое
// сравнение по подстроке: значение могли переименовать через «Настройку
// списков», и строгое равенство перестало бы срабатывать молча.
const DOWN_PAYMENT_WORDS = ['ипотек', 'материнск', 'рассрочк'];
const RETIREE_VALUE = 'Пенсионер';

// Плашка под полем «Телефон»: номер лида не приведён к единому виду (часть 4,
// паспорт Р10, тексты дословно).
//
// СТОИТ ЗДЕСЬ, А НЕ В СПИСКЕ, И ЭТО ВАЖНЕЕ ЗНАКА В СПИСКЕ. Оператор списка не
// видит вовсе — он получает лида карточкой. Решением владельца 65 неразобранный
// лид попадает в раздачу, включая безнадёжных, значит плашка — единственное,
// что стоит между человеком и набором номера, которого нет.
// ДВЕ ЧАСТИ, А НЕ ОДИН АБЗАЦ (К178, приёмка дизайн-сессии). Первая фраза —
// вердикт, остальное — что с ним делать. Сплошной мелкий текст читается как
// оговорка и пропускается, а плашку читают за секунду до набора. Узла
// .ui-note__title здесь нет — страница оператора живёт вне слоя, — поэтому
// заголовок выделяется полужирным.
//
// Это второй такой случай подряд (первый — К173 в части 1Б, тело окна одним
// абзацем): «что случилось» и «что делать» держим двумя частями всегда, даже
// когда узел слоя недоступен.
const PHONE_NOTES = {
    hopeless: {
        title: 'По этому номеру дозвониться не выйдет',
        text: 'В базе он записан неполностью, и восстановить его не удалось. Времени на набор не тратьте.'
    },
    unresolved: {
        title: 'Номер записан не в едином виде',
        text: 'Набирайте как есть. Если не дозвонитесь — скажите руководителю, номер разберут.'
    }
};

function phoneNote(lead) {
    // Строго false: у лида, заведённого до части 4, поле приходит пустым, и
    // плашка там сказала бы о номере то, чего никто не проверял.
    if (lead.phoneNormalized !== false) return '';
    const note = lead.phoneFixVerdict === 'hopeless' ? PHONE_NOTES.hopeless : PHONE_NOTES.unresolved;
    return '<div class="op-phone-note"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>' +
        `<span><b>${escapeHtml(note.title)}.</b> ${escapeHtml(note.text)}</span></div>`;
}

function needsDownPayment(paymentMethod) {
    const value = (paymentMethod || '').toLowerCase();
    return DOWN_PAYMENT_WORDS.some((word) => value.includes(word));
}

function isMortgage(paymentMethod) {
    return (paymentMethod || '').toLowerCase().includes('ипотек');
}

function hasAnyValue(container, keys) {
    return keys.some((key) => {
        const el = container.querySelector(`#op-field-${key}`);
        return el && String(el.value).trim() !== '';
    });
}

// Порог, с которого бейдж попыток становится жёлтым: оператор, взявший лида на
// последних попытках, обязан понимать, что это последний шанс, иначе потратит
// на него столько же усилий, сколько на свежий.
//
// ПОРОГ ПРОИЗВОДНЫЙ ОТ ПРЕДЕЛА, А НЕ СВОЁ ЧИСЛО (часть 9, заход 3, ловушка 2
// наряда). Раньше здесь стояли двадцать и пятнадцать, и предел был копией
// серверного: поставил бы руководитель семь — сервер переключил бы статус на
// седьмой попытке, а оператор читал бы «из 20». Предел теперь приезжает со
// статусом, а порог считается от него.
//
// ТРИ ЧЕТВЕРТИ, А НЕ «ПРЕДЕЛ МИНУС ПЯТЬ». На двадцати обе формулы дают
// пятнадцать — то есть день выкатки не меняется ни на единицу. Дальше они
// расходятся, и «минус пять» рассыпается: при пределе пять оно даёт ноль, то
// есть жёлтый с первой попытки, а при пределе три — минус два.
const ATTEMPTS_WARN_SHARE = 0.75;

export function warnFrom(limit) {
    return Math.ceil(limit * ATTEMPTS_WARN_SHARE);
}

/**
 * Предел попыток у выбранного статуса — или null, если система по нему не
 * перезванивает: правила нет либо событие целиком не годно к работе.
 *
 * ПУСТО ПРОВЕРЯЕТСЯ ОТДЕЛЬНО, А НЕ ЧЕРЕЗ Number(). `Number(null)` — это ноль, и
 * `Number.isFinite` его пропускает: экран показывал «Попытка 5 из 0» и «после
 * 0-й лид уйдёт в статус «null»» на любом статусе без правила. Поймано на живом
 * экране; чтением кода не нашлось.
 *
 * Вынесена наружу ради проверки: ошибка тихая, и мерить её надо набором, а не
 * глазами.
 */
export function recallLimitOf(status) {
    if (!status) return null;
    const raw = status.recallMaxAttempts;
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// options.flash = true — карточку только что подменили после сохранения:
// над ней на две секунды появляется полоса «Новый лид № …». Смена собеседника
// обязана быть заметна боковым зрением.
// ----- Лента комментариев (Б4.3, паспорт Р3 редакции 3) ---------------------
//
// ТЕКСТЫ ДОСЛОВНО ИЗ ПАСПОРТА. Собирать их по месту нельзя: текст, набранный
// дважды, расходится на первой же правке.
const FEED = {
    label: 'Добавить комментарий',
    placeholder: 'Что сказал клиент в этом разговоре',
    hint: 'Запись сохранится вместе с карточкой и станет частью ленты. Изменить её потом будет нельзя.',
    empty: 'Комментариев пока нет — этот разговор первый.',
    author: 'система',
    noTime: 'время неизвестно',
    collapse: 'Свернуть',
    noAnswer: 'недозвон'
};

// ТРИ ВИДИМЫЕ ЗАПИСИ — ПРАВИЛО ПОКАЗА, А НЕ РАЗМЕР. Оператор читает ленту за
// секунды до звонка, а не изучает её: прошлый разговор, позапрошлый и тот, где
// договорились. Дальше начинается история, а история — работа руководителя.
const FEED_VISIBLE = 3;

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/**
 * Когда написана запись: «сегодня, 16:04» · «вчера, 16:04» · «22 августа, 09:48».
 *
 * ПЕРВЫЕ ДВА ДНЯ СЛОВАМИ, дальше числом и месяцем. Год не пишется вовсе: лента
 * коротка по устройству, а «22 августа 2026» рядом с «вчера» читается как две
 * разные шкалы.
 */
function commentWhen(iso) {
    if (!iso) return FEED.noTime;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return FEED.noTime;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const days = Math.floor((midnight.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return `сегодня, ${time}`;
    if (days === 1) return `вчера, ${time}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

/**
 * Отсылка к звонку: «к звонку 16:04 · 4:12», при недозвоне — «к звонку 10:15 ·
 * недозвон».
 *
 * СОБИРАЕТСЯ ЗДЕСЬ, А НЕ НА СЕРВЕРЕ. В карточке оператора это ПОДПИСЬ: вкладки
 * звонков у него нет, и вести отсюда некуда. В карточке лида у руководителя та
 * же запись станет ссылкой — готовая фраза с сервера мешала бы второму.
 *
 * ПУСТОЙ ОТСЫЛКИ НЕ ПИШЕМ. Комментарий без звонка — законный случай:
 * руководитель пишет, не звоня; оператор дописывает после закрытия звонка.
 * «Звонок не указан» сообщало бы о том, чего не случилось.
 */
function commentCall(call) {
    if (!call || !call.startedAt) return '';
    const d = new Date(call.startedAt);
    if (Number.isNaN(d.getTime())) return '';
    const at = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (!call.answered) return `к звонку ${at} · ${FEED.noAnswer}`;
    const sec = Number(call.talkSeconds);
    const talk = Number.isFinite(sec) && sec >= 0
        ? `${Math.floor(sec / 60)}:${pad(sec % 60)}`
        : '';
    return talk ? `к звонку ${at} · ${talk}` : `к звонку ${at}`;
}

/** Одна запись ленты. Перенесённая отличается пунктиром и приглушённым фоном. */
function commentBox(item, index) {
    const who = item.isMigrated
        ? FEED.author
        : (item.author && item.author.name ? item.author.name : '');
    const when = item.isMigrated ? FEED.noTime : commentWhen(item.createdAt);
    const call = commentCall(item.call);
    // Скрытые записи ОСТАЮТСЯ в разметке: раскрытие происходит на месте, у
    // оператора идёт разговор, и второй запрос к серверу ради уже полученного
    // означал бы паузу ровно в этот момент.
    const extra = index >= FEED_VISIBLE ? ' hidden' : '';
    return `
        <div class="op-comment${item.isMigrated ? ' op-comment--legacy' : ''}" data-role="comment"${extra}>
            <div class="op-comment__head">
                ${who ? `<span class="op-comment__who">${escapeHtml(who)}</span>` : ''}
                <span>${escapeHtml(when)}</span>
                ${call ? `<span class="op-comment__call">${escapeHtml(call)}</span>` : ''}
            </div>
            <div class="op-comment__text">${escapeHtml(item.body || '')}</div>
        </div>
    `;
}

/**
 * Секция «Комментарии» целиком: пустое поле СВЕРХУ, лента под ним на чтение
 * (решение владельца 116, К282).
 *
 * ПОЛЕ ВСЕГДА ПУСТОЕ, и это главное правило пункта. Оно не «очищается после
 * сохранения» — в нём НИКОГДА не лежит чужой текст. Стереть чужое невозможно не
 * потому, что запретили, а потому, что стирать нечего.
 */
function commentsSection(lead) {
    const items = Array.isArray(lead.comments) ? lead.comments : [];
    const feed = items.length === 0
        ? `<div class="ui-empty ui-empty--inline"><div class="ui-empty__text">${escapeHtml(FEED.empty)}</div></div>`
        : `<div class="op-comments" data-role="comments">${items.map((it, i) => commentBox(it, i)).join('')}</div>`;
    // Кнопки нет, пока скрывать нечего: до трёх записей видно всё.
    const more = items.length > FEED_VISIBLE
        ? `<button type="button" class="ui-btn ui-btn--ghost op-comments-more" data-role="comments-more">Показать все ${items.length}</button>`
        : '';
    return `
        <div class="op-form-section">
            <div class="op-section-label">Комментарии</div>
            <div class="ui-field">
                <span class="ui-field__label" for="op-field-comment">${FEED.label}</span>
                <textarea class="ui-field__control" id="op-field-comment" name="comment" rows="3"
                          placeholder="${escapeHtml(FEED.placeholder)}"></textarea>
                <span class="ui-field__hint">${escapeHtml(FEED.hint)}</span>
            </div>
            ${feed}
            ${more}
        </div>
    `;
}

export function renderLeadForm(container, lead, statuses, paramLists, onSave, options) {
    const lists = paramLists || {};
    const savedAt = formatDateTime(lead.updatedAt);
    const attempts = Number(lead.callAttempts) || 0;
    const opts = options || {};

    container.innerHTML = `
        ${opts.flash ? `<div class="op-flash" id="opFlashBar"><i class="fas fa-circle-check" aria-hidden="true"></i>Новый лид № ${lead.id} — перед вами другой человек</div>` : ''}
        <div class="op-card-head">
            <h2><span class="op-card-icon"><i class="fas fa-user" aria-hidden="true"></i></span>Карточка клиента</h2>
            <span class="op-lead-no" title="Номер лида — из базы, не редактируется">
                <i class="fas fa-hashtag" aria-hidden="true"></i>Лид <span class="n">№&nbsp;${lead.id}</span>
            </span>
            <div class="op-lead-meta">Создан ${escapeHtml(formatDateTime(lead.createdAt)) || '—'} · источник: ${escapeHtml(lead.sourceName) || '—'}</div>
        </div>

        <div class="op-lead-phone">
            <i class="fas fa-phone" aria-hidden="true"></i>
            <input id="op-field-phone" name="phone" type="tel" value="${escapeHtml(lead.phone)}" aria-label="Телефон">
            ${attempts ? '<span class="op-attempt" id="opAttemptBadge"></span>' : ''}
        </div>
        ${phoneNote(lead)}
        ${attempts ? '<div class="op-attempt-note" id="opAttemptNote"></div>' : ''}

        <div class="op-form-section">
            <div class="op-section-label">Клиент</div>
            <div class="form-grid cols-3">
                ${textField('lastName', 'Фамилия', lead)}
                ${textField('firstName', 'Имя', lead)}
                ${textField('middleName', 'Отчество', lead)}
                ${selectField('decisionMaker', 'ЛПР', lists.decisionMaker, lead)}
                ${selectField('purchaseTimeframe', 'Срок покупки', lists.purchaseTerm, lead)}
            </div>
        </div>

        <div class="op-form-section">
            <div class="op-section-label">География</div>
            <button type="button" class="op-dashed-row" id="opShowGeoBtn">
                <i class="fas fa-location-dot" aria-hidden="true"></i>
                Показать географию <span class="count">— гео объекта и гео клиента</span>
            </button>
            <div id="opGeoBody" hidden>
                ${geoBlock('Гео объекта', '', lead)}
                ${geoBlock('Гео клиента', 'client', lead)}
            </div>
        </div>

        <div class="op-form-section" id="opParamsStep" hidden>
            <button type="button" class="op-dashed-row" id="opShowParamsBtn">
                <i class="fas fa-magnifying-glass" aria-hidden="true"></i>
                Показать бюджет и объект <span class="count">— цена, способ покупки, параметры объекта</span>
            </button>
        </div>

        <div id="opParamsBody" hidden>
            <div class="op-form-section">
                <div class="op-section-label">Бюджет и оплата</div>
                <div class="form-grid cols-3">
                    ${rangePair('Цена, ₽', '— от и до', 'priceFrom', 'priceTo', lead)}
                </div>
                <div class="form-grid cols-3">
                    ${selectField('purchaseMethod', 'Способ покупки', lists.paymentMethod, lead)}
                    <div class="form-group" id="opDownPaymentGroup" hidden>
                        <label for="op-field-downPaymentPercent">Первоначальный взнос, %</label>
                        <input id="op-field-downPaymentPercent" name="downPaymentPercent" type="number" min="0" max="100" value="${escapeHtml(lead.downPaymentPercent)}">
                    </div>
                    <div class="form-group" id="opMortgageTypeGroup" hidden>
                        <label for="op-field-mortgageType">Вид ипотеки</label>
                        <select id="op-field-mortgageType" name="mortgageType">${buildOptions(lists.mortgageType, lead.mortgageType)}</select>
                    </div>
                    ${selectField('clientType', 'Вид клиента', lists.clientType, lead)}
                    <div class="form-group span-full" id="opOtherBorrowerGroup" hidden>
                        <label class="op-checkbox-row" for="op-field-otherBorrower">
                            <input id="op-field-otherBorrower" name="otherBorrower" type="checkbox" ${lead.otherBorrower ? 'checked' : ''}>
                            <span class="txt">Заёмщик может быть другим человеком
                                <span class="sub">Показано, потому что вид клиента «Пенсионер» и способ покупки — ипотека</span>
                            </span>
                        </label>
                    </div>
                </div>
            </div>

            <div class="op-form-section">
                <div class="op-section-label">Объект</div>
                <div class="form-grid cols-3">
                    ${selectField('category', 'Категория', lists.category, lead)}
                    ${selectField('propertyType', 'Тип объекта', lists.objType, lead, '— не выбран: жилое —')}
                    ${selectField('propertyClass', 'Класс объекта', lists.objClass, lead, '— не выбран: все классы —')}
                    ${selectField('roomCount', 'Комнатность', lists.rooms, lead)}
                    ${rangePair('Площадь, м²', '— от и до', 'areaFrom', 'areaTo', lead)}
                    ${selectField('finish', 'Отделка', lists.finish, lead)}
                    ${selectField('deliveryDeadline', 'Срок сдачи', lists.deadline, lead, undefined, '— не позже')}
                </div>
            </div>
        </div>

        ${commentsSection(lead)}

        <div class="op-form-section">
            <div class="op-section-label">Статус звонка</div>
            <div class="form-group">
                <select id="op-field-funnelStatusId" name="funnelStatusId">
                    ${buildFunnelStatusOptions(statuses, lead.funnelStatusId)}
                </select>
            </div>
            <div id="opCallbackBox"></div>
        </div>

        <div class="op-card-actions">
            <span class="op-saved-at" id="opSavedAt">${savedAt ? `Последнее сохранение: ${escapeHtml(savedAt)}` : 'Ещё не сохранялся'} · после сохранения сразу откроется следующий лид</span>
            <button type="button" class="btn btn-primary" id="opSaveLeadBtn">Сохранить</button>
        </div>
    `;

    initGeoBlocks(container);

    // --- Каскады -----------------------------------------------------------
    const paymentSelect = container.querySelector('#op-field-purchaseMethod');
    const clientTypeSelect = container.querySelector('#op-field-clientType');
    const downPaymentGroup = container.querySelector('#opDownPaymentGroup');
    const downPaymentInput = container.querySelector('#op-field-downPaymentPercent');
    const mortgageGroup = container.querySelector('#opMortgageTypeGroup');
    const mortgageSelect = container.querySelector('#op-field-mortgageType');
    const otherBorrowerGroup = container.querySelector('#opOtherBorrowerGroup');
    const otherBorrowerInput = container.querySelector('#op-field-otherBorrower');

    // Скрытое поле ОБНУЛЯЕТСЯ — у лида это критерий будущего подбора, и
    // «Наличные + первоначальный взнос 20 %» молча испортили бы подбор
    // (решение куратора, dialog.md F3; в форме оффера взнос не сбрасывается —
    // там поле означает условие площадки, а не запрос клиента).
    //
    // НО только при действии оператора. На первой отрисовке (keepValues) поля
    // прячутся без обнуления: у лида, заведённого до появления каскадов, взнос
    // может лежать при пустом способе покупки, и обнуление на открытии стёрло
    // бы его первым же сохранением — данные, которых оператор даже не видел.
    // Это ровно тот класс молчаливой потери, против которого правило C1.
    // Мусор всё равно вычищается, как только оператор трогает способ покупки.
    function applyCascades(keepValues) {
        const payment = paymentSelect.value;

        const showDownPayment = needsDownPayment(payment);
        downPaymentGroup.hidden = !showDownPayment;
        if (!showDownPayment && !keepValues) downPaymentInput.value = '';

        const showMortgage = isMortgage(payment);
        mortgageGroup.hidden = !showMortgage;
        if (!showMortgage && !keepValues) mortgageSelect.value = '';

        const showOtherBorrower = clientTypeSelect.value === RETIREE_VALUE && showMortgage;
        otherBorrowerGroup.hidden = !showOtherBorrower;
        if (!showOtherBorrower && !keepValues) otherBorrowerInput.checked = false;
    }

    // Тронул ли оператор каскад в этом сеансе — от этого зависит, что писать в
    // «иного заёмщика», когда поле скрыто (см. сборку данных ниже).
    let cascadeTouched = false;
    const handleCascadeChange = () => { cascadeTouched = true; applyCascades(false); };
    paymentSelect.addEventListener('change', handleCascadeChange);
    clientTypeSelect.addEventListener('change', handleCascadeChange);
    applyCascades(true);

    // --- Лесенка раскрытия -------------------------------------------------
    // Ступени раскрываются один раз и обратно не сворачиваются. Ступень с уже
    // заполненными данными раскрыта сразу: лесенка нужна, чтобы укоротить
    // форму в начале первого звонка, а не чтобы прятать собранные данные —
    // иначе оператор переспрашивает клиента то, что уже записано (dialog.md D4).
    const geoBody = container.querySelector('#opGeoBody');
    const geoBtn = container.querySelector('#opShowGeoBtn');
    const paramsStep = container.querySelector('#opParamsStep');
    const paramsBody = container.querySelector('#opParamsBody');
    const paramsBtn = container.querySelector('#opShowParamsBtn');

    function openGeoStep() {
        geoBody.hidden = false;
        geoBtn.remove();
        paramsStep.hidden = false;
    }

    function openParamsStep() {
        paramsBody.hidden = false;
        paramsStep.remove();
    }

    geoBtn.addEventListener('click', openGeoStep);
    paramsBtn.addEventListener('click', openParamsStep);

    // otherBorrower учитывается отдельно: он живёт в чекбоксе, а не в value,
    // и заполненный «нет» (false) — это тоже ответ оператора, а не пустота.
    const answeredOtherBorrower = lead.otherBorrower === true || lead.otherBorrower === false;
    const geoFilled = hasAnyValue(container, GEO_KEYS);
    const paramsFilled = hasAnyValue(container, PARAMS_KEYS) || answeredOtherBorrower;

    // Вторая ступень тянет за собой первую: иначе над раскрытым «Бюджетом»
    // висела бы кнопка «Показать географию».
    if (geoFilled || paramsFilled) openGeoStep();
    if (paramsFilled) openParamsStep();

    // --- Перезвон ----------------------------------------------------------
    // Выбор даты и времени раскрывается ПОД селектом статуса, не модалкой:
    // модальное окно ради двух полей закрывает карточку в самый неудобный
    // момент. Показывается по флагу requiresCallTime, а не по названию статуса.
    const statusSelect = container.querySelector('#op-field-funnelStatusId');
    const callbackBox = container.querySelector('#opCallbackBox');
    const statusById = new Map(statuses.map((s) => [String(s.id), s]));

    function selectedStatus() {
        return statusById.get(statusSelect.value) || null;
    }

    function renderCallbackBox() {
        const status = selectedStatus();
        if (!status || !status.requiresCallTime) {
            callbackBox.innerHTML = '';
            return;
        }
        const initial = lead.nextCallAt ? new Date(lead.nextCallAt) : new Date(Date.now() + 3600 * 1000);
        callbackBox.innerHTML = `
            <div class="op-callback">
                <div class="op-callback-title">Когда перезвонить</div>
                <div class="op-callback-row">
                    <div class="form-group">
                        <label for="opCallbackWhen">Дата и время</label>
                        <input type="datetime-local" id="opCallbackWhen" step="60" value="${escapeHtml(toLocalInputValue(initial))}">
                    </div>
                </div>
                <div class="op-callback-quick">
                    <button type="button" data-quick="1">через 1 час</button>
                    <button type="button" data-quick="3">через 3 часа</button>
                    <button type="button" data-quick="tomorrow">завтра 10:00</button>
                </div>
                <div class="op-callback-note">Лид уйдёт из очереди и в назначенное время вернётся в <b>общую очередь</b> — его может взять любой оператор линии.</div>
            </div>
        `;
        callbackBox.querySelectorAll('[data-quick]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const when = new Date();
                if (btn.dataset.quick === 'tomorrow') {
                    when.setDate(when.getDate() + 1);
                    when.setHours(10, 0, 0, 0);
                } else {
                    when.setHours(when.getHours() + Number(btn.dataset.quick));
                }
                const input = callbackBox.querySelector('#opCallbackWhen');
                input.value = toLocalInputValue(when);
                input.classList.remove('is-invalid');
            });
        });
    }

    // --- Счётчик попыток ---------------------------------------------------
    // ПРЕДЕЛ ЗАВИСИТ ОТ ВЫБРАННОГО СТАТУСА, а не от лида: своё число у каждой
    // строки события (решение владельца 12), и решает то, которое оператор
    // сейчас ставит (ответ куратора 14). Поэтому счётчик перерисовывается вместе
    // с выбором — там же, где раскрывается выбор времени перезвона.
    //
    // ПРЕДЕЛА НЕТ — НЕТ И «ИЗ N». По статусу без правила система не перезванивает
    // вовсе, и «Попытка 3 из 20» обещала бы то, чего не случится. Остаётся
    // «Попытка 3»: число попыток — факт, он был и остаётся верным.
    const attemptBadge = container.querySelector('#opAttemptBadge');
    const attemptNote = container.querySelector('#opAttemptNote');

    function renderAttempts() {
        if (!attemptBadge && !attemptNote) return;
        const status = selectedStatus();
        const limit = recallLimitOf(status);
        const previous = formatDateTime(lead.lastCallAt) || '—';

        if (attemptBadge) {
            attemptBadge.textContent = limit === null
                ? `Попытка ${attempts}`
                : `Попытка ${attempts} из ${limit}`;
            attemptBadge.classList.toggle('warn', limit !== null && attempts >= warnFrom(limit));
        }
        if (attemptNote) {
            const tail = limit === null
                ? ''
                : ` После ${limit}-й лид уйдёт в статус «${status.recallAfterStatusName}».`;
            attemptNote.textContent =
                `Предыдущая попытка: ${previous}. Счётчик общий по всем операторам линии.${tail}`;
        }
    }

    statusSelect.addEventListener('change', () => {
        renderCallbackBox();
        renderAttempts();
    });
    renderCallbackBox();
    renderAttempts();

    // --- Сохранение --------------------------------------------------------
    // --- Лента: раскрыть и свернуть ----------------------------------------
    //
    // КНОПКА НАЗЫВАЕТ ПОЛНОЕ ЧИСЛО, а не «ещё 8»: «Показать все 11» отвечает на
    // вопрос «сколько всего с ним говорили» — тот, который оператор задаёт
    // первым. «Ещё 8» заставляет складывать.
    //
    // ФОКУС ОСТАЁТСЯ НА КНОПКЕ, она меняет подпись. Уводить фокус в ленту
    // некуда: записи в порядок обхода не входят — они ничего не открывают и не
    // выбираются.
    const commentsMore = container.querySelector('[data-role="comments-more"]');
    if (commentsMore) {
        const boxes = Array.from(container.querySelectorAll('[data-role="comment"]'));
        const total = boxes.length;
        let open = false;
        commentsMore.addEventListener('click', () => {
            open = !open;
            boxes.forEach((box, i) => { box.hidden = !open && i >= FEED_VISIBLE; });
            commentsMore.textContent = open ? FEED.collapse : `Показать все ${total}`;
        });
    }

    container.querySelector('#opSaveLeadBtn').addEventListener('click', () => {
        const status = selectedStatus();

        // Без статуса не сохраняем (правка куратора при приёмке, 15.08.2026).
        // Условие очереди — «статус „Новый“ ИЛИ наступил перезвон», и лид с
        // пустым статусом не подходит ни под одну ветку: он исчез бы с экрана и
        // не достался бы больше никому. Сервер это же отбивает кодом 400, здесь
        // — чтобы оператор увидел причину сразу, а не после запроса.
        if (!status) {
            statusSelect.classList.add('is-invalid');
            statusSelect.focus();
            onSave(null, null, 'Выберите статус звонка — без него лид не вернётся в очередь');
            return;
        }
        statusSelect.classList.remove('is-invalid');

        let nextCallAt = null;
        if (status && status.requiresCallTime) {
            const input = callbackBox.querySelector('#opCallbackWhen');
            const when = input && input.value ? new Date(input.value) : null;
            // Прошедшее время не принимается: подсвечиваем поле и не сохраняем.
            // Ручной перезвон вне рабочего окна поставить МОЖНО — клиент вправе
            // попросить любое время, сдвигается только автоматический.
            if (!when || Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
                if (input) {
                    input.classList.add('is-invalid');
                    input.focus();
                }
                onSave(null, null, 'Укажите будущие дату и время перезвона');
                return;
            }
            nextCallAt = when.toISOString();
        }

        onSave(collectCard(), nextCallAt);
    });

    /**
     * Набранное в карточке — одной функцией на оба пути.
     *
     * Путей стало два: «Сохранить» и истёкшая пост-обработка (заход 6). Второй
     * сохраняет ровно то же самое и обязан собирать поля тем же кодом — иначе
     * закрытая по времени карточка теряла бы часть набранного, и понять, какую,
     * было бы нельзя.
     */
    function collectCard() {
        const data = {};
        FIELD_KEYS.forEach((key) => {
            const el = container.querySelector(`#op-field-${key}`);
            if (el) data[key] = el.value;
        });
        // Трёхзначность: null — условие показа не выполнено (не спрашивали),
        // true/false — оператор ответил. Не путать «нет» и «не спрашивали».
        // Если поле скрыто, но оператор каскад не трогал, отдаём то, что лежало
        // в базе: карточку могли просто открыть и сохранить, и обнуление стёрло
        // бы чужой ответ (та же логика, что у keepValues в applyCascades).
        if (!otherBorrowerGroup.hidden) {
            data.otherBorrower = otherBorrowerInput.checked;
        } else {
            data.otherBorrower = cascadeTouched ? null : (lead.otherBorrower ?? null);
        }
        return data;
    }

    return { collect: collectCard };
}

// Полоса «Новый лид № …» держится строго 2 секунды по таймеру, а не до первого
// действия оператора (решение дизайн-сессии, G3): привязка к действию делает её
// невидимой ровно для тех, кто торопится, — а им она и нужна.
export function clearFlash(container) {
    const bar = container.querySelector('#opFlashBar');
    if (bar) bar.remove();
}

// УДАЛЕНО 15.08.2026: здесь была updateSavedAt — обновление подписи о
// сохранении без перерисовки формы, чтобы не схлопывать раскрытые ступени
// лесенки посреди звонка. С очередью сохранение закрывает карточку и открывает
// следующего лида, обновлять на месте больше нечего.
