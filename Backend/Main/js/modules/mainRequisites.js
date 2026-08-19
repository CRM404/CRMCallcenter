// --- mainRequisites.js: организация — чтение и правка -----------------------
//
// Один и тот же набор полей показывается двумя способами:
//   ЧТЕНИЕ — пары «метка → значение» (<dl>), значения-идентификаторы
//            моноширинно и с кнопкой «Скопировать», незаполненное — курсивом;
//   ПРАВКА — та же сетка полями ввода, с подсказкой ошибки под полем.
//
// Почему это один модуль, а не два: состав и порядок полей обязаны совпадать
// в обоих режимах. Разложенные по разным файлам, они разъезжаются на первой же
// правке — ровно так в проекте разъехались шесть копий чипа-счётчика.

import { ORG_FIELD_VALIDATORS } from './mainValidation.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Секции и поля — по макету. `mono` — моноширинное начертание (идентификаторы
// и числа), `copy` — кнопка копирования в режиме чтения: ИНН, КПП и ОГРН
// переносят в чужие формы руками чаще всего.
export const ORG_SECTIONS = [
    {
        title: 'Общие данные',
        fields: [
            { key: 'name', label: 'Название', type: 'text', required: true },
            { key: 'legalForm', label: 'ОПФ', type: 'text' },
            { key: 'generalDirector', label: 'Генеральный директор', type: 'text' },
            { key: 'registrationCountry', label: 'Страна регистрации', type: 'text' },
            { key: 'registrationDate', label: 'Дата регистрации', type: 'date' }
        ]
    },
    {
        title: 'Регистрационные данные',
        fields: [
            { key: 'inn', label: 'ИНН', type: 'text', mono: true, copy: true },
            { key: 'kpp', label: 'КПП', type: 'text', mono: true, copy: true },
            { key: 'ogrn', label: 'ОГРН', type: 'text', mono: true, copy: true },
            { key: 'okved', label: 'ОКВЭД', type: 'text', mono: true },
            { key: 'authorizedCapital', label: 'Уставный капитал', type: 'number', mono: true }
        ]
    },
    {
        title: 'Адреса',
        fields: [
            { key: 'legalAddress', label: 'Юридический адрес', type: 'text', wide: true },
            { key: 'actualAddress', label: 'Фактический адрес', type: 'text', wide: true,
                placeholder: 'совпадает с юридическим' }
        ]
    }
];

export const ORG_FIELDS = ORG_SECTIONS.flatMap((s) => s.fields);

// ---------------------------------------------------------------- значения

function displayValue(field, value) {
    if (value === null || value === undefined || value === '') return null;
    if (field.type === 'date') {
        // Сервер отдаёт дату в ISO; человеку нужен привычный вид.
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.toLocaleDateString('ru-RU');
    }
    if (field.key === 'authorizedCapital') {
        const n = Number(value);
        if (Number.isFinite(n)) return `${n.toLocaleString('ru-RU')} ₽`;
    }
    return String(value);
}

/** Значение для поля ввода: дата в формате input[type=date], остальное как есть. */
function inputValue(field, value) {
    if (value === null || value === undefined) return '';
    if (field.type === 'date') return String(value).slice(0, 10);
    return String(value);
}

// ---------------------------------------------------------------- чтение

function readSection(section, org) {
    const rows = section.fields.map((field) => {
        const shown = displayValue(field, org ? org[field.key] : null);
        const cls = [field.mono ? 'm-mono' : '', shown === null ? 'm-empty-val' : ''].filter(Boolean).join(' ');
        const copy = field.copy && shown !== null
            ? `<button type="button" class="ui-btn ui-btn--icon ui-btn--row m-copy" data-copy="${escapeHtml(shown)}" data-label="${escapeHtml(field.label)}" title="Скопировать"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-copy"></use></svg></button>`
            : '';
        return `<dt>${escapeHtml(field.label)}</dt><dd class="${cls}">${shown === null ? 'не заполнено' : escapeHtml(shown)}${copy}</dd>`;
    }).join('');

    return `
        <section class="m-sec">
            <div class="m-sec-head"><h4>${escapeHtml(section.title)}</h4></div>
            <div class="m-sec-body"><dl class="m-kv">${rows}</dl></div>
        </section>`;
}

// ---------------------------------------------------------------- правка

function editSection(section, draft, errors) {
    const fields = section.fields.map((field) => {
        const id = `mOrg_${field.key}`;
        const error = errors[field.key];
        const cls = ['ui-field', field.wide ? 'ui-field--wide' : '', error ? 'is-bad' : ''].filter(Boolean).join(' ');
        const label = `<label class="ui-field__label${field.required ? ' ui-field__label--required' : ''}" for="${id}">${escapeHtml(field.label)}</label>`;
        const control = `<input class="ui-field__control${field.mono ? ' m-mono' : ''}" type="${field.type}" id="${id}"
            data-field="${field.key}" value="${escapeHtml(inputValue(field, draft[field.key]))}"
            ${field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : ''}>`;
        const hint = error ? `<span class="ui-field__hint m-hint-bad">${escapeHtml(error)}</span>` : '';
        return `<div class="${cls}">${label}${control}${hint}</div>`;
    }).join('');

    return `
        <section class="m-sec">
            <div class="m-sec-head"><h4>${escapeHtml(section.title)}</h4></div>
            <div class="m-sec-body"><div class="ui-form-grid">${fields}</div></div>
        </section>`;
}

/**
 * Нарисовать левую колонку.
 *
 * @param {HTMLElement} container колонка
 * @param {object|null} organization данные с сервера (null — организации нет)
 * @param {object} state { editing, draft, errors }
 */
export function renderOrganization(container, organization, state) {
    container.innerHTML = ORG_SECTIONS
        .map((section) => (state.editing
            ? editSection(section, state.draft, state.errors)
            : readSection(section, organization)))
        .join('');
}

// ---------------------------------------------------------------- черновик

/** Черновик правки: копия значений организации по составу полей. */
export function makeDraft(organization) {
    const draft = {};
    ORG_FIELDS.forEach((field) => {
        const value = organization ? organization[field.key] : null;
        draft[field.key] = value === null || value === undefined ? '' : inputValue(field, value);
    });
    return draft;
}

/** Сколько полей черновика отличается от сохранённого. Число идёт в полосу. */
export function countChanges(organization, draft) {
    return ORG_FIELDS.filter((field) => {
        const saved = organization ? inputValue(field, organization[field.key] ?? '') : '';
        return String(draft[field.key] ?? '') !== String(saved ?? '');
    }).length;
}

/** Проверка формата. Возвращает { поле: текст ошибки } — пусто, если всё чисто. */
export function validateDraft(draft) {
    const errors = {};
    Object.entries(ORG_FIELD_VALIDATORS).forEach(([key, validate]) => {
        const error = validate(draft[key]);
        if (error) errors[key] = error;
    });
    return errors;
}

/** Слово «поле» в нужном числе: 1 поле, 2 поля, 5 полей. */
export function fieldsWord(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'поле';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'поля';
    return 'полей';
}
