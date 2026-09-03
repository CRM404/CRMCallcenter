// ⚠ Значки из набора слоя, а не из Font Awesome (задача 44).
import { icon } from '/ui/icons.js';

// --- operatorObjections.js: поиск возражений по открытому скрипту ---
//
// Скрипт стал линейным, кнопок перехода под текстом больше нет — возражения
// переехали сюда. Раньше оператор видел только те возражения, что относились к
// текущему шагу; теперь это общий список по всему скрипту, доступный в любой
// момент разговора.
//
// Панель НЕ модальная: без затемнения, карточку не блокирует. Оператор во время
// возражения продолжает вводить данные, и заставлять его закрывать окно ради
// одного поля — лишний шаг в самый неудобный момент.
//
// Кнопка живёт в правом нижнем углу СТРАНИЦЫ (решение владельца), F2 — горячая
// клавиша: оператор с возражением в ухе не тянется мышью в угол.

import { fetchObjections } from './operatorStorage.js';
import { showToast } from './operatorToast.js';

const PREVIEW_LENGTH = 96;

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Подсветка совпадения. Текст экранируется по кускам, а не целиком, иначе <mark>
// пришлось бы вставлять в уже экранированную строку и позиции разъехались бы на
// длине сущностей вроде &amp;.
function highlight(text, query) {
    const value = text === null || text === undefined ? '' : String(text);
    if (!query) return escapeHtml(value);
    const at = value.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return escapeHtml(value);
    return escapeHtml(value.slice(0, at))
        + '<mark>' + escapeHtml(value.slice(at, at + query.length)) + '</mark>'
        + escapeHtml(value.slice(at + query.length));
}

function preview(text) {
    const value = text === null || text === undefined ? '' : String(text);
    return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH)}…` : value;
}

export function createObjectionsPanel() {
    const button = document.getElementById('opObjBtn');
    const panel = document.getElementById('opObjPanel');

    let objections = [];
    let currentLeadId = null;

    function itemHtml(objection, index, query) {
        return `
            <div class="op-obj-item" data-index="${index}">
                <button type="button" class="op-obj-item-head">
                    <span class="op-obj-item-title">${highlight(objection.label || 'Возражение', query)}</span>
                    <span class="op-obj-item-preview">${highlight(preview(objection.content), query)}</span>
                </button>
            </div>
        `;
    }

    // ⚠ ДВЕ ФУНКЦИИ ВМЕСТО ОДНОЙ — В ЭТОМ ВСЯ ПРАВКА (К315).
    // Раньше на каждое нажатие переписывалась ВСЯ панель вместе со строкой
    // поиска: узел поля исчезал, а фокус и каретку приходилось ставить обратно
    // руками — `pos = input.selectionStart` до перерисовки и
    // `setSelectionRange(pos, pos)` после. Костыль работал, но поле, которое
    // пересоздаётся под пальцами, отнимает у браузера всё, что тот делает сам:
    // выделение, отмену ввода, составной набор (для языков, где буква
    // собирается из нескольких нажатий).
    // Теперь рама панели собирается ОДИН РАЗ при открытии, а на ввод
    // переписывается ТОЛЬКО список — поле живёт, и восстанавливать в нём нечего.
    function listHtml(query) {
        const needle = (query || '').trim();
        const lower = needle.toLowerCase();
        // Поиск по заголовку И по тексту ответа, без учёта регистра, по части
        // слова, от одного символа.
        const found = lower
            ? objections.filter((o) => `${o.label || ''} ${o.content || ''}`.toLowerCase().includes(lower))
            : objections;

        if (!objections.length) {
            return '<div class="op-obj-empty"><b>У этого скрипта нет возражений</b><div class="hint">Их добавляет администратор в редакторе скриптов.</div></div>';
        }
        if (found.length) {
            return found.map((o) => itemHtml(o, objections.indexOf(o), needle)).join('');
        }
        // Пустой результат — не тупик: сразу под ним весь список. В разговоре
        // оператор не будет придумывать второй запрос, ему нужно что-то
        // показать немедленно.
        return `
            <div class="op-obj-empty">
                <b>Ничего не нашлось</b>
                <div class="hint">Попробуйте одно слово или его часть. Ниже — все возражения скрипта.</div>
            </div>
            ${objections.map((o, i) => itemHtml(o, i, '')).join('')}
        `;
    }

    // Список переписывается целиком, поэтому обработчики раскрытия вешаются
    // заново при каждой перерисовке — они живут ВНУТРИ списка, в отличие от
    // поля и кнопки закрытия, которые переживают ввод.
    function renderList(query) {
        panel.querySelector('.op-obj-list').innerHTML = listHtml(query);
        panel.querySelectorAll('.op-obj-item-head').forEach((head) => {
            head.addEventListener('click', () => {
                const item = head.closest('.op-obj-item');
                const answer = item.querySelector('.op-obj-answer');
                if (answer) {
                    item.classList.remove('is-open');
                    answer.remove();
                    return;
                }
                // Ответ разворачивается ПРЯМО В СПИСКЕ: подряд может идти два-три
                // возражения, и оператору нужно видеть их вместе.
                item.classList.add('is-open');
                const div = document.createElement('div');
                div.className = 'op-obj-answer';
                // Текст, а не HTML: форматирование в ответах на возражения не
                // поддерживается (dialog.md F5), и вставлять их разметкой нельзя
                // — содержимое узла санитайзер бэкенда для возражений не проходит.
                div.textContent = objections[Number(item.dataset.index)].content || '';
                item.appendChild(div);
            });
        });
    }

    function render() {
        panel.innerHTML = `
            <div class="op-obj-head">
                ${icon('comments', 'sm')}
                <h3>Возражения — поиск по скрипту</h3>
                <button type="button" class="op-obj-close" id="opObjClose" aria-label="Закрыть">
                    ${icon('close', 'sm')}
                </button>
            </div>
            <div class="op-obj-search">
                ${icon('search', 'sm')}
                <input type="text" id="opObjQuery" placeholder="Слово или часть слова: дорого, метро, ипотек…"
                       autocomplete="off">
            </div>
            <div class="op-obj-list"></div>
        `;

        const input = panel.querySelector('#opObjQuery');
        input.addEventListener('input', () => renderList(input.value));
        panel.querySelector('#opObjClose').addEventListener('click', close);

        renderList('');
        input.focus();
    }

    function open() {
        if (button.hidden) return;
        panel.hidden = false;
        render();
    }

    function close() {
        panel.hidden = true;
    }

    function toggle() {
        if (panel.hidden) open(); else close();
    }

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'F2') {
            event.preventDefault();
            toggle();
        }
        if (event.key === 'Escape') close();
    });
    document.addEventListener('click', (event) => {
        if (!panel.hidden && !panel.contains(event.target) && !event.target.closest('#opObjBtn')) close();
    });

    return {
        // leadId = null — карточки на экране нет (пустая очередь или «не на
        // линии»): кнопку прячем, искать нечего.
        async setLead(leadId) {
            if (leadId === currentLeadId) return;
            currentLeadId = leadId;
            close();
            if (!leadId) {
                button.hidden = true;
                objections = [];
                return;
            }
            button.hidden = false;
            try {
                const data = await fetchObjections(leadId);
                objections = (data && data.objections) || [];
            } catch (e) {
                objections = [];
                showToast(e.message, 'error');
            }
        }
    };
}
