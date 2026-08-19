// --- ui/icons.js: набор значков приложения ---------------------------------
//
// ОДИН набор на весь проект, инлайновый, без сети. До этого значки брались из
// Font Awesome с cdnjs — единственной внешней таблицы стилей проекта: без сети
// интерфейс оставался без значков вовсе, а сами глифы были сплошные, залитые,
// и спорили со штриховым языком макета (С1, решение владельца 19.08.2026 —
// переводить по-хорошему, а не класть Font Awesome локально).
//
// ОТКУДА ЗНАЧЕНИЯ. Двадцать три значка перенесены из макета дословно (объект
// ICONS в `shell-all-sections.clean.html`). Остальные дорисованы в том же
// языке — сетка 24×24, штрих 1.7, скруглённые концы, без заливки — потому что
// в бою используются глифы, которых макет не рисовал (телефон, конверт,
// календарь, сортировка и прочие). Они помечены ниже как «дорисовано» и ждут
// приёмки дизайн-сессии: заменить любой из них — это одна строка здесь.
//
// КАК УСТРОЕНО. Набор кладётся в документ ОДИН раз спрайтом из <symbol>, а
// места использования ссылаются на него через <use>. Так значок в статическом
// фрагменте раздела и значок, собранный строкой в модуле, — один и тот же
// объект, и вес его в разметке равен одной строке, а не сорока точкам пути.
//
//     import { mountIconSprite, icon } from '/ui/icons.js';
//     mountIconSprite();                    // один раз при старте приложения
//     el.innerHTML = icon('trash', 'sm');   // в разметке раздела

export const ICONS = {
    // --- из макета, дословно ---
    home: '<path d="M4 11.5 12 5l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/>',
    requisites: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 16h5"/>',
    employees: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.7 5.5-4.7s4.9 1.7 5.5 4.7"/><circle cx="16.8" cy="9.5" r="2.4"/><path d="M15.6 14.6c2.4.2 4.2 1.6 4.9 4.4"/>',
    leads: '<circle cx="10" cy="9" r="3.2"/><path d="M4.5 19.5c.6-3 2.8-4.7 5.5-4.7 1.6 0 3 .6 4 1.6"/><path d="M17.5 14.5v5M15 17h5"/>',
    sources: '<path d="M4 11v3l3 .5V20h3v-5l9 3V6.5L7 10z"/><path d="M19 10.5a3 3 0 0 1 0 4"/>',
    cpa: '<circle cx="12" cy="5.5" r="2.3"/><circle cx="5.5" cy="18" r="2.3"/><circle cx="18.5" cy="18" r="2.3"/><path d="M10.8 7.5 6.6 16M13.2 7.5l4.2 8.5M7.8 18h8.4"/>',
    scripts: '<rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="3" y="16" width="6" height="5" rx="1.2"/><rect x="15" y="16" width="6" height="5" rx="1.2"/><path d="M12 8v4M6 16v-2.5h12V16"/>',
    catalog: '<rect x="3.5" y="4.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="4.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="14.5" width="7" height="5.5" rx="1.6"/><rect x="13.5" y="14.5" width="7" height="5.5" rx="1.6"/>',
    logout: '<path d="M14 5.5H6.5v13H14"/><path d="M11 12h9M17 9l3 3-3 3"/>',
    split: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5v14"/>',
    min: '<path d="M6 17h12"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15.5 15.5 4.5 4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    ext: '<path d="M13.5 4.5H19.5V10.5"/><path d="M19.5 4.5 12 12"/><path d="M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4.5"/>',
    edit: '<path d="M15.5 5.5 18.5 8.5 8 19H5v-3z"/><path d="m13.5 7.5 3 3"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    filter: '<path d="M4 6h16l-6 7v5l-4 2v-7z"/>',
    cols: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15M14.5 4.5v15"/>',
    upload: '<path d="M12 16V5"/><path d="m8 9 4-4 4 4"/><path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    left: '<path d="M14.5 6 9 12l5.5 6"/>',
    right: '<path d="M9.5 6 15 12l-5.5 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',

    // --- дорисовано в том же языке, ждёт приёмки дизайн-сессии ---
    user: '<circle cx="12" cy="8.5" r="3.4"/><path d="M5.5 19.5c.7-3.3 3.2-5.2 6.5-5.2s5.8 1.9 6.5 5.2"/>',
    'user-plus': '<circle cx="10" cy="8.5" r="3.4"/><path d="M4 19.5c.7-3.3 3-5.2 6-5.2 1 0 2 .2 2.8.6"/><path d="M17.5 13.5v6M14.5 16.5h6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18.01 5.99l-1.56 1.56M7.55 16.45l-1.56 1.56M18.01 18.01l-1.56-1.56M7.55 7.55 5.99 5.99"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
    phone: '<path d="M7.5 4.5h3l1.2 3.4-2 1.4a11 11 0 0 0 5 5l1.4-2 3.4 1.2v3a1.6 1.6 0 0 1-1.8 1.6C11.4 17.4 6.6 12.6 5.9 6.3A1.6 1.6 0 0 1 7.5 4.5z"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 5.5L20 7"/>',
    pin: '<path d="M12 3.5a6 6 0 0 1 6 6c0 4.2-6 11-6 11s-6-6.8-6-11a6 6 0 0 1 6-6z"/><circle cx="12" cy="9.5" r="2.3"/>',
    doc: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>',
    list: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01"/>',
    layers: '<path d="m12 4 8 4.2-8 4.2-8-4.2z"/><path d="m4 13 8 4.2 8-4.2"/>',
    calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
    'calendar-plus': '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/><path d="M12 13v5M9.5 15.5h5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.2 2.8 2.8L16 9.8"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/>',
    warn: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 16.8h.01"/>',
    shield: '<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6z"/><path d="m9 12 2 2 4-4"/>',
    share: '<circle cx="17.5" cy="6" r="2.4"/><circle cx="6.5" cy="12" r="2.4"/><circle cx="17.5" cy="18" r="2.4"/><path d="m8.6 10.9 6.8-3.7M8.6 13.1l6.8 3.7"/>',
    more: '<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
    shuffle: '<path d="M4 7h3.5l9 10H20M4 17h3.5l2.3-2.6M14 8.6l2.5-1.6H20"/><path d="m17.5 4.5 2.5 2.5-2.5 2.5M17.5 14.5l2.5 2.5-2.5 2.5"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    'chevron-down': '<path d="m6 9.5 6 5.5 6-5.5"/>',
    'chevron-up': '<path d="m6 14.5 6-5.5 6 5.5"/>',
    'arrow-right': '<path d="M4.5 12h15M14 6.5l5.5 5.5L14 17.5"/>',
    'arrow-left': '<path d="M19.5 12h-15M10 6.5 4.5 12 10 17.5"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
    'arrow-down-left': '<path d="M17 7 7 17"/><path d="M15.5 17H7V8.5"/>',
    'sort-asc': '<path d="M6 6.5v11M6 6.5 3.5 9M6 6.5 8.5 9"/><path d="M12 8h4M12 12h6M12 16h8"/>',
    'sort-desc': '<path d="M6 17.5v-11M6 17.5 3.5 15M6 17.5 8.5 15"/><path d="M12 8h8M12 12h6M12 16h4"/>'
};

const SPRITE_ID = 'ui-icon-sprite';

/**
 * Кладёт спрайт в документ. Вызывать один раз при старте страницы; повторные
 * вызовы ничего не делают.
 */
export function mountIconSprite() {
    if (document.getElementById(SPRITE_ID)) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = SPRITE_ID;
    svg.setAttribute('aria-hidden', 'true');
    // Спрайт не участвует в раскладке: он только хранилище описаний.
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';

    svg.innerHTML = Object.entries(ICONS)
        .map(([name, body]) => `<symbol id="ui-ic-${name}" viewBox="0 0 24 24">${body}</symbol>`)
        .join('');

    document.body.appendChild(svg);
}

/**
 * Разметка значка строкой — для модулей, которые собирают HTML.
 *
 * @param {string} name ключ из ICONS
 * @param {'sm'|'lg'|''} [size] ступень размера: 15 / 26 / по умолчанию 20
 * @param {string} [extra] дополнительные классы раздела
 */
export function icon(name, size = '', extra = '') {
    return `<svg class="${iconClass(size, extra)}" aria-hidden="true"><use href="#ui-ic-${name}"></use></svg>`;
}

/**
 * Значок УЗЛОМ — для модулей, которые строят разметку через createElement
 * (оболочка, тост, полоса свёрнутых). Через innerHTML их писать нельзя:
 * значение приходит из данных.
 */
export function iconNode(name, size = '', extra = '') {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', iconClass(size, extra));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#ui-ic-${name}`);
    svg.appendChild(use);
    return svg;
}

function iconClass(size, extra) {
    return ['ui-ic', size ? `ui-ic--${size}` : '', extra].filter(Boolean).join(' ');
}
