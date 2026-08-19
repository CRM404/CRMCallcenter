// --- leadsPickList.js: мультивыбор «select "— добавить… —" + теги выбранного» ---
// Финальный паттерн дизайн-сессии после трёх раундов правок владельца
// (report_designer.md, 13.08.2026): выпадающий список сверху, выбранное —
// тегами-пилюлями снизу, уже выбранные пункты в списке помечены «✓»
// и задизейблены. Стена из ~59 таблеток-чипов отклонена владельцем.
//
// Используется тремя полями сразу: «Статусы показа скрипта» в карточке лида и
// в окне загрузки (с группировкой по этапам воронки и пунктом «— весь этап (N) —»)
// и «Сотрудники — пул раздачи» в окне загрузки (плоский список).
//
// К ОБОЛОЧКЕ модуль был готов и до переноса: он не знает ни про document, ни
// про глобальные id — весь DOM строит внутри переданного контейнера. Изменились
// только имена классов тегов: свои .param-tag заменены на .ui-fchip из слоя.

const WHOLE_STAGE_PREFIX = 'stage:';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// container — пустой div.pick-list из разметки. Возвращает управляющий объект,
// сам DOM внутри контейнера строит и перерисовывает модуль.
export function createPickList(container, { placeholder = '— добавить… —', emptyText = '', onChange = null } = {}) {
    container.innerHTML = '';
    const select = document.createElement('select');
    select.className = 'ui-field__control';
    const tagsEl = document.createElement('div');
    tagsEl.className = 'ui-fchips';
    const emptyEl = document.createElement('div');
    emptyEl.className = 'pick-empty';
    emptyEl.textContent = emptyText;
    container.append(select, tagsEl, emptyEl);

    // items: [{ id, label, stageNumber?, stageName? }]. Группировка включается
    // самим наличием stageNumber — отдельного флага не нужно.
    let items = [];
    let selectedIds = [];

    function indexOfItem(id) {
        return items.findIndex((i) => i.id === id);
    }

    function renderSelect() {
        const chosen = new Set(selectedIds);
        let html = `<option value="">${escapeHtml(placeholder)}</option>`;

        const grouped = items.length > 0 && items[0].stageNumber !== undefined;
        if (!grouped) {
            html += items.map((i) => optionHtml(i, chosen)).join('');
        } else {
            const byStage = new Map();
            items.forEach((i) => {
                if (!byStage.has(i.stageNumber)) byStage.set(i.stageNumber, { stageName: i.stageName, list: [] });
                byStage.get(i.stageNumber).list.push(i);
            });
            Array.from(byStage.keys()).sort((a, b) => a - b).forEach((num) => {
                const { stageName, list } = byStage.get(num);
                // «— весь этап (N) —»: при ~59 статусах добавлять этап целиком
                // поштучно невыносимо. Пункт исчезает, когда этап уже выбран весь.
                const remaining = list.filter((i) => !chosen.has(i.id)).length;
                const wholeStage = remaining > 0
                    ? `<option value="${WHOLE_STAGE_PREFIX}${num}">— весь этап (${remaining}) —</option>`
                    : '';
                html += `<optgroup label="${escapeHtml(`${num}. ${stageName}`)}">${wholeStage}${list.map((i) => optionHtml(i, chosen)).join('')}</optgroup>`;
            });
        }
        select.innerHTML = html;
        select.value = '';
    }

    function optionHtml(item, chosen) {
        const isChosen = chosen.has(item.id);
        return `<option value="${item.id}"${isChosen ? ' disabled' : ''}>${isChosen ? '✓ ' : ''}${escapeHtml(item.label)}</option>`;
    }

    function renderTags() {
        // Порядок тегов — по порядку самого справочника, а не по кликам:
        // при добавлении этапа целиком «как кликалось» выглядит случайно.
        const ordered = selectedIds.slice().sort((a, b) => indexOfItem(a) - indexOfItem(b));
        tagsEl.innerHTML = ordered.map((id) => {
            const item = items[indexOfItem(id)];
            if (!item) return '';
            const badge = item.stageNumber !== undefined ? `<span class="ui-tag">${item.stageNumber}</span>` : '';
            return `<span class="ui-fchip">${badge}${escapeHtml(item.label)}<button type="button" class="ui-fchip__remove" data-remove="${id}" aria-label="Убрать">×</button></span>`;
        }).join('');
        emptyEl.hidden = selectedIds.length > 0 || !emptyText;
    }

    function rerender() {
        renderSelect();
        renderTags();
    }

    function emitChange() {
        if (onChange) onChange(getValues());
    }

    select.addEventListener('change', () => {
        const raw = select.value;
        if (!raw) return;
        if (raw.startsWith(WHOLE_STAGE_PREFIX)) {
            const stage = Number(raw.slice(WHOLE_STAGE_PREFIX.length));
            items.filter((i) => i.stageNumber === stage && !selectedIds.includes(i.id))
                .forEach((i) => selectedIds.push(i.id));
        } else {
            const id = Number(raw);
            if (!selectedIds.includes(id)) selectedIds.push(id);
        }
        rerender();
        emitChange();
    });

    tagsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (!btn) return;
        const id = Number(btn.dataset.remove);
        selectedIds = selectedIds.filter((x) => x !== id);
        rerender();
        emitChange();
    });

    function getValues() {
        return selectedIds.slice().sort((a, b) => indexOfItem(a) - indexOfItem(b));
    }

    return {
        setItems(nextItems) {
            items = nextItems || [];
            // Выбранное, которого больше нет в списке (например, сменилась
            // линия и пул пересобрался), молча отбрасываем — иначе на сервер
            // уйдёт id, которого пользователь уже не видит.
            const known = new Set(items.map((i) => i.id));
            selectedIds = selectedIds.filter((id) => known.has(id));
            rerender();
        },
        setValues(ids) {
            const known = new Set(items.map((i) => i.id));
            selectedIds = (ids || []).map(Number).filter((id) => known.has(id));
            rerender();
        },
        getValues,
        setDisabled(disabled) {
            select.disabled = Boolean(disabled);
        },
        clear() {
            selectedIds = [];
            rerender();
        }
    };
}
