// --- leadsScriptPairs.js: наборы «скрипт и его статусы» (пункт Р11) ---------
//
// ЧТО БЫЛО. У лида стояли два поля и условное третье: «Скрипт», «Статусы показа
// скрипта» и «Скрипт для повторных», включавшийся сам на этапах 5–6. Один скрипт
// на лида, один список статусов, повторный — мимо этого списка.
//
// ЧТО СТАЛО (решения владельца 82–84). До ПЯТИ наборов «скрипт и его статусы».
// Оператор увидит тот скрипт, среди статусов которого стоит текущий статус лида.
// Повторный скрипт — это просто набор, в котором выбраны повторные статусы;
// отдельного поля и правила «этап 5–6 включает его сам» больше нет.
//
// ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ. Блок нужен в трёх местах сразу — карточка лида, окно
// «Загрузить базу» и окно массового назначения (решение 85). Собранный внутри
// карточки, он был бы скопирован дважды, и три копии разошлись бы на первой же
// правке текста. Модуль не знает ни про document, ни про глобальные id: весь DOM
// строит внутри переданного контейнера, как это делает leadsPickList.
//
// ЗАПРЕТ «ОДИН СТАТУС — ОДИН НАБОР» (решение 83) держится здесь И на сервере.
// Здесь — тем, что занятые соседями статусы УБИРАЮТСЯ из списка выбора, а не
// гасятся: человек тычет в видимый пункт и не понимает, почему ничего не
// происходит. На сервере — первичным ключом (lead_id, funnel_status_id), и это
// главное: форму можно обойти, ключ — нет.
//
// ПОВТОР ОДНОГО СКРИПТА В ДВУХ НАБОРАХ РАЗРЕШЁН (решение 84) и предупреждается
// В МОМЕНТ ВЫБОРА, а не при сохранении. Кнопки «всё равно сохранить» здесь нет:
// в момент выбора сохранять нечего, карточка уходит общей кнопкой в подвале.

import { icon } from '/ui/icons.js';

export const MAX_PAIRS = 5;

// Тексты — дословно из паспорта Р11. Держатся здесь, а не по месту, чтобы три
// места, где живёт блок, не разошлись словами.
const TEXTS = {
    scriptLabel: 'Скрипт',
    statusLabel: 'Статусы, при которых он открывается',
    scriptPlaceholder: '— не выбран —',
    pickEmpty: 'Ни один статус не выбран — без них скрипт не откроется никогда.',
    pickHint: 'Статусы, отданные другим скриптам, в списке не показаны: один статус ведёт только к одному скрипту.',
    addBtn: 'Добавить скрипт',
    delBtn: 'Убрать скрипт',
    delBtnOnly: 'Хотя бы один скрипт обязателен',
    dupTitle: 'Этот скрипт уже выбран выше',
    // Текст редакции 2 паспорта (решение владельца 91). Начинается с того,
    // чего человек НЕ ожидает — наборы объединятся, — а не с разрешения:
    // разрешение он и так подразумевал, раз выбрал. «Ничего не потеряется» —
    // не утешение, а факт: пропадает не работа, а разделение, которого в
    // хранении и не было.
    dupLead: 'При сохранении оба станут одним',
    dupText: ' — статусы сложатся в общий список. Ничего не потеряется: текст один и тот же. Нужен другой текст на эти статусы — выберите другой скрипт.',
    errNoStatuses: 'Выберите статусы или уберите этот скрипт',
    errNoScript: 'Выберите скрипт или снимите выбранные статусы',
    missTitle: 'Недозвон останется без скрипта',
    missTail: 'Лид с таким статусом возвращается в очередь сам, и оператор увидит «Для этого статуса скрипт не назначен». Добавьте их в любой скрипт выше — или оставьте как есть, если так и задумано.'
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

/**
 * @param {HTMLElement} root      пустой контейнер из разметки
 * @param {Object}      deps      { createPickList, onCountChange }
 *
 * createPickList — тот же мультивыбор, что у остальных полей раздела: список
 * сверху с пунктом «— добавить… —», выбранное тегами снизу. Передаётся
 * зависимостью, а не импортируется, по правилу раздела: модули «Лидов» собирает
 * leadsApp, и подмена одного из них не должна требовать правки соседа.
 */
export function createScriptPairs(root, { createPickList, onCountChange = null } = {}) {
    root.innerHTML = '';
    const rowsEl = el('div', 'lead-script-rows');

    const addBtn = el('button', 'ui-btn ui-btn--ghost lead-script-add');
    addBtn.type = 'button';
    addBtn.innerHTML = `${icon('plus', 'sm')}<span>${TEXTS.addBtn}</span>`;

    // Плашка недозвона (решение 89) стоит ПОСЛЕ кнопки добавления: она про
    // раздел целиком, в отличие от плашки повтора, которая живёт внутри своего
    // набора. Человек читает место раньше текста.
    const missNote = el('div', 'ui-note ui-note--warn');
    missNote.hidden = true;

    root.append(rowsEl, addBtn, missNote);

    let scripts = [];        // [{ id, title }]
    let statuses = [];       // [{ id, statusName, stageNumber, stageName, releasesLead }]
    let rows = [];           // [{ node, select, pick, scriptField, statusField, delBtn, hintEl, dupNote, errScript, errStatus }]

    // ------------------------------------------------------------ построение

    function buildRow() {
        const node = el('div', 'lead-script-row');
        const fields = el('div', 'lead-script-row__fields ui-form-grid form-grid--top');

        const scriptField = el('div', 'ui-field');
        const scriptLabel = el('label', 'ui-field__label ui-field__label--required', TEXTS.scriptLabel);
        const select = el('select', 'ui-field__control');
        const errScript = el('span', 'ui-field__error');
        scriptField.append(scriptLabel, select, errScript);

        const statusField = el('div', 'ui-field');
        const statusLabel = el('span', 'ui-field__label ui-field__label--required', TEXTS.statusLabel);
        const pickBox = el('div', 'pick-list');
        const hintEl = el('span', 'ui-field__hint', TEXTS.pickHint);
        const errStatus = el('span', 'ui-field__error');
        statusField.append(statusLabel, pickBox, hintEl, errStatus);

        // Плашка повтора — последний элемент сетки во всю ширину: под полями
        // того набора, где выбрали повтор, а не над формой.
        const dupNote = el('div', 'ui-note ui-note--warn ui-field--wide');
        dupNote.innerHTML = icon('warn', 'sm', 'ui-note__icon');
        const dupBody = el('div', 'ui-note__body');
        // Первая часть текста — жирным: слой это умеет (.ui-note__text b), и
        // собирается она узлами, а не строкой разметки.
        const dupText = el('div', 'ui-note__text');
        dupText.append(el('b', '', TEXTS.dupLead), document.createTextNode(TEXTS.dupText));
        dupBody.append(el('div', 'ui-note__title', TEXTS.dupTitle), dupText);
        dupNote.appendChild(dupBody);
        dupNote.hidden = true;

        fields.append(scriptField, statusField, dupNote);

        const delBtn = el('button', 'ui-btn ui-btn--icon ui-btn--row ui-btn--danger lead-script-row__del');
        delBtn.type = 'button';
        delBtn.innerHTML = icon('trash', 'sm');

        node.append(fields, delBtn);

        const row = { node, select, scriptField, statusField, delBtn, hintEl, dupNote, errScript, errStatus, pick: null };

        row.pick = createPickList(pickBox, {
            emptyText: TEXTS.pickEmpty,
            onChange: () => { clearRowError(row); syncAll(); }
        });

        select.addEventListener('change', () => { clearRowError(row); syncAll(); });
        delBtn.addEventListener('click', () => removeRow(row));

        return row;
    }

    function addRow(values) {
        if (rows.length >= MAX_PAIRS) return null;
        const row = buildRow();
        rows.push(row);
        rowsEl.appendChild(row.node);
        fillScriptSelect(row);
        // Статусы ставятся ПОСЛЕ setItems соседей: список набора зависит от
        // того, что заняли остальные, и выставлять значения раньше состава
        // значит потерять их — setValues отбрасывает неизвестное.
        syncAll();
        if (values) {
            row.select.value = values.scriptId ? String(values.scriptId) : '';
            row.pick.setValues(values.statusIds || []);
            syncAll();
        }
        return row;
    }

    function removeRow(row) {
        if (rows.length <= 1) return;
        const index = rows.indexOf(row);
        rows = rows.filter((r) => r !== row);
        row.node.remove();
        syncAll();
        // Фокус не должен пропасть в никуда: узел, на котором он стоял, ушёл
        // вместе с набором, и браузер вернул бы его на body — человек с
        // клавиатуры оказался бы в начале страницы.
        const next = rows[index] || rows[index - 1];
        if (next && !next.delBtn.disabled) next.delBtn.focus();
        else if (!addBtn.disabled) addBtn.focus();
    }

    function fillScriptSelect(row) {
        const current = row.select.value;
        row.select.innerHTML = `<option value="">${TEXTS.scriptPlaceholder}</option>`
            + scripts.map((s) => `<option value="${s.id}"></option>`).join('');
        // Названия ставятся текстом, а не в разметку строкой: имя скрипта —
        // пользовательские данные, и экранирование здесь не забывается.
        Array.from(row.select.options).forEach((opt, i) => {
            if (i > 0) opt.textContent = scripts[i - 1].title;
        });
        row.select.value = current;
    }

    // -------------------------------------------------------------- пересчёт

    // Один проход, который приводит в порядок ВСЁ, что зависит от соседей:
    // состав списков статусов, подписи, плашки повтора, кнопки и счётчик.
    // Отдельные обработчики «на каждое изменение своё» разошлись бы: занятость
    // статуса меняет чужой список, а не свой.
    function syncAll() {
        const takenByOthers = new Map();   // row → Set(id), занятые СОСЕДЯМИ
        rows.forEach((row) => {
            const taken = new Set();
            rows.forEach((other) => {
                if (other === row) return;
                other.pick.getValues().forEach((id) => taken.add(id));
            });
            takenByOthers.set(row, taken);
        });

        rows.forEach((row) => {
            const taken = takenByOthers.get(row);
            const mine = row.pick.getValues();
            row.pick.setItems(statuses
                .filter((s) => !taken.has(s.id))
                .map((s) => ({ id: s.id, label: s.statusName, stageNumber: s.stageNumber, stageName: s.stageName })));
            row.pick.setValues(mine);
            // Подписи нет, пока занимать нечего: строка, объясняющая то, чего не
            // случилось, читается как поломка.
            row.hintEl.hidden = taken.size === 0;

            // Плашка повтора висит ТОЛЬКО НА ПОЗДНЕМ наборе, а не на обоих.
            // Заголовок говорит «уже выбран выше», и на первом из двух это
            // читалось бы как обвинение в том, чего он не делал: повтор завёл
            // тот, кто выбрал скрипт вторым.
            const scriptId = row.select.value;
            const index = rows.indexOf(row);
            const twin = scriptId && rows.some((other, i) => i < index && other.select.value === scriptId);
            row.dupNote.hidden = !twin;

            row.delBtn.disabled = rows.length <= 1;
            row.delBtn.title = rows.length <= 1 ? TEXTS.delBtnOnly : TEXTS.delBtn;
            row.delBtn.setAttribute('aria-label', row.delBtn.title);
        });

        addBtn.disabled = rows.length >= MAX_PAIRS;
        syncMissNote();
        if (onCountChange) onCountChange(rows.length, MAX_PAIRS);
    }

    // Плашка недозвона знает ответ ДО сохранения: пять статусов приходят
    // справочником с признаком releasesLead, их идентификаторы у экрана уже
    // есть. Условие — «не покрыт ХОТЯ БЫ ОДИН» (решение владельца 92): если
    // «Перезвон» покрыт, а «Недоступен» нет, лид с «Недоступен» всё равно
    // придёт к оператору пустым, и буквальное «ни один» оставило бы эту дыру
    // молчащей.
    function syncMissNote() {
        const covered = new Set();
        rows.forEach((row) => row.pick.getValues().forEach((id) => covered.add(id)));
        const missing = statuses.filter((s) => s.releasesLead && !covered.has(s.id));
        if (missing.length === 0) {
            missNote.hidden = true;
            return;
        }
        // Разделитель «·», а не запятая: в названиях статусов уже есть косые
        // черты — «Автоответчик / голосовая почта», — и перечисление через
        // запятую распалось бы на девять кусков вместо пяти.
        const names = missing.map((s) => s.statusName).join(' · ');
        // ПЕРЕЧЕНЬ — ЖИРНЫМ, и это не украшение (К194). Вся работа плашки —
        // назвать, КАКИЕ именно статусы не покрыты; без выделения пять названий
        // тонут в абзаце из четырёх строк, и человек читает «что-то не
        // покрыто» вместо списка.
        const head = missing.length === 1
            ? 'Ни один скрипт не открывается на статусе '
            : 'Ни один скрипт не открывается на статусах: ';
        missNote.innerHTML = icon('warn', 'sm', 'ui-note__icon');
        const body = el('div', 'ui-note__body');
        const text = el('div', 'ui-note__text');
        text.append(document.createTextNode(head), el('b', '', names),
            document.createTextNode(`. ${TEXTS.missTail}`));
        body.append(el('div', 'ui-note__title', TEXTS.missTitle), text);
        missNote.appendChild(body);
        missNote.hidden = false;
    }

    // --------------------------------------------------------------- ошибки

    function clearRowError(row) {
        row.scriptField.classList.remove('ui-field--error');
        row.statusField.classList.remove('ui-field--error');
        row.errScript.textContent = '';
        row.errStatus.textContent = '';
    }

    function clearErrors() {
        rows.forEach(clearRowError);
    }

    addBtn.addEventListener('click', () => {
        const row = addRow(null);
        // Кнопку уже нажали — дальше человек выбирает скрипт, и фокус идёт
        // туда, а не остаётся на кнопке, которая своё дело сделала.
        if (row) row.select.focus();
    });

    return {
        setScripts(list) {
            scripts = (list || []).map((s) => ({ id: s.id, title: s.title }));
            rows.forEach(fillScriptSelect);
        },
        setStatuses(list) {
            statuses = (list || []).map((s) => ({
                id: s.id,
                statusName: s.statusName,
                stageNumber: s.stageNumber,
                stageName: s.stageName,
                releasesLead: Boolean(s.releasesLead)
            }));
            syncAll();
        },
        /**
         * pairs — то, что отдаёт сервер: [{ scriptId, scriptTitle, statusIds }].
         * Пустой список означает нового лида: набор всё равно будет один, пустой,
         * потому что убрать последний нельзя.
         */
        setValues(pairs) {
            rows.forEach((row) => row.node.remove());
            rows = [];
            clearErrors();
            const list = Array.isArray(pairs) && pairs.length > 0 ? pairs.slice(0, MAX_PAIRS) : [null];
            list.forEach((pair) => addRow(pair ? { scriptId: pair.scriptId, statusIds: pair.statusIds } : null));
            syncAll();
        },
        getValues() {
            return rows.map((row) => ({
                scriptId: row.select.value ? Number(row.select.value) : null,
                statusIds: row.pick.getValues()
            }));
        },
        /**
         * Проверка полноты наборов. Ошибка живёт ПОД ПОЛЕМ, а не в тосте:
         * тост исчезает через три секунды, а исправлять человек будет дольше.
         * Возвращает null, если всё в порядке, иначе { message, focus } — узел,
         * к которому окно обязано прокрутиться и поставить фокус.
         *
         * Отказ называет ПОЛЕ, а не номер набора: порядок наборов не значит
         * ничего, и «во втором блоке» заставило бы пересчитывать блоки сверху.
         */
        validate() {
            clearErrors();
            for (const row of rows) {
                const scriptId = row.select.value;
                const statusIds = row.pick.getValues();
                if (scriptId && statusIds.length === 0) {
                    row.statusField.classList.add('ui-field--error');
                    row.errStatus.textContent = TEXTS.errNoStatuses;
                    return { message: TEXTS.errNoStatuses, focus: row.statusField };
                }
                if (!scriptId) {
                    // Пустой набор с выбранными статусами и совсем пустой набор
                    // отказывают по-разному: во втором случае набор начат
                    // мультивыбором, и просить статусы бессмысленно.
                    if (statusIds.length === 0) {
                        row.statusField.classList.add('ui-field--error');
                        row.errStatus.textContent = TEXTS.errNoStatuses;
                        return { message: TEXTS.errNoStatuses, focus: row.statusField };
                    }
                    row.scriptField.classList.add('ui-field--error');
                    row.errScript.textContent = TEXTS.errNoScript;
                    return { message: TEXTS.errNoScript, focus: row.scriptField };
                }
            }
            return null;
        },
        clearErrors,
        count() { return rows.length; }
    };
}
