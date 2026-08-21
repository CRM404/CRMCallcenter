// --- scriptsAdminNodes.js: узлы скрипта — основной текст (корень) + плоский список возражений ---
// Модель без вложенности: ровно один корневой узел (node_type='statement', parent_id=NULL)
// и плоский список возражений (node_type='objection', parent_id = id корня). Корень
// определяется по parent_id IS NULL, а не по node_type — в существующих данных
// возможен корень с "неправильным" node_type от старой формы; сохранение через
// эту панель всегда принудительно проставляет node_type='statement' корню, само
// исправляя такие записи.
//
// Текст корня — rich text (contenteditable + execCommand: жирный/курсив/список),
// сервер санитизирует его белым списком тегов при сохранении (routes/scriptsAdmin.js) —
// здесь при отображении (read-режим и при заполнении формы редактирования)
// content корня вставляется как HTML, БЕЗ escapeHtml, ему уже можно доверять.
//
// ВОЗРАЖЕНИЯ ТЕПЕРЬ ИДУТ ТЕМ ЖЕ ПУТЁМ (К156): тот же редактор, тот же
// санитайзер, та же вставка разметкой. Три вещи менялись одним движением —
// поле, серверная чистка и отображение: любая из них по отдельности означала бы
// либо разметку, которую негде ввести, либо разметку, которую никто не чистит.
// Старые записи, сохранённые до этого как обычный текст, приведены разовой
// правкой данных в schema.sql (2026-08-21-escape-objection-content).
//
// ПЕРЕЕЗД В ОБОЛОЧКУ. Механика редактора не тронута — она выстрадана
// эмпирически (перенос строки, ZWSP, потеря выделения при открытии палитры), и
// бриф прямо требует «трогать только оболочку, содержимое редактора не
// переносить». Изменилось ровно три вещи:
//   1. Глобальные id (#saRootEditContent, #saObjectionEditLabel-12) заменены на
//      data-role в границах контейнера: при двух открытых панелях id вернул бы
//      узел чужой панели, и редактор писал бы в соседний скрипт.
//   2. showToast свой удалён — сообщения идут через toast, который передаёт
//      раздел (ctx.toast оболочки).
//   3. Классы .sa-* → .scr-*, кнопки/поля/пустые состояния — из слоя элементов.

import { escapeHtml } from './scriptsAdminScriptList.js';

// Значения строго совпадают с белым списком санитайзера в routes/scriptsAdmin.js
// (ALLOWED_FONT_FAMILIES) — "По умолчанию" это реальное CSS-значение initial
// (явно рвёт наследование от уже применённых родительских span), а не просто
// отсутствие свойства (куратор, 2026-08-06: отсутствие свойства не сбрасывает
// шрифт визуально, если текст уже вложен в span с другим шрифтом — initial сбрасывает).
const FONT_FAMILY_OPTIONS = [
    { value: 'initial', label: 'По умолчанию' },
    { value: '"SF Serif", Georgia, serif', label: 'SF Serif' },
    { value: '"Times New Roman", Times, serif', label: 'Times New Roman' }
];
const DEFAULT_FONT_SIZE_PX = 16;
const MIN_FONT_SIZE_PX = 8;
const MAX_FONT_SIZE_PX = 200;

// Фиксированная палитра вместо свободного нативного color picker'а (куратор,
// 11.08.2026, report_2026-08-01.md) — предыдущая версия на <input type="color">
// была неудобной/нестабильной в реальном использовании (два раунда фиксов
// вокруг потери выделения при открытии нативного picker'а). Значения строго
// совпадают с TEXT_COLOR_PATTERN в routes/scriptsAdmin.js (обычный hex, 6 знаков).
//
// ЦВЕТА — ПРОЕКТНЫЕ, а не произвольная радуга (К159). Прежние семь были взяты
// со стороны (#000000, #d92b2b, #1a56db…) и не совпадали ни с одним цветом
// интерфейса: скрипт печатают и показывают на планёрках вместе с остальным
// экраном, и семь чужих ярких цветов в нём видно сразу.
//
// Значения повторяют токены слоя (--ui-color-ink, --ui-color-accent,
// --ui-color-ok-ink, --ui-color-off-ink и три из палитры макета) ЧИСЛАМИ, и
// иначе нельзя: цвет уезжает в сохранённый content и в белый список
// санитайзера (TEXT_COLOR_PATTERN — ровно шесть знаков hex), var() там не
// переживёт ни сохранения, ни печати.
const TEXT_COLOR_SWATCHES = [
    { value: '#1a2433', label: 'Чернила' },
    { value: '#0000ff', label: 'Синий' },
    { value: '#146c43', label: 'Зелёный' },
    { value: '#9a2f27', label: 'Красный' },
    { value: '#c2740f', label: 'Оранжевый' },
    { value: '#a08b12', label: 'Жёлтый' },
    { value: '#6b46a8', label: 'Фиолетовый' }
];

// «По умолчанию» — обычный цвет текста раздела (--ui-color-ink). Сброс не
// может быть отсутствием свойства: покрашенный текст лежит внутри span'а, и
// снять цвет значит либо вычистить его у всех вложенных span'ов, либо
// назначить обычный цвет поверх. Делается и то и другое — см. resetTextColor.
const DEFAULT_TEXT_COLOR = '#1a2433';

// Текущее выделение внутри editorEl — null, если оно пустое/схлопнуто или вне редактора.
function getEditorSelectionRange(editorEl) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return null;
    if (!editorEl.contains(range.commonAncestorContainer)) return null;
    return range;
}

// Оборачивает содержимое range в новый span с заданным style (или без style,
// если styleText пустой). Вложение вместо поиска/мёржа существующего span —
// принятое упрощение (куратор, бриф п.1): при повторном форматировании уже
// отформатированного текста span'ы просто вкладываются друг в друга.
function wrapRangeInSpan(range, styleText) {
    const span = document.createElement('span');
    if (styleText) span.setAttribute('style', styleText);
    span.appendChild(range.extractContents());
    range.insertNode(span);
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(newRange);
}

// Ближайший предок (внутри editorEl) с инлайновым font-size — иначе дефолт 16px.
function findCurrentFontSizePx(range, editorEl) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node) {
        if (node.style && node.style.fontSize) {
            const match = /^(\d+)px$/.exec(node.style.fontSize);
            if (match) return parseInt(match[1], 10);
        }
        if (node === editorEl) break;
        node = node.parentElement;
    }
    return DEFAULT_FONT_SIZE_PX;
}

function applyFontFamily(editorEl, cssValue, toast) {
    const range = getEditorSelectionRange(editorEl);
    if (!range) {
        toast('Выделите текст', 'error');
        return;
    }
    wrapRangeInSpan(range, `font-family: ${cssValue}`);
}

function applyFontSizeDelta(editorEl, delta, toast) {
    const range = getEditorSelectionRange(editorEl);
    if (!range) {
        toast('Выделите текст', 'error');
        return;
    }
    const currentSize = findCurrentFontSizePx(range, editorEl);
    const newSize = Math.max(MIN_FONT_SIZE_PX, Math.min(MAX_FONT_SIZE_PX, currentSize + delta));
    wrapRangeInSpan(range, `font-size: ${newSize}px`);
}

// Текущая позиция курсора внутри editorEl, если выделение СХЛОПНУТО (просто
// курсор, без выделенного текста) — иначе null. Пара к getEditorSelectionRange
// (та, наоборот, требует НЕсхлопнутое выделение) — вместе покрывают оба режима
// применения цвета: к уже выделенному тексту и "печатать этим цветом дальше".
function getEditorCollapsedRange(editorEl) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return null;
    if (!editorEl.contains(range.commonAncestorContainer)) return null;
    return range;
}

// Режим "выбрать цвет и печатать им дальше" (владелец, 11.08.2026) — курсор
// схлопнут, текста для покраски нет. Вставляет пустой span с нужным цветом и
// zero-width space (иначе браузеру некуда ставить курсор внутрь пустого span) —
// набранный дальше текст продолжает существующий текстовый узел ВНУТРИ span,
// поэтому наследует цвет. ZWSP вычищается первым же вводом через editorEl
// (слушатель 'input' снимает себя после первого срабатывания) — иначе invisible-
// символ так и остался бы в сохранённом content.
//
// Если курсор уже стоит внутри такого же пустого (ещё не тронутого) span'а от
// предыдущего клика по палитре — просто меняем его цвет на месте, а не вкладываем
// новый span поверх старого (иначе переключение цвета туда-сюда без набора текста
// между кликами плодило бы вложенные пустые span'ы).
function applyPendingColor(editorEl, hexColor, collapsedRange) {
    let node = collapsedRange.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (node && node.tagName === 'SPAN' && node.textContent === '​') {
        node.style.color = hexColor;
        return;
    }

    const span = document.createElement('span');
    span.setAttribute('style', `color: ${hexColor}`);
    const zwsp = document.createTextNode('​');
    span.appendChild(zwsp);
    collapsedRange.insertNode(span);

    const newRange = document.createRange();
    newRange.setStart(zwsp, 1);
    newRange.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(newRange);
    editorEl.focus();

    const cleanupZwsp = () => {
        if (zwsp.textContent.length > 1 && zwsp.textContent.charCodeAt(0) === 0x200b) {
            zwsp.textContent = zwsp.textContent.slice(1);
            // Мутация textContent сбрасывает позицию курсора внутри этого текстового
            // узла (проверено эмпирически, реальный баг: без этого весь текст ПОСЛЕ
            // первого напечатанного символа уезжал мимо span'а) — возвращаем курсор
            // явно в конец обновлённого узла, чтобы дальнейший набор продолжался
            // внутри того же цветного span'а.
            const selection = window.getSelection();
            const restoredRange = document.createRange();
            restoredRange.setStart(zwsp, zwsp.textContent.length);
            restoredRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(restoredRange);
        }
        editorEl.removeEventListener('input', cleanupZwsp);
    };
    editorEl.addEventListener('input', cleanupZwsp);
}

// Единая точка входа для клика по свотчу палитры: если есть реальное (не
// схлопнутое) выделение — красит его; иначе, если курсор просто стоит внутри
// редактора — включает режим "печатать этим цветом"; иначе (редактор вообще
// не в фокусе) — просьба сначала кликнуть в текст.
// «По умолчанию»: вернуть выделенному тексту обычный цвет (К159). Двух шагов
// не избежать — сначала снимаем color у вложенных span'ов внутри выделения
// (иначе они выиграют у внешней обёртки как более глубокие), потом красим само
// выделение цветом чернил (иначе выиграл бы цветной ПРЕДОК выделения).
// Пустые span'ы после снятия стиля не вычищаем: санитайзер оставляет <span>
// без атрибутов, и на вид он ничего не меняет.
function resetTextColor(editorEl, toast) {
    const range = getEditorSelectionRange(editorEl);
    if (!range) {
        // Схлопнутый курсор — тот же режим «печатать дальше», что у образцов:
        // дальше набирается обычным цветом.
        const collapsedRange = getEditorCollapsedRange(editorEl);
        if (collapsedRange) {
            applyPendingColor(editorEl, DEFAULT_TEXT_COLOR, collapsedRange);
            return;
        }
        toast('Выделите текст', 'error');
        return;
    }
    const fragment = range.extractContents();
    fragment.querySelectorAll('span[style]').forEach((span) => { span.style.removeProperty('color'); });
    const span = document.createElement('span');
    span.setAttribute('style', `color: ${DEFAULT_TEXT_COLOR}`);
    span.appendChild(fragment);
    range.insertNode(span);
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(newRange);
}

function applySwatchColor(editorEl, hexColor, toast) {
    const selectedRange = getEditorSelectionRange(editorEl);
    if (selectedRange) {
        wrapRangeInSpan(selectedRange, `color: ${hexColor}`);
        return;
    }
    const collapsedRange = getEditorCollapsedRange(editorEl);
    if (collapsedRange) {
        applyPendingColor(editorEl, hexColor, collapsedRange);
        return;
    }
    toast('Сначала кликните в текст', 'error');
}

function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

function isRichTextEmpty(el) {
    return !el.textContent.trim();
}

// Подчищает "брошенные" пустые span'ы от режима "печатать этим цветом"
// (applyPendingColor) — если пользователь кликнул по свотчу и ушёл сохранять,
// ничего не напечатав, в DOM остаётся span с одним zero-width space внутри.
// Сам по себе он не ломает ничего (сервер его не отклонит), но незачем
// сохранять невидимый мусор — вызывается прямо перед чтением innerHTML на сохранение.
function stripEmptyPendingColorSpans(editorEl) {
    editorEl.querySelectorAll('span').forEach((span) => {
        if (span.textContent === '​') span.remove();
    });
}

// Общая точка чтения содержимого редактора для сохранения — паттерн
// isRichTextEmpty(editorEl) ? '' : editorEl.innerHTML, но сначала подчищает
// брошенные pending-color span'ы (см. stripEmptyPendingColorSpans).
function getEditorHtmlForSave(editorEl) {
    stripEmptyPendingColorSpans(editorEl);
    return isRichTextEmpty(editorEl) ? '' : editorEl.innerHTML;
}

// true, если commonAncestorContainer коллапсированного выделения лежит внутри <li>
// (в пределах editorEl) — тогда Enter отдаём браузеру: нативное поведение списков
// (новый пункт, выход из списка по двойному Enter на пустом пункте) трогать не нужно
// (куратор, ответ в dialog.md 10.08.2026) — правка ниже касается только текста ВНЕ списка.
function isCursorInsideListItem(range, editorEl) {
    let node = range.commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node !== editorEl) {
        if (node.tagName === 'LI') return true;
        node = node.parentElement;
    }
    return false;
}

// Вставляет <br> в текущей позиции курсора — замена execCommand('defaultParagraphSeparator',
// ..., 'br'), которая не всегда надёжно отрабатывает при обычном наборе текста (см. бриф,
// report_2026-08-01.md, Задача 1): без неё браузер на Enter оборачивает абзац в <div>,
// а серверный санитайзер вырезает div молча вместе с переносом строки.
//
// Используется именно execCommand('insertLineBreak'), а не ручная вставка узла <br> через
// Range API (изначальный вариант по брифу) — на практике (Playwright, реальный Chromium)
// ручная вставка на КОНЦЕ содержимого (br — последний child, следующего узла нет) даёт
// рабочий DOM сразу после вставки, но курсор для СЛЕДУЮЩЕГО набора текста фактически
// остаётся ПЕРЕД <br>, а не после — известная особенность contenteditable (нет узла-опоры
// после последнего br). execCommand('insertLineBreak') — специализированная команда именно
// для одиночного переноса (в отличие от общего, ненадёжного defaultParagraphSeparator) и
// корректно обрабатывает эту границу изнутри браузера.
function insertLineBreakAtCursor(editorEl) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editorEl.contains(range.commonAncestorContainer)) return;
    document.execCommand('insertLineBreak', false, null);
}

function initRichTextEditor(el) {
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (isCursorInsideListItem(range, el)) return; // список — нативное поведение браузера
        e.preventDefault();
        insertLineBreakAtCursor(el);
        autoGrow(el);
    });
    el.addEventListener('input', () => autoGrow(el));
    autoGrow(el);
}

function attachRichTextToolbar(container, editorEl, toast) {
    container.querySelectorAll('[data-rte-cmd]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault()); // не терять фокус/выделение в редакторе
        btn.addEventListener('click', () => {
            editorEl.focus();
            document.execCommand(btn.dataset.rteCmd, false, null);
            autoGrow(editorEl);
        });
    });

    // Шрифт/размер — свой span-based механизм (не execCommand, см. шапку файла
    // и бриф п.1), работает только пока выделение внутри editorEl.
    container.querySelectorAll('[data-rte-size-delta]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            applyFontSizeDelta(editorEl, Number(btn.dataset.rteSizeDelta), toast);
            autoGrow(editorEl);
        });
    });

    const fontSelect = container.querySelector('[data-rte-font-select]');
    if (fontSelect) {
        fontSelect.addEventListener('mousedown', (e) => e.stopPropagation());
        fontSelect.addEventListener('change', () => {
            applyFontFamily(editorEl, fontSelect.value, toast);
            fontSelect.value = '';
            autoGrow(editorEl);
        });
    }

    // ЗАМЕНЕНО (куратор, 11.08.2026, report_2026-08-01.md): нативный <input
    // type="color"> убран целиком — фиксированная палитра из 7 кнопок вместо
    // него. Причина замены не только "владелец так попросил": свободный picker
    // при открытии уводит фокус/выделение со страницы, из-за чего потребовалось
    // два отдельных раунда фиксов (10.08.2026); обычные <button> с mousedown
    // preventDefault (тот же паттерн, что у bold/italic/font-size выше) фокус
    // редактора вообще не теряют — весь класс этих багов просто не существует
    // для кнопок.
    container.querySelectorAll('[data-rte-color]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            applySwatchColor(editorEl, btn.dataset.rteColor, toast);
            autoGrow(editorEl);
        });
    });

    const resetBtn = container.querySelector('[data-rte-color-reset]');
    if (resetBtn) {
        resetBtn.addEventListener('mousedown', (e) => e.preventDefault());
        resetBtn.addEventListener('click', () => {
            resetTextColor(editorEl, toast);
            autoGrow(editorEl);
        });
    }
}

// Одна полоса инструментов на все редакторы раздела: основной текст и форма
// возражения пользуются одной и той же (К156 — возражение оператор читает
// вслух так же, как основной текст, и выделить в нём ключевую фразу нужно ровно
// так же).
//
// Три числа полосы стоят рядом и объясняются вместе:
//   · высота у ВСЕХ элементов одна, 32 (--ui-control-h-sm). У списка шрифтов
//     она приходит из слоя модификатором .ui-field__control--sm: раздел уже
//     пробовал задать её у себя, и min-height слоя выигрывал у height — ряд
//     оставался рваным (К158);
//   · подсказка про два режима цвета — ВИДИМОЙ строкой, а не в title (К160);
//   · «По умолчанию» — последняя в палитре: покрасив текст, вернуть его к
//     обычному цвету раньше было нечем (К159).
function renderRichTextToolbar() {
    const fontOptions = FONT_FAMILY_OPTIONS.map((o) => `<option value='${o.value}'>${escapeHtml(o.label)}</option>`).join('');
    const colorSwatches = TEXT_COLOR_SWATCHES.map((c) => `
        <button type="button" class="scr-rte__swatch" data-rte-color="${c.value}" style="background:${c.value}" title="${escapeHtml(c.label)}" aria-label="${escapeHtml(c.label)}"></button>
    `).join('');
    return `
        <div class="scr-rte__toolbar">
            <button type="button" class="ui-btn ui-btn--secondary" data-rte-cmd="bold" title="Жирный"><b>Ж</b></button>
            <button type="button" class="ui-btn ui-btn--secondary" data-rte-cmd="italic" title="Курсив"><i>К</i></button>
            <button type="button" class="ui-btn ui-btn--secondary" data-rte-cmd="insertUnorderedList" title="Список">☰ Список</button>
            <select class="ui-field__control ui-field__control--sm scr-rte__font" data-rte-font-select title="Шрифт" aria-label="Шрифт">
                <option value="" disabled selected>Шрифт…</option>
                ${fontOptions}
            </select>
            <button type="button" class="ui-btn ui-btn--secondary" data-rte-size-delta="-1" title="Уменьшить размер на 1px">A−</button>
            <button type="button" class="ui-btn ui-btn--secondary" data-rte-size-delta="1" title="Увеличить размер на 1px">A+</button>
            <div class="scr-rte__swatches">${colorSwatches}</div>
            <button type="button" class="ui-btn ui-btn--secondary" data-rte-color-reset>По умолчанию</button>
            <span class="ui-field__hint">Выделите текст и выберите цвет — либо выберите цвет и печатайте им дальше</span>
        </div>
    `;
}

/**
 * Готовит ОДИН редактор: находит поле внутри своей коробки .scr-rte и вешает
 * на неё полосу инструментов.
 *
 * Коробка, а не весь контейнер панели: редакторов на экране бывает до трёх
 * (основной текст и форма возражения), и полоса, найденная по всему
 * контейнеру, писала бы в чужое поле. Пока редактор был один, разницы не было.
 */
function setupEditor(box, toast) {
    const editorEl = box.querySelector('[data-role="rte-editor"]');
    if (!editorEl) return null;
    initRichTextEditor(editorEl);
    attachRichTextToolbar(box, editorEl, toast);
    return editorEl;
}

function renderEditorBox(content) {
    return `
        <div class="scr-rte">
            ${renderRichTextToolbar()}
            <div class="scr-rte__editor" contenteditable="true" data-role="rte-editor" data-placeholder="Текст, который видит оператор">${content || ''}</div>
        </div>
    `;
}

// Шапка блока наполнения: заголовок, рядом пояснение, справа действие (К162).
// Пояснение — не декор: раздел открывает человек, который скрипты пишет
// впервые, и разница между «основным текстом» и «возражением» для него
// неочевидна — и то и другое текст в рамке.
function renderCardHead(title, sub, action) {
    return `
        <div class="scr-card__head">
            <h3 class="scr-card__title">${escapeHtml(title)}</h3>
            <span class="scr-card__sub">${escapeHtml(sub)}</span>
            ${action || ''}
        </div>
    `;
}

const ROOT_HEAD_SUB = 'то, что оператор читает с начала разговора';

function renderRootBlock(root, uiState) {
    // Пусто и редактор ЕЩЁ НЕ ОТКРЫТ — полное пустое состояние с причиной и
    // следующим шагом. Пустой блок с уже развёрнутым редактором выглядит как
    // сломанное поле, а строчка «текста пока нет» рядом с ним — как обрывок.
    if (!root && !uiState.rootCreating) {
        return `
            <div class="scr-card">
                ${renderCardHead('Основной текст', ROOT_HEAD_SUB, '')}
                <div class="ui-empty">
                    <span class="ui-empty__icon"><svg class="ui-ic ui-ic--lg" aria-hidden="true"><use href="#ui-ic-scripts"></use></svg></span>
                    <b class="ui-empty__title">Основного текста пока нет</b>
                    <span class="ui-empty__text">С него начинается разговор: оператор видит его первым, до всех возражений.</span>
                    <button type="button" class="ui-btn ui-btn--ghost ui-empty__action" data-role="root-create-start">Создать основной текст</button>
                </div>
            </div>
        `;
    }
    if (!root) {
        return `
            <div class="scr-card">
                ${renderCardHead('Основной текст', ROOT_HEAD_SUB, '')}
                ${renderEditorBox('')}
                <div class="ui-btn-row">
                    <button type="button" class="ui-btn" data-role="root-create">Создать основной текст</button>
                    <button type="button" class="ui-btn ui-btn--ghost" data-role="root-create-cancel">Отмена</button>
                </div>
            </div>
        `;
    }
    if (uiState.rootEditing) {
        return `
            <div class="scr-card">
                ${renderCardHead('Основной текст', ROOT_HEAD_SUB, '')}
                ${renderEditorBox(root.content)}
                <div class="ui-btn-row">
                    <button type="button" class="ui-btn" data-role="root-save">Сохранить</button>
                    <button type="button" class="ui-btn ui-btn--ghost" data-role="root-cancel">Отмена</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="scr-card">
            ${renderCardHead('Основной текст', ROOT_HEAD_SUB,
                '<button type="button" class="ui-btn ui-btn--secondary" data-role="root-edit">Изменить</button>')}
            <div class="scr-node__content">${root.content}</div>
        </div>
    `;
}

// Форма возражения — одна на добавление и правку (К156). Текст правится тем же
// редактором, что и основной: возражение оператор читает вслух так же, и
// выделить в нём ключевую фразу нужно ровно так же. Сервер и раньше принимал
// разметку возражения, вводить её было негде.
function renderObjectionForm({ label, content, saveLabel, saveRole, cancelRole, id }) {
    const idAttr = id === undefined ? '' : ` data-id="${id}"`;
    return `
        <div class="scr-objection scr-objection--form"${idAttr}${id === undefined ? ' data-role="objection-new"' : ''}>
            <div class="ui-field">
                <label class="ui-field__label">Метка</label>
                <input type="text" class="ui-field__control" data-role="objection-label" value="${escapeHtml(label || '')}" placeholder="Например: Возражение: дорого" aria-label="Метка возражения">
                <span class="ui-field__hint">Без метки возражение показывается как «(без метки)» — оператору его не найти.</span>
            </div>
            <div class="ui-field">
                <label class="ui-field__label">Текст</label>
                ${renderEditorBox(content)}
            </div>
            <div class="ui-btn-row">
                <button type="button" class="ui-btn" ${saveRole}>${escapeHtml(saveLabel)}</button>
                <button type="button" class="ui-btn ui-btn--ghost" ${cancelRole}>Отмена</button>
            </div>
        </div>
    `;
}

function renderObjectionCard(node, editing) {
    if (editing) {
        return renderObjectionForm({
            id: node.id,
            label: node.label,
            content: node.content,
            saveLabel: 'Сохранить',
            saveRole: `data-action="save-objection" data-id="${node.id}"`,
            cancelRole: `data-action="cancel-edit-objection" data-id="${node.id}"`
        });
    }
    // Содержимое вставляется КАК РАЗМЕТКА, как и у основного текста: оно
    // прошло тот же санитайзер на сервере (routes/scriptsAdmin.js). До К156
    // здесь стоял escapeHtml — и правильно стоял: редактора у возражения не
    // было, сервер разметку не чистил, и вставлять её как разметку было
    // нельзя. Эти три вещи меняются вместе или не меняются вовсе.
    return `
        <div class="scr-objection" data-id="${node.id}">
            <div class="scr-node__label">${escapeHtml(node.label || '(без метки)')}</div>
            <div class="scr-node__content">${node.content}</div>
            <div class="scr-objection__acts">
                <button type="button" class="ui-btn ui-btn--secondary" data-action="edit-objection" data-id="${node.id}">Изменить</button>
                <button type="button" class="ui-btn ui-btn--danger" data-action="delete-objection" data-id="${node.id}">Удалить</button>
            </div>
        </div>
    `;
}

function renderObjectionsBlock(objections, uiState) {
    const cards = objections.map((o) => renderObjectionCard(o, uiState.editingObjectionId === o.id)).join('');
    const addForm = uiState.addingObjection ? renderObjectionForm({
        label: '',
        content: '',
        saveLabel: 'Добавить',
        saveRole: 'data-role="objection-create"',
        cancelRole: 'data-role="objection-create-cancel"'
    }) : '';

    // Значок вместо текстового плюса (К166): текстовый не масштабируется вместе
    // с лестницей значков и не совпадает по цвету и толщине с таким же плюсом в
    // четырёх других разделах.
    const addBtn = uiState.addingObjection ? '' :
        '<button type="button" class="ui-btn ui-btn--secondary" data-role="objection-add">'
        + '<svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-plus"></use></svg>Добавить возражение</button>';

    return `
        <div class="scr-card">
            ${renderCardHead('Возражения', 'оператор ищет их по метке во время разговора', addBtn)}
            ${objections.length
                ? `<div class="scr-objections">${cards}</div>`
                : '<div class="ui-empty ui-empty--inline"><span class="ui-empty__text">Пока нет возражений</span></div>'}
            ${addForm}
            <!-- Предупреждение про санитайзер (К163). Человек вставляет текст из
                 Word, видит его отформатированным в поле, сохраняет — и половина
                 оформления исчезает. Без строки это читается как потеря данных. -->
            <p class="ui-table-note">Разметка, которую вырезает санитайзер на сервере, не сохранится: редактор ограничен тем, что переживает сохранение.</p>
        </div>
    `;
}

// uiState = { rootEditing, rootCreating, addingObjection, editingObjectionId }
// handlers = { toast, busy, onCreateRootStart, onEditRootStart, onCancelRootEdit, onCreateRoot(html), onSaveRoot(root, html),
//              onAddObjectionStart, onAddObjectionCancel, onCreateObjection({label, content}),
//              onEditObjectionStart(id), onEditObjectionCancel, onSaveObjection(node, {label, content}),
//              onDeleteObjection(id) }
export function renderNodesPanel(container, nodes, uiState, handlers) {
    const root = nodes.find((n) => n.parentId === null) || null;
    const objections = root ? nodes.filter((n) => n.parentId === root.id) : [];

    container.innerHTML = renderRootBlock(root, uiState) + (root ? renderObjectionsBlock(objections, uiState) : '');

    // Кнопки, которые шлют запрос, блокируются на время запроса (handlers.busy).
    // Без этого двойной клик уходит дважды: по «Добавить возражение» это два
    // одинаковых возражения в базе, по «Создать основной текст» — отказ сервера
    // «У скрипта уже есть корневой узел» в ответ на собственный двойной клик.
    if (!root) {
        const startBtn = container.querySelector('[data-role="root-create-start"]');
        if (startBtn) {
            startBtn.addEventListener('click', handlers.onCreateRootStart);
            return;
        }
        const rootBox = container.querySelector('.scr-rte');
        const editorEl = setupEditor(rootBox, handlers.toast);
        const createBtn = container.querySelector('[data-role="root-create"]');
        createBtn.addEventListener('click', () => {
            handlers.busy(createBtn, () => handlers.onCreateRoot(getEditorHtmlForSave(editorEl)));
        });
        container.querySelector('[data-role="root-create-cancel"]').addEventListener('click', handlers.onCancelRootEdit);
        // Фокус — в редактор, курсор там, где человек будет печатать (К165).
        editorEl.focus();
        return;
    }

    if (uiState.rootEditing) {
        const rootBox = container.querySelector('.scr-rte');
        const editorEl = setupEditor(rootBox, handlers.toast);
        const saveBtn = container.querySelector('[data-role="root-save"]');
        saveBtn.addEventListener('click', () => {
            handlers.busy(saveBtn, () => handlers.onSaveRoot(root, getEditorHtmlForSave(editorEl)));
        });
        container.querySelector('[data-role="root-cancel"]').addEventListener('click', handlers.onCancelRootEdit);
        // «Изменить» ведёт В РЕДАКТОР, а не оставляет фокус на кнопке (К165):
        // кнопку уже нажали, дальше человек печатает.
        editorEl.focus();
    } else {
        container.querySelector('[data-role="root-edit"]').addEventListener('click', handlers.onEditRootStart);
    }

    const addBtn = container.querySelector('[data-role="objection-add"]');
    if (addBtn) addBtn.addEventListener('click', handlers.onAddObjectionStart);

    const newCard = container.querySelector('[data-role="objection-new"]');
    if (newCard) {
        const editorEl = setupEditor(newCard.querySelector('.scr-rte'), handlers.toast);
        const createObjectionBtn = newCard.querySelector('[data-role="objection-create"]');
        createObjectionBtn.addEventListener('click', () => {
            handlers.busy(createObjectionBtn, () => handlers.onCreateObjection(readObjectionFields(newCard, editorEl)));
        });
        newCard.querySelector('[data-role="objection-create-cancel"]').addEventListener('click', handlers.onAddObjectionCancel);
        // «Добавить возражение» ведёт в поле «Метка» (К165).
        newCard.querySelector('[data-role="objection-label"]').focus();
    }

    container.querySelectorAll('[data-action="edit-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onEditObjectionStart(Number(btn.dataset.id)));
    });
    container.querySelectorAll('[data-action="cancel-edit-objection"]').forEach((btn) => {
        btn.addEventListener('click', handlers.onEditObjectionCancel);
    });
    // Открытая форма правки — свой редактор и свой фокус, как у добавления.
    const editingCard = uiState.editingObjectionId === null ? null
        : container.querySelector(`.scr-objection--form[data-id="${uiState.editingObjectionId}"]`);
    let editingEditor = null;
    if (editingCard) {
        editingEditor = setupEditor(editingCard.querySelector('.scr-rte'), handlers.toast);
        editingCard.querySelector('[data-role="objection-label"]').focus();
    }

    container.querySelectorAll('[data-action="save-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.id);
            // Поля читаются в границах СВОЕЙ карточки, а не по составному id по
            // всей панели: в оболочке одинаковые data-role живут и в соседней
            // панели тоже (образец куратора, п.4).
            const card = btn.closest('.scr-objection');
            const node = objections.find((o) => o.id === id);
            handlers.busy(btn, () => handlers.onSaveObjection(node, readObjectionFields(card, editingEditor)));
        });
    });
    container.querySelectorAll('[data-action="delete-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onDeleteObjection(Number(btn.dataset.id)));
    });
}

// Текст берётся из редактора той же карточки: разметка живёт в innerHTML, а не
// в .value, и читать её надо ровно тем же путём, что у основного текста —
// вместе с чисткой брошенных пустых span'ов.
function readObjectionFields(card, editorEl) {
    const editor = editorEl || card.querySelector('[data-role="rte-editor"]');
    return {
        label: card.querySelector('[data-role="objection-label"]').value,
        content: editor ? getEditorHtmlForSave(editor) : ''
    };
}
