// --- cpaFilter.js: отбор офферов по всем полям ------------------------------
//
// Задача владельца от 01.09.2026, секция 1. Было: поиск по названию и вкладки
// статусов. Стало: окно фильтра по всем полям оффера; вкладки статусов сняты,
// статус переехал в окно (решение владельца).
//
// ОТБИРАЕТ БРАУЗЕР, А НЕ СЕРВЕР, и это не экономия усилий: список офферов сети
// уже приходит целиком СО ВСЕМИ вложенными списками — сегментами, географией,
// способами покупки и видами ипотеки (`routes/realEstateOffers.js:279-304`).
// Второй запрос за теми же данными был бы платой без покупки.
//
// ⚠ ПРЕДЕЛ ЭТОГО РЕШЕНИЯ НАЗВАН ЗАРАНЕЕ. В коде подбора офферов лиду записано
// «Офферов в базе ≈38 000» (`Leads/js/modules/leadsOffers.js:2`), а замер на
// бою 27.08.2026 — 39 у всех сетей вместе (`schema.sql:474`). Пока их десятки,
// клиентский отбор верен. Когда в ОДНОЙ сети станут тысячи, упрётся не фильтр,
// а сама загрузка списка: она и сегодня тянет всё разом. Это отдельная работа,
// и она не про фильтр.
//
// ЯЗЫК ОКНА ВЗЯТ ИЗ МАКЕТА СКЛАДКИ `a8dba108` (дизайн-сессия, 01.09.2026),
// раздел «что переносимо в окно»:
//   орган открытия — `.ui-btn--ghost` со значком `filter`, обёртка
//     `.ui-count-wrap`, счётчик `.ui-count .ui-count--corner`;
//   счётчик считает ТОЛЬКО поля отбора, поиск — нет, при нуле скрыт (К-Ф4);
//   «Сбросить» — действие подвала `side: 'start'`, вид `secondary`, окно НЕ
//     закрывает.
// Группы — свои: деление окна лидов («кто · что ищет · диапазоны · география ·
// покупка») про лида, а у оффера предмет другой. Заголовок группы тоже свой,
// уже написанный: `.cpa-form-sec`.
//
// РЕШЕНИЯ ВЛАДЕЛЬЦА, КОТОРЫЕ ЗДЕСЬ ИСПОЛНЕНЫ:
//   множественные поля — «все выбранные сразу»: отметил студию и двушку —
//     оффер обязан принимать ОБЕ;
//   сегменты — «хотя бы одна строка подходит»;
//   период — «сроки пересекаются»;
//   отбор НЕ переживает закрытие панели: открыл заново — фильтр чист;
//   отрицательные числа отбиваются отказом (К269/К270).

import { openModal } from '/ui/modal.js';

// Поля отбора. `kind` говорит, КАК поле сравнивается, а не как выглядит:
//   text     — подстрока без учёта регистра
//   select   — точное совпадение с одиночным значением оффера
//   multi    — набор значений: оффер обязан содержать ВСЕ отмеченные
//   range    — «от — до» по числу оффера
//   segRange — «от — до» по сегментам: подходит, если подошёл ХОТЯ БЫ ОДИН
//   segMulti — набор по сегментам: хотя бы один сегмент несёт все отмеченные
//   period   — пересечение сроков
//   bool     — да / нет / всё равно
//   geo      — подстрока по строкам географии своего вида
export const FILTER_GROUPS = [
    {
        title: 'Оффер',
        sub: 'что это и в каком он состоянии',
        fields: [
            { key: 'status', label: 'Статус', kind: 'select', from: 'statuses' },
            { key: 'category', label: 'Категория', kind: 'select', list: 'category' },
            { key: 'actionType', label: 'Тип действия', kind: 'select', list: 'actionType' },
            { key: 'leadCheck', label: 'Наличие проверки лидов', kind: 'select', list: 'leadCheck' },
            { key: 'developer', label: 'Застройщик', kind: 'text' },
            { key: 'targetCriteria', label: 'Критерии целевого лида', kind: 'text' },
            { key: 'nonTargetCriteria', label: 'Критерии нецелевого лида', kind: 'text' }
        ]
    },
    {
        title: 'Условия',
        sub: 'деньги, сроки и пределы',
        fields: [
            { key: 'rate', label: 'Ставка, ₽', kind: 'range' },
            { key: 'holdDays', label: 'Hold, дней', kind: 'range' },
            { key: 'priority', label: 'Приоритет', kind: 'range' },
            { key: 'leadLimit', label: 'Лимит лидов', kind: 'range' },
            { key: 'period', label: 'Период действия', kind: 'period' }
        ]
    },
    {
        title: 'Объект',
        sub: 'что предлагается клиенту',
        fields: [
            { key: 'objTypes', label: 'Тип объекта', kind: 'multi', list: 'objType' },
            { key: 'finishes', label: 'Отделка', kind: 'multi', list: 'finish' },
            { key: 'deadline', label: 'Срок сдачи', kind: 'select', list: 'deadline' },
            { key: 'segObjectClass', label: 'Класс объекта (в сегменте)', kind: 'segMulti', seg: 'objectClass', list: 'objClass' },
            { key: 'segRoomCount', label: 'Комнатность (в сегменте)', kind: 'segMulti', seg: 'roomCount', list: 'rooms' },
            { key: 'segPrice', label: 'Цена сегмента, ₽', kind: 'segRange', segMin: 'priceMin', segMax: 'priceMax' },
            { key: 'segArea', label: 'Площадь сегмента, м²', kind: 'segRange', segMin: 'areaMin', segMax: 'areaMax' }
        ]
    },
    {
        title: 'Клиент и покупка',
        sub: 'кому подходит и как берёт',
        fields: [
            { key: 'clientTypes', label: 'Тип клиента', kind: 'multi', list: 'clientType' },
            { key: 'otherBorrower', label: 'Иной заёмщик', kind: 'bool' },
            { key: 'purchaseTerm', label: 'Срок покупки', kind: 'select', list: 'purchaseTerm' },
            { key: 'downPaymentPercent', label: 'Первоначальный взнос, %', kind: 'range' },
            { key: 'paymentMethods', label: 'Способ покупки', kind: 'multi', list: 'paymentMethod' },
            { key: 'mortgageTypes', label: 'Виды ипотеки', kind: 'multi', list: 'mortgageType' }
        ]
    },
    {
        title: 'География',
        sub: 'где объект и откуда клиент',
        fields: [
            { key: 'objGeoRegion', label: 'Область объекта', kind: 'geo', geo: 'objGeo', part: 'region' },
            { key: 'objGeoCity', label: 'Город объекта', kind: 'geo', geo: 'objGeo', part: 'city' },
            { key: 'objGeoDistrict', label: 'Район объекта', kind: 'geo', geo: 'objGeo', part: 'district' },
            { key: 'objGeoLocality', label: 'Населённый пункт объекта', kind: 'geo', geo: 'objGeo', part: 'locality' },
            { key: 'clientGeoRegion', label: 'Область клиента', kind: 'geo', geo: 'clientGeo', part: 'region' },
            { key: 'clientGeoCity', label: 'Город клиента', kind: 'geo', geo: 'clientGeo', part: 'city' },
            { key: 'clientGeoDistrict', label: 'Район клиента', kind: 'geo', geo: 'clientGeo', part: 'district' },
            { key: 'clientGeoLocality', label: 'Населённый пункт клиента', kind: 'geo', geo: 'clientGeo', part: 'locality' }
        ]
    }
];

export const FILTER_FIELDS = FILTER_GROUPS.reduce((acc, g) => acc.concat(g.fields), []);

/** Пустой отбор. Ни одно поле не задано. */
export function emptyFilters() {
    const out = {};
    FILTER_FIELDS.forEach((f) => {
        if (f.kind === 'range' || f.kind === 'segRange') out[f.key] = { min: '', max: '' };
        else if (f.kind === 'period') out[f.key] = { from: '', to: '' };
        else if (f.kind === 'multi' || f.kind === 'segMulti') out[f.key] = [];
        else out[f.key] = '';
    });
    return out;
}

/** Сколько условий наложено. Считаются ТОЛЬКО поля окна — поиск не в счёт. */
export function countActive(filters) {
    return FILTER_FIELDS.filter((f) => isSet(f, filters[f.key])).length;
}

function isSet(field, value) {
    if (value === undefined || value === null) return false;
    if (field.kind === 'range' || field.kind === 'segRange') return value.min !== '' || value.max !== '';
    if (field.kind === 'period') return value.from !== '' || value.to !== '';
    if (field.kind === 'multi' || field.kind === 'segMulti') return value.length > 0;
    return String(value).trim() !== '';
}

// ---------------------------------------------------------------- отбор

/** Подходит ли оффер под весь набор условий. */
export function offerMatches(offer, filters) {
    return FILTER_FIELDS.every((f) => {
        const value = filters[f.key];
        if (!isSet(f, value)) return true;
        return fieldMatches(offer, f, value);
    });
}

function fieldMatches(offer, field, value) {
    switch (field.kind) {
        case 'text':
            return String(offer[field.key] || '').toLowerCase().includes(String(value).toLowerCase().trim());
        case 'select':
            return String(offer[field.key] || '') === String(value);
        case 'bool':
            return Boolean(offer[field.key]) === (value === 'yes');
        // «Все выбранные сразу» — решение владельца: отметил два значения,
        // значит оффер обязан принимать ОБА, а не любое из них.
        case 'multi': {
            const have = Array.isArray(offer[field.key]) ? offer[field.key] : [];
            return value.every((v) => have.includes(v));
        }
        case 'range':
            return inRange(offer[field.key], value);
        // «Хотя бы одна строка подходит» — решение владельца: у оффера две
        // вилки цен, одна попала в отбор — оффер в выдаче.
        case 'segRange':
            return (offer.segments || []).some((s) => segmentInRange(s, field, value));
        case 'segMulti': {
            const have = (offer.segments || []).map((s) => s[field.seg]).filter(Boolean);
            return value.every((v) => have.includes(v));
        }
        case 'period':
            return periodOverlaps(offer, value);
        case 'geo':
            return (offer[field.geo] || []).some((g) =>
                String(g[field.part] || '').toLowerCase().includes(String(value).toLowerCase().trim()));
        default:
            return true;
    }
}

function inRange(raw, { min, max }) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return false;
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    if (min !== '' && n < Number(min)) return false;
    if (max !== '' && n > Number(max)) return false;
    return true;
}

// У сегмента своя вилка, и сравниваются ВИЛКИ, а не числа: сегмент подходит,
// если его диапазон ПЕРЕСЕКАЕТСЯ с заданным. Пустая граница у сегмента —
// «без предела с этой стороны», а не ноль.
function segmentInRange(segment, field, { min, max }) {
    const lo = segment[field.segMin];
    const hi = segment[field.segMax];
    const segLo = lo === null || lo === undefined || String(lo).trim() === '' ? -Infinity : Number(lo);
    const segHi = hi === null || hi === undefined || String(hi).trim() === '' ? Infinity : Number(hi);
    if (!Number.isFinite(segLo) && segLo !== -Infinity) return false;
    if (!Number.isFinite(segHi) && segHi !== Infinity) return false;
    const askLo = min === '' ? -Infinity : Number(min);
    const askHi = max === '' ? Infinity : Number(max);
    return segHi >= askLo && segLo <= askHi;
}

// «Сроки пересекаются» — решение владельца. Оффер с 1 марта по 30 июня
// попадает в отбор «март–апрель», потому что общие дни есть.
function periodOverlaps(offer, { from, to }) {
    const start = offer.dateStart || null;
    const end = offer.dateEnd || null;
    if (from !== '' && end !== null && String(end) < String(from)) return false;
    if (to !== '' && start !== null && String(start) > String(to)) return false;
    return true;
}

// ---------------------------------------------------------------- окно

const NEGATIVE_HINT = 'Отрицательное значение здесь не бывает';

/**
 * @param {HTMLElement} root контейнер панели
 * @param {Object} deps { getFilters, getLists, getStatuses, onApplied, toast }
 */
export function createFilter(root, deps) {
    const { getFilters, setFilters, getLists, getStatuses, onApplied, toast } = deps;
    let modal = null;

    function openFilterModal() {
        if (modal) return;
        const draft = JSON.parse(JSON.stringify(getFilters()));
        const lists = getLists();
        const statuses = getStatuses();

        const body = document.createElement('div');
        FILTER_GROUPS.forEach((group) => body.appendChild(buildGroup(group, draft, lists, statuses)));

        modal = openModal({
            title: 'Фильтры офферов',
            sub: `${FILTER_FIELDS.length} полей, пять групп`,
            body,
            scope: root,
            size: 'xwide',
            actions: [
                {
                    // «Сбросить» очищает поля и ОСТАЁТСЯ в окне: человек видит,
                    // что получится, и применяет сам. Место — подвал слева,
                    // как в макете складки.
                    label: 'Сбросить',
                    variant: 'secondary',
                    side: 'start',
                    role: 'filter-reset',
                    onClick: () => {
                        const clean = emptyFilters();
                        Object.keys(clean).forEach((k) => { draft[k] = clean[k]; });
                        body.innerHTML = '';
                        FILTER_GROUPS.forEach((g) => body.appendChild(buildGroup(g, draft, lists, statuses)));
                        return false;
                    }
                },
                { label: 'Отмена', variant: 'ghost', role: 'filter-cancel', value: false },
                { label: 'Применить', role: 'filter-apply', onClick: () => apply(body, draft) }
            ]
        });
        modal.result.then(() => { modal = null; });
    }

    function apply(body, draft) {
        // Отрицательные отбиваются ОТКАЗОМ, а не молчаливым исправлением
        // (К269/К270): человек, набравший «-500», должен узнать, что так
        // нельзя, а не гадать, почему выдача не изменилась.
        const bad = body.querySelector('input[type="number"][data-bad="1"]');
        if (bad) {
            toast(NEGATIVE_HINT, 'error');
            bad.focus();
            return false;
        }
        setFilters(draft);
        if (onApplied) onApplied();
        return true;
    }

    function buildGroup(group, draft, lists, statuses) {
        const box = document.createElement('div');

        const head = document.createElement('div');
        head.className = 'cpa-form-sec';
        const h3 = document.createElement('h3');
        h3.textContent = group.title;
        const sub = document.createElement('span');
        sub.textContent = group.sub;
        head.appendChild(h3);
        head.appendChild(sub);
        box.appendChild(head);

        const grid = document.createElement('div');
        grid.className = 'ui-form-grid';
        group.fields.forEach((f) => grid.appendChild(buildField(f, draft, lists, statuses)));
        box.appendChild(grid);
        return box;
    }

    function buildField(field, draft, lists, statuses) {
        const wrap = document.createElement('div');
        // ⚠⚠ ВО ВСЮ ШИРИНУ — ТОЛЬКО ЧИПАМ (К316), а было всем 33 полям без
        // разбора. `--wide` в слое означает `grid-column: 1 / -1`
        // (field.css:299) — «на все колонки сетки». Сетка при этом
        // многоколоночная: `repeat(auto-fit, minmax(220px, 1fr))`
        // (field.css:279). Пока модификатор стоял у каждого поля, КАЖДАЯ
        // ячейка растягивалась на всю ширину — и окно выглядело
        // одностолбцовым при любой ширине коробки. Расширение окна без этой
        // правки не дало бы ничего: столбец просто стал бы длиннее.
        //
        // Чипам ширина нужна по делу: ряд переносится сам, и в ячейке 252 он
        // встал бы лесенкой. Их семь из 33 — пять `multi` и два `segMulti`.
        const wide = field.kind === 'multi' || field.kind === 'segMulti';
        wrap.className = wide ? 'ui-field ui-field--wide' : 'ui-field';
        const label = document.createElement('label');
        label.className = 'ui-field__label';
        label.textContent = field.label;
        wrap.appendChild(label);

        if (field.kind === 'range' || field.kind === 'segRange') {
            wrap.appendChild(buildPair(field, draft, 'number', ['min', 'max'], ['от', 'до']));
        } else if (field.kind === 'period') {
            wrap.appendChild(buildPair(field, draft, 'date', ['from', 'to'], ['с', 'по']));
        } else if (field.kind === 'multi' || field.kind === 'segMulti') {
            wrap.appendChild(buildChoices(field, draft, lists));
        } else if (field.kind === 'select') {
            wrap.appendChild(buildSelect(field, draft, lists, statuses));
        } else if (field.kind === 'bool') {
            wrap.appendChild(buildBool(field, draft));
        } else {
            const input = document.createElement('input');
            input.className = 'ui-field__control';
            input.type = 'text';
            input.value = draft[field.key] || '';
            input.addEventListener('input', () => { draft[field.key] = input.value; });
            wrap.appendChild(input);
        }
        return wrap;
    }

    function buildPair(field, draft, type, keys, marks) {
        const row = document.createElement('div');
        row.className = 'cpa-range';
        keys.forEach((k, index) => {
            if (index === 1) {
                const dash = document.createElement('span');
                dash.textContent = '—';
                row.appendChild(dash);
            }
            const input = document.createElement('input');
            input.className = 'ui-field__control';
            input.type = type;
            input.placeholder = marks[index];
            input.setAttribute('aria-label', `${field.label}, ${marks[index]}`);
            if (type === 'number') input.min = '0';
            input.value = draft[field.key][k] || '';
            input.addEventListener('input', () => {
                draft[field.key][k] = input.value;
                if (type !== 'number') return;
                // Ошибку показывает СЛОЙ, и вид её объявлен на обёртке поля
                // (`.ui-field--error`, ui/field.css:136), а не на самом
                // органе: своего класса ошибки у контрола в слое нет, и
                // заводить его здесь значило бы объявить чужой узел.
                const negative = input.value !== '' && Number(input.value) < 0;
                input.dataset.bad = negative ? '1' : '';
                const box = input.closest('.ui-field');
                if (box) box.classList.toggle('ui-field--error', Boolean(box.querySelector('[data-bad="1"]')));
            });
            row.appendChild(input);
        });
        return row;
    }

    function buildSelect(field, draft, lists, statuses) {
        const select = document.createElement('select');
        select.className = 'ui-field__control';
        const values = field.from === 'statuses' ? statuses : (lists[field.list] || []).map((v) => [v, v]);
        select.appendChild(new Option('Все', ''));
        values.forEach(([value, label]) => select.appendChild(new Option(label, value)));
        select.value = draft[field.key] || '';
        select.addEventListener('change', () => { draft[field.key] = select.value; });
        return select;
    }

    function buildBool(field, draft) {
        const select = document.createElement('select');
        select.className = 'ui-field__control';
        select.appendChild(new Option('Все', ''));
        select.appendChild(new Option('да', 'yes'));
        select.appendChild(new Option('нет', 'no'));
        select.value = draft[field.key] || '';
        select.addEventListener('change', () => { draft[field.key] = select.value; });
        return select;
    }

    // Множественный выбор — чипами слоя, как у типа и класса объекта в форме
    // оффера этого же раздела. Ряд — `.ui-choices`, тоже из слоя.
    function buildChoices(field, draft, lists) {
        const row = document.createElement('div');
        row.className = 'ui-choices';
        (lists[field.list] || []).forEach((value) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ui-choice';
            chip.textContent = value;
            const on = draft[field.key].includes(value);
            if (on) chip.classList.add('ui-choice--on');
            chip.setAttribute('aria-pressed', on ? 'true' : 'false');
            chip.addEventListener('click', () => {
                const at = draft[field.key].indexOf(value);
                if (at === -1) draft[field.key].push(value); else draft[field.key].splice(at, 1);
                const nowOn = at === -1;
                chip.classList.toggle('ui-choice--on', nowOn);
                chip.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
            });
            row.appendChild(chip);
        });
        if (!row.children.length) {
            const note = document.createElement('span');
            note.className = 'ui-field__hint';
            note.textContent = 'Справочник пуст — заполните его в «Настройке списков»';
            row.appendChild(note);
        }
        return row;
    }

    function init() {
        const btn = root.querySelector('[data-role="filter-btn"]');
        if (btn) btn.addEventListener('click', openFilterModal);
    }

    return { init, isOpen: () => modal !== null };
}
