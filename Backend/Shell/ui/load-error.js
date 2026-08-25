// --- ui/load-error.js: полоса «данные не загрузились» ----------------------
//
// Находка ревизора Р3. Когда сервер отвечал отказом, раздел показывал своё
// обычное пустое состояние: «Ничего не найдено по текущим фильтрам»,
// «Нет сотрудников. Добавьте первого!», прочерки в счётчиках. Единственным
// сигналом был тост на 3,2 секунды — не успел прочесть, и перед тобой пустой
// список, из которого следует, что записей нет.
//
// В CRM это стоит дорого: человек заводит заново то, что уже заведено.
//
// ПОЛОСА, А НЕ НАКЛАДКА. Накладка поверх содержимого была бы неправдой в
// обратную сторону: отказать может один запрос из пяти (например, счётчики
// при живом списке), и прятать рабочий список из-за этого нельзя. Полоса
// говорит ровно то, что известно: часть данных не пришла, показанное может
// быть неполным.
//
// Ставится оболочкой на ЛЮБОЙ неудавшийся чтение-запрос панели (shell/app.js,
// хуки createApiScope) и снимается на первом удавшемся. Разделы про неё не
// знают и кода не меняют — иначе шесть разделов дали бы шесть разных
// формулировок, как это уже было с пустыми состояниями.

import { iconNode } from './icons.js';

const ROLE = 'load-error';

// Заголовок по умолчанию. Он верен, пока полоса говорит о наших же данных, и
// перестаёт быть верным там, где данные как раз загрузились: в «Звонках»
// молчит телефония, и «Данные не загрузились» там — прямая неправда. Поэтому
// заголовок стал параметром вызова, а не остался зашитым (паспорт Р1).
const DEFAULT_TITLE = 'Данные не загрузились';

function build(container, onRetry) {
    const box = document.createElement('div');
    box.className = 'ui-load-error';
    box.dataset.role = ROLE;
    box.setAttribute('role', 'alert');

    const icon = iconNode('warn', 'sm', 'ui-load-error__icon');

    const text = document.createElement('div');
    text.className = 'ui-load-error__text';

    const title = document.createElement('b');
    // Роль нужна, чтобы повторный вызов МЕНЯЛ заголовок, а не оставлял первый:
    // полоса одна на панель, а причин отказа у неё бывает несколько подряд.
    title.dataset.role = 'load-error-title';
    title.textContent = DEFAULT_TITLE;

    const reason = document.createElement('span');
    reason.className = 'ui-load-error__reason';
    reason.dataset.role = 'load-error-reason';

    text.append(title, reason);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ui-btn ui-btn--secondary';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', () => onRetry());

    box.append(icon, text, retry);
    container.insertBefore(box, container.firstChild);
    return box;
}

/**
 * Показать полосу. Второй отказ подряд не плодит вторую полосу — обновляется
 * текст причины.
 *
 * @param {HTMLElement} container тело панели
 * @param {string} reason сообщение, с которым отказал запрос
 * @param {Function} onRetry что делать по кнопке «Повторить»
 * @param {string} [title] свой заголовок; без него — «Данные не загрузились»
 *
 * ЗАГОЛОВОК ЧЕТВЁРТЫМ, А НЕ ТРЕТЬИМ (ответ куратора И45). Третье место занято
 * `onRetry`, и вставка в середину молча сломала бы вызовы, которые его передают.
 */
export function showLoadError(container, reason, onRetry, title) {
    if (!container || !container.isConnected) return;
    const box = container.querySelector(`[data-role="${ROLE}"]`) || build(container, onRetry);
    const head = box.querySelector(`[data-role="load-error-title"]`);
    if (head) head.textContent = title || DEFAULT_TITLE;
    const slot = box.querySelector(`[data-role="load-error-reason"]`);
    // Причина — рядом с заголовком, а не вместо него: текст сервера бывает
    // техническим, и он не должен оставаться единственным объяснением.
    //
    // ТОЧКУ ШАБЛОН БОЛЬШЕ НЕ СТАВИТ САМ. Причины приходят из двух разных мест:
    // одни — техническим текстом без знака в конце, другие — готовой фразой,
    // которая точкой уже заканчивается («Показано последнее, что мы знали в
    // 15:42.»). Шаблон, добавлявший точку всегда, во втором случае давал две.
    slot.textContent = reason
        ? ` — ${endsSentence(reason) ? reason : reason + '.'} Показанное может быть неполным.`
        : ' — показанное может быть неполным.';
}

/** Есть ли у фразы свой знак конца — тогда наш добавлять нельзя. */
function endsSentence(text) {
    return /[.!?…]$/.test(String(text).trim());
}

/** Снять полосу: пришёл удачный ответ, показанному снова можно верить. */
export function clearLoadError(container) {
    if (!container) return;
    const box = container.querySelector(`[data-role="${ROLE}"]`);
    if (box) box.remove();
}
