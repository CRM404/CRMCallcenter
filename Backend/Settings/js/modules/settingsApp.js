// --- Settings/js/modules/settingsApp.js: раздел «Настройки» (Б9.2) ---------
//
// Контракт раздела оболочки:
//     export async function mount(container, ctx)
//     export function unmount()
//
// ЭКРАН НЕ ЗНАЕТ НИ ОДНОГО КЛЮЧА НАСТРОЙКИ. Имя, описание, тип значения,
// единица, группа и порядок приходят с сервера как данные (`app_settings`).
// Список ключей, зашитый сюда, разошёлся бы с таблицей на второй же новой
// настройке — и это ровно то, ради чего таблица сделана такой (паспорт Р8).
//
// СОХРАНЕНИЕ — ПО СТРОКЕ, а не кнопкой внизу. Разбор в settingsStorage.js.
//
// ВЫКЛЮЧАТЕЛЬ КНОПОК НЕ ЗАВОДИТ ВОВСЕ: переключение — само по себе действие, и
// промежуточного «набрано, но не сохранено» у него не бывает.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
//
//   ПЛАШКИ ВКЛЮЧЁННОГО АВТООБЗВОНА И ОКНА ПОДТВЕРЖДЕНИЯ — ответ куратора 32.
//     Дозвонщика в проекте нет, включать нечего, и три факта в окне («412 лидов
//     в очереди», «ближайшее окно», «попыток на лида») сегодня считать не из
//     чего: рабочее окно и предел попыток уехали в `call_events` и стали
//     пособытийными. Вернутся работой Е4.
//
//   ВОПРОСА ПРИ УХОДЕ С НЕСОХРАНЁННОЙ СТРОКОЙ. Паспорт его требует, а оболочка
//     сделать этого не даёт: `unmount()` синхронный и его ответ не читается
//     (`Shell/shell/app.js:350`) — отменить закрытие панели разделу нечем.
//     Названо в докладе куратору, чинится правкой контракта оболочки, а не
//     здесь.

import { isAbort } from '/api.js';
import { iconNode } from '/ui/icons.js';
import { fetchSettings, saveSetting } from './settingsStorage.js';

// ---------------------------------------------------------------- тексты
//
// Все до одного взяты из паспорта Р8 и макета `3d1154f6` дословно. Собирать их
// по месту нельзя: текст, набранный дважды, расходится на первой же правке.
const T = {
    sub: 'поведение системы: тумблеры, окна времени, пороги',
    off: 'Выключен',
    on: 'Включён',
    cancel: 'Отмена',
    save: 'Сохранить',
    saving: 'Сохраняю…',
    noAuthor: 'автор не указан',
    notSet: 'Не задано',
    defaultFromCode: 'Не задано — работает умолчание из кода',
    readonlyWhy: 'Только чтение: по ней журнал отличает «не меняли» от «ещё не записывали»',
    errInt: 'Нужно целое число',
    errPercent: 'Доля задаётся числом от 0 до 100',
    errRange: 'Конец окна должен быть позже начала',
    errTime: 'Окно задаётся как ЧЧ:ММ',
    errEmpty: 'Значение не может быть пустым'
};

const instances = [];

export async function mount(container, ctx) {
    const self = createSection(container, ctx);
    instances.push(self);
    await self.start();
}

export function unmount() {
    while (instances.length) instances.pop().destroy();
}

function createSection(container, ctx) {
    const listNode = container.querySelector('[data-role="settings-list"]');

    // Поколение живёт ровно столько, сколько живёт раздел. Ответ сервера,
    // пришедший после закрытия панели, рисовать некуда — контейнер к этому
    // моменту вырезан из документа.
    let alive = true;
    let rows = [];

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    // ------------------------------------------------------------ значения

    const isEmpty = (v) => v === null || v === undefined || v === '';

    /**
     * Единица приписывается к числу ПРОБЕЛОМ и только если она есть. Настройка
     * без единицы («адрес») не должна получить висящий хвост.
     */
    function withUnit(value, unit) {
        return unit ? `${value} ${unit}` : String(value);
    }

    /** Дата журнала: «21.08.2026, 14:02». */
    function stamp(raw) {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) return String(raw);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /** Как значение читается человеком — в подписи «Было …» и в замке. */
    function human(row, value) {
        if (isEmpty(value)) return T.notSet;
        if (row.valueType === 'date') return stamp(value);
        if (row.valueType === 'switch') return value === 'true' ? T.on : T.off;
        if (row.valueType === 'time_range') return String(value).replace('—', ' — ');
        return withUnit(value, row.unit);
    }

    // ------------------------------------------------------------ проверки
    //
    // ЭКРАН ПРОВЕРЯЕТ ФОРМУ, СЕРВЕР ПРОВЕРЯЕТ СМЫСЛ (паспорт Р8). Пределов
    // «от 1 до 24» здесь нет намеренно: они живут на сервере, потому что до
    // сервера можно дойти и мимо экрана. Отказ сервера приходит тостом и
    // называет предел числом.
    function checkDraft(row, draft) {
        switch (row.valueType) {
            case 'number':
                return /^\d+$/.test(draft) ? null : T.errInt;
            case 'percent': {
                if (!/^\d+$/.test(draft)) return T.errInt;
                const n = Number(draft);
                return n >= 0 && n <= 100 ? null : T.errPercent;
            }
            case 'time_range': {
                const parts = String(draft).split('—');
                if (parts.length !== 2) return T.errTime;
                const mins = parts.map((p) => {
                    const m = /^(\d{2}):(\d{2})$/.exec(p);
                    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
                    return Number(m[1]) * 60 + Number(m[2]);
                });
                if (mins.some((m) => m === null)) return T.errTime;
                return mins[1] > mins[0] ? null : T.errRange;
            }
            case 'text':
                return String(draft).trim() === '' ? T.errEmpty : null;
            default:
                return null;
        }
    }

    // ------------------------------------------------------------ отрисовка

    function render() {
        listNode.innerHTML = '';

        // Группы собираются ОБХОДОМ УЖЕ ОТСОРТИРОВАННОГО списка, а не
        // группировкой по ключу с последующей сортировкой групп. `group_order`
        // задаёт место строки в СПЛОШНОМ списке — значит порядок групп выходит
        // сам, и второй сортировки не нужно. Заодно перестановка двух строк
        // между группами не может незаметно поменять порядок самих групп.
        // НАЧАЛЬНОЕ ЗНАЧЕНИЕ — `undefined`, А НЕ `null`, И ЭТО НЕ ПРИДИРКА.
        // `group_key` может прийти пустым: настройку завели запросом мимо
        // экрана и метаданные не проставили. С `null` условие «группа
        // сменилась» у такой ПЕРВОЙ строки давало ложь, карточка не
        // создавалась, и строка ложилась в несуществующий узел — падал весь
        // раздел, вместе с шестью здоровыми строками. `undefined` не равен
        // ни одному значению из базы, включая пустое.
        let group;
        let listBox = null;

        rows.forEach((row) => {
            if (row.groupKey !== group || listBox === null) {
                group = row.groupKey;
                const groupBox = el('div', 'set-group');
                // Заголовок группы — САМ `group_key`, а не ярлык, который
                // раздел переводит в текст: таблица «ярлык → заголовок» в коде
                // это то же, от чего уводит вся эта таблица.
                // Заголовок безымянной группы остаётся ПУСТЫМ, а не получает
                // выдуманное имя вроде «Прочее»: настройка без метаданных
                // обязана выглядеть недоделанной, а не обычной.
                groupBox.appendChild(el('div', 'set-group__name', group || ''));
                listBox = el('div', 'set-list');
                groupBox.appendChild(listBox);
                listNode.appendChild(groupBox);
            }
            listBox.appendChild(renderRow(row));
        });
    }

    function renderRow(row) {
        const edited = !row.isReadonly && row.draft !== undefined && row.draft !== (row.value === null ? '' : row.value);
        const error = edited ? checkDraft(row, row.draft) : null;

        const box = el('div', 'set-row');
        if (row.isDangerous) box.classList.add('set-row--danger');
        if (edited) box.classList.add('set-row--edited');
        box.dataset.key = row.key;

        const main = el('div', 'set-row__main');
        const name = el('div', 'set-row__name');
        // Значок опасной строки — второй сигнал для беглого просмотра. Цвет
        // пишет слой (`.ui-ic--warn`), раздел цветов значков не пишет.
        if (row.isDangerous) name.appendChild(iconNode('warn', 'sm', 'ui-ic--warn'));
        name.appendChild(document.createTextNode(row.title || row.key));
        main.appendChild(name);
        main.appendChild(el('div', 'set-row__desc', row.description || ''));

        const meta = metaText(row, edited);
        if (meta) main.appendChild(el('div', 'set-row__meta', meta));
        box.appendChild(main);

        const ctl = el('div', 'set-row__ctl');
        if (row.isReadonly) {
            // НЕ ПОЛЕ С ОТКЛЮЧЁННЫМ ВИДОМ: отключённое поле обещает, что его
            // когда-нибудь включат. Фокус эта строка не берёт вовсе — это
            // текст, а не поле.
            ctl.appendChild(el('div', 'set-lock', human(row, row.value)));
            ctl.appendChild(el('span', 'set-lock__why', T.readonlyWhy));
        } else if (row.valueType === 'switch') {
            ctl.appendChild(renderSwitch(row));
        } else {
            ctl.appendChild(renderField(row, edited, error));
            if (edited) ctl.appendChild(renderActs(row, error));
        }
        box.appendChild(ctl);
        return box;
    }

    /**
     * Подпись строки.
     *
     * У НЕТРОНУТОЙ НАСТРОЙКИ ПОДПИСИ НЕТ ВОВСЕ. На свежей системе все семь
     * заводятся одним запросом в одну секунду, и семь одинаковых подписей
     * сказали бы, что кто-то семь раз что-то менял. Признак «правил человек»
     * приходит с сервера отдельным полем `changed` — он собран по журналу
     * изменений, а не по `updated_at`, который есть и у засеянной строки.
     */
    function metaText(row, edited) {
        if (edited) return `Было ${human(row, row.value)} · изменено, не сохранено`;
        if (row.saving) return T.saving;
        if (!row.changed) return '';
        const who = row.changed.actorName || T.noAuthor;
        return `Изменено ${stamp(row.changed.at)} · ${who}`;
    }

    function renderSwitch(row) {
        const box = el('div', 'ui-switch');
        [['false', T.off], ['true', T.on]].forEach(([value, label]) => {
            const btn = el('button', 'ui-switch__option', label);
            btn.type = 'button';
            if ((row.value === 'true') === (value === 'true')) btn.classList.add('ui-switch__option--active');
            btn.disabled = Boolean(row.saving);
            btn.addEventListener('click', () => {
                if (row.value === value) return;
                commit(row, value);
            });
            box.appendChild(btn);
        });
        return box;
    }

    function renderField(row, edited, error) {
        const field = el('div', 'ui-field');
        if (row.valueType === 'text') field.classList.add('ui-field--mono');
        if (error) field.classList.add('ui-field--error');

        const draft = edited ? row.draft : (row.value === null ? '' : row.value);

        if (row.valueType === 'time_range') {
            const parts = String(draft).split('—');
            const wrap = el('div', 'set-range');
            const from = timeInput(row, parts[0] || '', 0, 'Начало окна');
            const to = timeInput(row, parts[1] || '', 1, 'Конец окна');
            wrap.appendChild(from);
            wrap.appendChild(el('span', 'set-range__dash', '—'));
            wrap.appendChild(to);
            field.appendChild(wrap);
        } else if (row.valueType === 'number' || row.valueType === 'percent') {
            const wrap = el('div', 'set-num');
            wrap.appendChild(textInput(row, draft, row.title));
            if (row.unit) wrap.appendChild(el('span', 'set-unit', row.unit));
            field.appendChild(wrap);
        } else {
            field.appendChild(textInput(row, draft, row.title));
        }

        if (error) {
            field.appendChild(el('span', 'ui-field__error', error));
        } else if (!edited && isEmpty(row.value)) {
            // НЕЗАДАННОЕ ЗНАЧЕНИЕ — СОСТОЯНИЕ СТРОКИ, А НЕ ПУСТОЙ ЭКРАН.
            // Человек должен видеть, что система не встала, а работает по
            // значению из кода. Умолчание называется ЧИСЛОМ, когда оно есть, —
            // ради этого колонка `default_value` и заведена.
            const hint = isEmpty(row.defaultValue)
                ? T.defaultFromCode
                : `Не задано — работает умолчание ${withUnit(row.defaultValue, row.unit)}`;
            field.appendChild(el('span', 'ui-field__hint', hint));
        }
        return field;
    }

    function textInput(row, value, label) {
        const input = el('input', 'ui-field__control ui-field__control--sm');
        input.type = 'text';
        input.value = value;
        input.disabled = Boolean(row.saving);
        if (label) input.setAttribute('aria-label', label);
        input.addEventListener('input', () => draftChanged(row, input.value));
        input.addEventListener('keydown', (e) => keys(e, row));
        return input;
    }

    function timeInput(row, value, half, label) {
        const input = el('input', 'ui-field__control ui-field__control--sm');
        input.type = 'text';
        input.value = value;
        input.disabled = Boolean(row.saving);
        input.setAttribute('aria-label', label);
        input.dataset.half = String(half);
        input.addEventListener('input', () => {
            // Окно — ОДНА настройка из двух половин, и в базе оно лежит одной
            // строкой. Собираем её из обеих половин, а не заводим два черновика.
            const box = input.closest('.set-range');
            const halves = Array.from(box.querySelectorAll('.ui-field__control')).map((i) => i.value);
            draftChanged(row, halves.join('—'));
        });
        input.addEventListener('keydown', (e) => keys(e, row));
        return input;
    }

    function renderActs(row, error) {
        const acts = el('div', 'set-acts');

        const cancel = el('button', 'ui-btn ui-btn--ghost', T.cancel);
        cancel.type = 'button';
        cancel.dataset.role = 'cancel';
        // «Отмена» НЕ отключается ошибкой: выход из неверного значения обязан
        // остаться открытым.
        cancel.disabled = Boolean(row.saving);
        cancel.addEventListener('click', () => discard(row));

        const save = el('button', 'ui-btn', row.saving ? T.saving : T.save);
        save.type = 'button';
        save.dataset.role = 'save';
        save.disabled = Boolean(error) || Boolean(row.saving);
        save.addEventListener('click', () => commit(row, row.draft));

        acts.appendChild(cancel);
        acts.appendChild(save);
        return acts;
    }

    // ------------------------------------------------------------ поведение

    function keys(e, row) {
        if (e.key === 'Enter') {
            e.preventDefault();
            // Enter при неверном значении не делает НИЧЕГО — не сохраняет и не
            // отменяет. Иначе он либо теряет правку, либо шлёт на сервер то,
            // что экран уже назвал неверным.
            if (!checkDraft(row, row.draft === undefined ? '' : row.draft)) commit(row, row.draft);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            discard(row);
        }
    }

    /**
     * Черновик меняется БЕЗ перерисовки поля — иначе каждый набранный знак
     * уносил бы курсор в конец строки. Перерисовывается только обрамление:
     * полоса строки, подпись и кнопки.
     */
    function draftChanged(row, value) {
        row.draft = value;
        repaintAround(row);
    }

    function repaintAround(row) {
        const box = listNode.querySelector(`.set-row[data-key="${cssEscape(row.key)}"]`);
        if (!box) return;

        const edited = row.draft !== undefined && row.draft !== (row.value === null ? '' : row.value);
        const error = edited ? checkDraft(row, row.draft) : null;

        box.classList.toggle('set-row--edited', edited);

        const main = box.querySelector('.set-row__main');
        let meta = main.querySelector('.set-row__meta');
        const text = metaText(row, edited);
        if (text && !meta) {
            meta = el('div', 'set-row__meta');
            main.appendChild(meta);
        }
        if (meta) {
            meta.textContent = text;
            meta.hidden = !text;
        }

        const field = box.querySelector('.ui-field');
        if (field) {
            field.classList.toggle('ui-field--error', Boolean(error));
            let errNode = field.querySelector('.ui-field__error');
            if (error && !errNode) {
                errNode = el('span', 'ui-field__error');
                field.appendChild(errNode);
            }
            if (errNode) errNode.textContent = error || '';
            // Подсказка про умолчание уходит, как только в поле что-то набрали:
            // «Не задано» перестало быть правдой.
            const hint = field.querySelector('.ui-field__hint');
            if (hint) hint.hidden = edited;
        }

        const ctl = box.querySelector('.set-row__ctl');
        let acts = ctl.querySelector('.set-acts');
        if (edited && !acts) {
            ctl.appendChild(renderActs(row, error));
        } else if (!edited && acts) {
            acts.remove();
        } else if (acts) {
            const save = acts.querySelector('[data-role="save"]');
            if (save) save.disabled = Boolean(error) || Boolean(row.saving);
        }
    }

    // `CSS.escape` есть во всех браузерах проекта, но ключ настройки — это
    // `snake_case` из базы, и полагаться на него без проверки незачем.
    function cssEscape(value) {
        return (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
    }

    function discard(row) {
        delete row.draft;
        render();
    }

    async function commit(row, value) {
        if (row.saving) return;
        row.saving = true;
        render();
        try {
            const saved = await saveSetting(ctx.api, row.key, value === undefined ? '' : value);
            if (!alive) return;
            // Ответ сервера кладётся ЦЕЛИКОМ, а не одним значением: вместе со
            // значением приезжает и подпись «кто менял», собранная по журналу.
            Object.assign(row, saved);
            delete row.draft;
            row.saving = false;
            render();
            ctx.toast(`«${row.title}» — теперь ${human(row, row.value)}`, 'success');
        } catch (err) {
            if (!alive || isAbort(err)) return;
            row.saving = false;
            // ПРАВКУ НЕ ТЕРЯЕМ: строка остаётся изменённой, чтобы человек мог
            // поправить набранное, а не набирать заново.
            render();
            ctx.toast(err.message, 'error');
        }
    }

    return {
        async start() {
            const data = await fetchSettings(ctx.api);
            if (!alive) return;
            rows = data;
            render();
        },
        destroy() {
            alive = false;
        }
    };
}
