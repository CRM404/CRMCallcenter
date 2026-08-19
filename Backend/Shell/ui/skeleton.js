// --- ui/skeleton.js: скелет загрузки раздела -------------------------------
//
// Разметку строит код, а не разделы: скелет обязан появиться РАНЬШЕ, чем
// загружен фрагмент раздела, — иначе он опоздает ровно к тому кадру, ради
// которого нужен. Разделу тут делать нечего, он в этот момент ещё не
// существует.
//
// Формы две, и это не украшение: скелет должен повторять то, что появится.
//   'table' — список: заголовок, кнопка, чипы-счётчики, строка фильтров, ряды.
//   'form'  — карточка: заголовок, кнопка, пары «метка + поле» в две колонки.
// Раздел выбирает свою полем `skeleton` в реестре (shell/app.js).
//
// Стили — ui/skeleton.css (элемент), .ui-skeleton--overlay — накладка поверх
// пустого тела панели.

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function row(...children) {
    const r = el('div', 'ui-skeleton__row');
    children.forEach((c) => r.appendChild(c));
    return r;
}

function cells(weights) {
    return row(...weights.map((w) => {
        const cell = el('span', 'ui-sk ui-sk--cell');
        cell.style.flex = String(w);
        return cell;
    }));
}

function tableShape(box) {
    // Силуэт списка ровно в том порядке, в каком он приедет: шапка раздела
    // (заголовок + подпись + кнопки), чипы-счётчики, полоса тулбара, шапка
    // таблицы и шесть строк.
    box.appendChild(row(el('span', 'ui-sk ui-sk--title'), el('span', 'ui-sk ui-sk--btn')));
    box.appendChild(row(el('span', 'ui-sk ui-sk--sub')));
    box.appendChild(row(
        el('span', 'ui-sk ui-sk--chip'),
        el('span', 'ui-sk ui-sk--chip'),
        el('span', 'ui-sk ui-sk--chip')
    ));
    box.appendChild(el('div', 'ui-sk ui-sk--line'));
    box.appendChild(el('div', 'ui-sk ui-sk--head'));
    for (let i = 0; i < 6; i += 1) box.appendChild(cells([2, 1, 1, 1]));
}

function formShape(box) {
    box.appendChild(row(el('span', 'ui-sk ui-sk--title'), el('span', 'ui-sk ui-sk--btn')));
    box.appendChild(row(el('span', 'ui-sk ui-sk--sub')));
    for (let i = 0; i < 5; i += 1) {
        box.appendChild(row(
            el('span', 'ui-sk ui-sk--line'),
            el('span', 'ui-sk ui-sk--line')
        ));
    }
}

/**
 * Накладка со скелетом. Кладётся в тело панели и снимается, когда раздел
 * смонтирован и показал первые данные.
 *
 * @param {'table'|'form'} kind форма скелета
 * @param {string} title название раздела — для чтения с экрана
 */
export function createSkeleton(kind = 'table', title = '') {
    const box = el('div', 'ui-skeleton ui-skeleton--overlay');
    box.dataset.role = 'section-skeleton';
    // Полосы — украшение, читать их с экрана нечего; состояние сообщает
    // невидимая подпись ниже, поэтому у накладки aria-busy, а не aria-hidden.
    box.setAttribute('aria-busy', 'true');

    if (kind === 'form') formShape(box);
    else tableShape(box);

    const note = el('div', 'ui-skeleton__note');
    note.setAttribute('role', 'status');
    note.textContent = title ? `Загружаем «${title}»…` : 'Загружаем раздел…';
    box.appendChild(note);

    return box;
}
