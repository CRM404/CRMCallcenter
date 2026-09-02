// --- cpaColumns.js: видимые колонки таблицы офферов и их порядок -----------
//
// Собран по образцу `Employees/js/modules/employeesColumns.js` — окно слоя со
// списком флажков, хранение в общем `/viewPrefs.js`. Отличий два, и оба по
// решению владельца от 01.09.2026:
//
//   1. КОЛОНОК ДВАДЦАТЬ ПЯТЬ, А НЕ ПЯТНАДЦАТЬ. «По всем полям» — значит по
//      всем, что реально приходят с сервера. Состав снят с `rowToOffer`
//      (`routes/realEstateOffers.js:164-203`), а не выдуман: подписи взяты из
//      формы оффера того же раздела, чтобы одно поле не называлось в двух
//      местах по-разному.
//
//   2. ПОРЯДОК ПЕРЕТАСКИВАЕТСЯ. Механизма в проекте не было: `viewPrefs`
//      хранил только скрытые, а перетаскивания не знал ни один раздел. Заведён
//      здесь и положен в общее хранилище — второй раздел возьмёт готовое.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ.
//
// `networkId` колонкой не заводится: таблица показывает офферы ОДНОЙ выбранной
// сети, и колонка «Сеть» была бы одинаковой во всех строках.
//
// «Комнатность» на уровне оффера не заводится тоже: колонка `rooms` в таблице
// есть (`schema.sql:452`), но `rowToOffer` её НЕ ОТДАЁТ — комнатность живёт в
// строке сегмента. Колонка по полю, которого нет в ответе, была бы вечным
// прочерком.
//
// ID И «ДЕЙСТВИЯ» В СПИСОК НЕ ВХОДЯТ — то же правило, что у «Сотрудников»:
// структурные элементы, показываются всегда. Владелец подтвердил это отдельно
// («ID — всегда»). К ним добавлено НАЗВАНИЕ: по его же решению первые две
// колонки заморожены при уезжании таблицы вбок, а морозить можно только то,
// что нельзя выключить.

import { readHiddenColumns, writeHiddenColumns, readColumnOrder, writeColumnOrder, applyColumnOrder } from '/viewPrefs.js';
import { openModal } from '/ui/modal.js';

const SECTION = 'cpaOffers';

// Порядок здесь — ПОРЯДОК ПО УМОЛЧАНИЮ: он же порядок нынешней таблицы, а всё
// новое идёт следом. Человек переставит и сохранит своё.
export const CONFIGURABLE_COLUMNS = [
    { key: 'category', label: 'Категория' },
    { key: 'actionType', label: 'Тип действия' },
    { key: 'rate', label: 'Ставка, ₽', num: true },
    { key: 'period', label: 'Период действия' },
    { key: 'leadsCount', label: 'Лидов', num: true },
    { key: 'status', label: 'Статус' },
    { key: 'holdDays', label: 'Hold, дней', num: true },
    { key: 'leadCheck', label: 'Наличие проверки лидов' },
    { key: 'objTypes', label: 'Тип объекта' },
    { key: 'finishes', label: 'Отделка' },
    { key: 'developer', label: 'Застройщик' },
    { key: 'deadline', label: 'Срок сдачи' },
    { key: 'clientTypes', label: 'Тип клиента' },
    { key: 'otherBorrower', label: 'Иной заёмщик' },
    { key: 'purchaseTerm', label: 'Срок покупки' },
    { key: 'downPaymentPercent', label: 'Первоначальный взнос, %', num: true },
    { key: 'paymentMethods', label: 'Способ покупки' },
    { key: 'mortgageTypes', label: 'Виды ипотеки' },
    { key: 'priority', label: 'Приоритет', num: true },
    { key: 'leadLimit', label: 'Лимит лидов', num: true },
    { key: 'segments', label: 'Цена и площадь по сегментам' },
    { key: 'objGeo', label: 'География объекта' },
    { key: 'clientGeo', label: 'География клиента' },
    { key: 'targetCriteria', label: 'Критерии целевого лида' },
    { key: 'nonTargetCriteria', label: 'Критерии нецелевого лида' }
];

const KNOWN_KEYS = CONFIGURABLE_COLUMNS.map((c) => c.key);

// Умолчание — нынешний вид таблицы: шесть колонок сверх структурных. Остальные
// девятнадцать выключены, пока человек их не включит. Список СКРЫТЫХ, а не
// видимых, потому что таким его хранит `viewPrefs`.
const DEFAULT_HIDDEN = KNOWN_KEYS.filter((key) => ![
    'category', 'actionType', 'rate', 'period', 'leadsCount', 'status'
].includes(key));

/**
 * Видимые колонки в сохранённом порядке. Зовётся при каждой отрисовке таблицы.
 * @returns {Object[]} [{ key, label, num }, …]
 */
export function visibleColumns() {
    const hidden = new Set(readHiddenColumns(SECTION, KNOWN_KEYS));
    // Пустая запись бывает двух видов: «не настраивал ни разу» и «включил всё».
    // Различает их `readHiddenColumns`, вернуть он может только массив, поэтому
    // умолчание применяется через отдельный признак — см. `wasConfigured`.
    const effective = wasConfigured() ? hidden : new Set(DEFAULT_HIDDEN);
    const order = readColumnOrder(SECTION, KNOWN_KEYS);
    return applyColumnOrder(CONFIGURABLE_COLUMNS, order).filter((c) => !effective.has(c.key));
}

// Настраивал ли человек колонки хоть раз. Без этого «включил всё» было бы
// неотличимо от «первый заход», и умолчание возвращалось бы каждый раз поверх
// осознанного выбора.
function wasConfigured() {
    try {
        const raw = JSON.parse(localStorage.getItem('crm_viewPrefs') || '{}');
        return Boolean(raw && raw.hiddenColumns && Array.isArray(raw.hiddenColumns[SECTION]));
    } catch (err) {
        return false;
    }
}

/**
 * @param {HTMLElement} root контейнер панели
 * @param {Object} deps { toast, onApplied }
 */
export function createColumns(root, deps) {
    const { toast, onApplied } = deps;
    let modal = null;

    function openColumnsModal() {
        if (modal) return;

        const hidden = wasConfigured()
            ? new Set(readHiddenColumns(SECTION, KNOWN_KEYS))
            : new Set(DEFAULT_HIDDEN);
        const order = readColumnOrder(SECTION, KNOWN_KEYS);
        const ordered = applyColumnOrder(CONFIGURABLE_COLUMNS, order);

        const body = document.createElement('div');
        const hint = document.createElement('p');
        hint.className = 'ui-field__hint cpa-cols__hint';
        hint.textContent = 'Галка показывает колонку, перетаскивание меняет порядок. Номер и название стоят всегда.';
        body.appendChild(hint);

        const list = document.createElement('div');
        list.className = 'cpa-cols';
        list.setAttribute('data-role', 'columns-list');
        ordered.forEach((col) => list.appendChild(buildRow(col, !hidden.has(col.key))));
        body.appendChild(list);

        wireDrag(list);

        modal = openModal({
            title: 'Видимые колонки таблицы',
            sub: 'Двадцать пять колонок оффера; порядок задаёте вы',
            body,
            scope: root,
            spread: true,
            actions: [
                {
                    // «Сбросить» возвращает и состав, и порядок к тому, с чего
                    // раздел начинался, и НЕ применяет: человек остаётся в окне
                    // и видит, что получится.
                    label: 'Сбросить',
                    variant: 'secondary',
                    side: 'start',
                    role: 'columns-reset',
                    onClick: () => {
                        list.innerHTML = '';
                        CONFIGURABLE_COLUMNS.forEach((col) => {
                            list.appendChild(buildRow(col, !DEFAULT_HIDDEN.includes(col.key)));
                        });
                        return false;
                    }
                },
                { label: 'Отмена', variant: 'ghost', role: 'columns-cancel', value: false },
                { label: 'Применить', role: 'columns-apply', onClick: () => handleApply(list) }
            ]
        });
        modal.result.then(() => { modal = null; });

        const first = list.querySelector('input[type="checkbox"]');
        if (first) first.focus();
    }

    function buildRow(col, checked) {
        const row = document.createElement('div');
        row.className = 'cpa-cols__row';
        row.draggable = true;
        row.dataset.columnKey = col.key;

        // Ручка — не кнопка слоя: она ничего не делает по нажатию, она метка
        // того, что строку можно тащить. Своего значка «шесть точек» в наборе
        // нет, и заводить его ради одного места дороже, чем взять символ.
        const grip = document.createElement('span');
        grip.className = 'cpa-cols__grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.textContent = '⠿';

        const label = document.createElement('label');
        label.className = 'ui-check';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.columnKey = col.key;
        checkbox.checked = checked;
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(col.label));

        row.appendChild(grip);
        row.appendChild(label);
        return row;
    }

    // ПЕРЕТАСКИВАНИЕ. Держится на встроенном HTML5 drag-and-drop, без
    // библиотеки: строк двадцать пять, список свой, и внешней зависимости ради
    // одного окна проект не заводит.
    //
    // Строка вставляется ПЕРЕД той, над верхней половиной которой отпустили, и
    // ПОСЛЕ той, над нижней: иначе последнее место в списке недостижимо —
    // «после последней» было бы некуда положить.
    function wireDrag(list) {
        let dragged = null;

        list.addEventListener('dragstart', (event) => {
            const row = event.target.closest('.cpa-cols__row');
            if (!row) return;
            dragged = row;
            row.classList.add('is-dragging');
            // Firefox не начинает перетаскивание без данных в буфере.
            event.dataTransfer.setData('text/plain', row.dataset.columnKey);
            event.dataTransfer.effectAllowed = 'move';
        });

        list.addEventListener('dragend', () => {
            if (dragged) dragged.classList.remove('is-dragging');
            dragged = null;
            list.querySelectorAll('.cpa-cols__row').forEach((r) => r.classList.remove('is-over'));
        });

        list.addEventListener('dragover', (event) => {
            if (!dragged) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const over = event.target.closest('.cpa-cols__row');
            list.querySelectorAll('.cpa-cols__row').forEach((r) => r.classList.remove('is-over'));
            if (over && over !== dragged) over.classList.add('is-over');
        });

        list.addEventListener('drop', (event) => {
            if (!dragged) return;
            event.preventDefault();
            const over = event.target.closest('.cpa-cols__row');
            if (!over || over === dragged) return;
            const box = over.getBoundingClientRect();
            const after = event.clientY > box.top + box.height / 2;
            over.parentNode.insertBefore(dragged, after ? over.nextSibling : over);
            over.classList.remove('is-over');
        });
    }

    async function handleApply(list) {
        const rows = Array.from(list.querySelectorAll('.cpa-cols__row'));
        const hiddenColumns = rows
            .filter((row) => !row.querySelector('input[type="checkbox"]').checked)
            .map((row) => row.dataset.columnKey);

        writeHiddenColumns(SECTION, hiddenColumns);
        writeColumnOrder(SECTION, rows.map((row) => row.dataset.columnKey));
        if (onApplied) await onApplied();
        toast('Настройки колонок сохранены', 'success');
    }

    function init() {
        const btn = root.querySelector('[data-role="columns-btn"]');
        if (btn) btn.addEventListener('click', openColumnsModal);
    }

    return { init, isOpen: () => modal !== null };
}
