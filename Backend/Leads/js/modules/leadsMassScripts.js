// --- leadsMassScripts.js: окно массового назначения скриптов (пункт Р11) ----
//
// ПОЧЕМУ ОКНО, А НЕ СПИСОК В ПОЛОСЕ. До переделки массовое действие «Сменить
// скрипт» было обычным списком в полосе массовых действий, рядом с оператором и
// статусом. Наборов теперь до пяти, у каждого своё поле статусов — в полосу это
// не помещается, а полоса прижата к нижнему краю панели и растянуть её вверх
// нельзя. Поэтому действие открывает окно с тем же блоком, что стоит в карточке
// (решение владельца 85).
//
// НАБОРЫ ЗАМЕНЯЮТ, А НЕ ДОПОЛНЯЮТ. Довод — не экономия, а честность: дополнение
// может нарушить запрет «один статус ведёт только к одному скрипту», и тогда
// часть лидов приняла бы назначение, а часть нет, МОЛЧА. Замена этого не
// допускает, и окно говорит об этом до нажатия.

import { openModal } from '/ui/modal.js';
import { icon } from '/ui/icons.js';
import { createScriptPairs } from './leadsScriptPairs.js';
import { createPickList } from './leadsPickList.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

// Русское склонение только там, где оно на экране: «1 лида» читается как ошибка
// системы, а не как число.
function leadsWord(count) {
    const tail = count % 100;
    if (tail >= 11 && tail <= 14) return 'лидов';
    switch (count % 10) {
        case 1: return 'лид';
        case 2:
        case 3:
        case 4: return 'лида';
        default: return 'лидов';
    }
}

/**
 * @param {Object} opts { scope, ids, scripts, statuses, storage, toast, isAlive, onDone }
 *
 * scripts и statuses уже загружены разделом — второй раз их не спрашиваем.
 * Число «сколько из выбранных уже со скриптами» спрашиваем всегда: оно не
 * выводится из таблицы, потому что в ней лежит действующий скрипт, а его нет
 * как раз у того лида, чей текущий статус не покрыт ни одним набором.
 */
export async function openMassScriptPairs({ scope, ids, scripts, statuses, storage, toast, isAlive, onDone }) {
    let preview = null;
    try {
        preview = await storage.previewScriptPairs(ids);
    } catch (e) {
        if (!isAlive()) return;
        toast('Не удалось посчитать, у скольких лидов уже есть скрипты', 'error');
        return;
    }
    if (!isAlive()) return;

    const body = el('div');

    // Плашки нет вовсе, когда заменять нечего: предупреждение о том, чего не
    // случится, читается как поломка.
    if (preview.withPairs > 0) {
        const note = el('div', 'ui-note ui-note--warn');
        note.innerHTML = icon('warn', 'sm', 'ui-note__icon');
        const noteBody = el('div', 'ui-note__body');
        noteBody.append(el('div', 'ui-note__text',
            `У ${preview.withPairs} ${leadsWord(preview.withPairs)} из ${preview.total} скрипты уже назначены. Они будут заменены целиком, а не дополнены.`));
        note.appendChild(noteBody);
        body.appendChild(note);
    }

    const pairsBox = el('div');
    body.appendChild(pairsBox);

    const pairs = createScriptPairs(pairsBox, { createPickList });
    pairs.setScripts(scripts);
    pairs.setStatuses(statuses);
    pairs.setValues([]);

    let saving = false;

    openModal({
        title: `Скрипты для ${ids.length} ${leadsWord(ids.length)}`,
        sub: 'Наборы заменят те, что стоят у выбранных лидов сейчас',
        body,
        scope,
        size: 'wide',
        actions: [
            { label: 'Отмена', variant: 'ghost' },
            {
                label: 'Назначить',
                onClick: async () => {
                    if (saving) return false;
                    // ВОЗВРАТ FALSE ОСТАВЛЯЕТ ОКНО ОТКРЫТЫМ — договор слоя.
                    const problem = pairs.validate();
                    if (problem) {
                        problem.focus.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        const control = problem.focus.querySelector('select, input');
                        if (control) control.focus();
                        return false;
                    }
                    saving = true;
                    try {
                        await storage.bulkUpdateLeads(ids, { scriptPairs: pairs.getValues() });
                    } catch (e) {
                        saving = false;
                        if (!isAlive()) return false;
                        toast(e.message || 'Не удалось назначить скрипты', 'error');
                        return false;
                    }
                    if (!isAlive()) return true;
                    toast(`Скрипты назначены: ${ids.length}`, 'success');
                    if (onDone) await onDone();
                    return true;
                }
            }
        ]
    });
}
