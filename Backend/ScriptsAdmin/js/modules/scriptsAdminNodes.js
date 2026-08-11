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
// Возражения остаются обычным plain-text textarea + escapeHtml, как раньше.

import { showToast } from './scriptsAdminToast.js';

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

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
const TEXT_COLOR_SWATCHES = [
    { value: '#000000', label: 'Чёрный' },
    { value: '#d92b2b', label: 'Красный' },
    { value: '#e07b0f', label: 'Оранжевый' },
    { value: '#b8960c', label: 'Жёлтый' },
    { value: '#1f8a3d', label: 'Зелёный' },
    { value: '#1a56db', label: 'Синий' },
    { value: '#7c3aed', label: 'Фиолетовый' }
];

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

function applyFontFamily(editorEl, cssValue) {
    const range = getEditorSelectionRange(editorEl);
    if (!range) {
        showToast('Выделите текст', 'error');
        return;
    }
    wrapRangeInSpan(range, `font-family: ${cssValue}`);
}

function applyFontSizeDelta(editorEl, delta) {
    const range = getEditorSelectionRange(editorEl);
    if (!range) {
        showToast('Выделите текст', 'error');
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
function applySwatchColor(editorEl, hexColor) {
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
    showToast('Сначала кликните в текст', 'error');
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

function attachRichTextToolbar(container, editorEl) {
    container.querySelectorAll('[data-rte-cmd]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault()); // не терять фокус/выделение в редакторе
        btn.addEventListener('click', () => {
            editorEl.focus();
            document.execCommand(btn.dataset.rteCmd, false, null);
            autoGrow(editorEl);
        });
    });

    // Шрифт/размер — свой span-based механизм (не execCommand, см. scriptsAdminNodes.js
    // шапку файла и бриф п.1), работает только пока выделение внутри editorEl.
    container.querySelectorAll('[data-rte-size-delta]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
            applyFontSizeDelta(editorEl, Number(btn.dataset.rteSizeDelta));
            autoGrow(editorEl);
        });
    });

    const fontSelect = container.querySelector('[data-rte-font-select]');
    if (fontSelect) {
        fontSelect.addEventListener('mousedown', (e) => e.stopPropagation());
        fontSelect.addEventListener('change', () => {
            applyFontFamily(editorEl, fontSelect.value);
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
            applySwatchColor(editorEl, btn.dataset.rteColor);
            autoGrow(editorEl);
        });
    });
}

function renderRichTextToolbar() {
    const fontOptions = FONT_FAMILY_OPTIONS.map((o) => `<option value='${o.value}'>${escapeHtml(o.label)}</option>`).join('');
    const colorSwatches = TEXT_COLOR_SWATCHES.map((c) => `
        <button type="button" class="sa-rte-swatch" data-rte-color="${c.value}" style="background:${c.value}" title="${escapeHtml(c.label)}" aria-label="${escapeHtml(c.label)}"></button>
    `).join('');
    return `
        <div class="sa-rte-toolbar">
            <button type="button" class="btn btn-secondary btn-sm" data-rte-cmd="bold" title="Жирный"><b>Ж</b></button>
            <button type="button" class="btn btn-secondary btn-sm" data-rte-cmd="italic" title="Курсив"><i>К</i></button>
            <button type="button" class="btn btn-secondary btn-sm" data-rte-cmd="insertUnorderedList" title="Список">☰ Список</button>
            <select class="sa-rte-font-select" data-rte-font-select title="Шрифт">
                <option value="" disabled selected>Шрифт…</option>
                ${fontOptions}
            </select>
            <button type="button" class="btn btn-secondary btn-sm" data-rte-size-delta="-1" title="Уменьшить размер на 1px">A−</button>
            <button type="button" class="btn btn-secondary btn-sm" data-rte-size-delta="1" title="Увеличить размер на 1px">A+</button>
            <div class="sa-rte-swatches" title="Цвет текста: выделите текст и выберите цвет, либо выберите цвет и печатайте им дальше">${colorSwatches}</div>
        </div>
    `;
}

function renderRootBlock(root, editing) {
    if (!root) {
        return `
            <div class="sa-root-box">
                <h3>Основной текст</h3>
                <div class="sa-empty-state">У скрипта пока нет основного текста.</div>
                <div class="form-group">
                    <label>Текст</label>
                    <div class="sa-rte">
                        ${renderRichTextToolbar()}
                        <div class="sa-rte-editor" contenteditable="true" id="saRootNewContent" data-placeholder="Текст, который видит оператор"></div>
                    </div>
                </div>
                <div class="sa-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="saRootCreateBtn">Создать основной текст</button>
                </div>
            </div>
        `;
    }
    if (editing) {
        return `
            <div class="sa-root-box">
                <h3>Основной текст</h3>
                <div class="form-group">
                    <label>Текст</label>
                    <div class="sa-rte">
                        ${renderRichTextToolbar()}
                        <div class="sa-rte-editor" contenteditable="true" id="saRootEditContent" data-placeholder="Текст, который видит оператор">${root.content}</div>
                    </div>
                </div>
                <div class="sa-actions">
                    <button type="button" class="btn btn-primary btn-sm" id="saRootSaveBtn">Сохранить</button>
                    <button type="button" class="btn btn-secondary btn-sm" id="saRootCancelBtn">Отмена</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="sa-root-box">
            <h3>Основной текст</h3>
            <div class="sa-node-content">${root.content}</div>
            <div class="sa-actions" style="margin-top:10px;">
                <button type="button" class="btn btn-secondary btn-sm" id="saRootEditBtn">Изменить</button>
            </div>
        </div>
    `;
}

function renderObjectionCard(node, editing) {
    if (editing) {
        return `
            <div class="sa-objection-card" data-id="${node.id}">
                <div class="form-group">
                    <label for="saObjectionEditLabel-${node.id}">Метка</label>
                    <input type="text" id="saObjectionEditLabel-${node.id}" value="${escapeHtml(node.label || '')}">
                </div>
                <div class="form-group">
                    <label for="saObjectionEditContent-${node.id}">Текст</label>
                    <textarea id="saObjectionEditContent-${node.id}" rows="3">${escapeHtml(node.content)}</textarea>
                </div>
                <div class="sa-actions">
                    <button type="button" class="btn btn-primary btn-sm" data-action="save-objection" data-id="${node.id}">Сохранить</button>
                    <button type="button" class="btn btn-secondary btn-sm" data-action="cancel-edit-objection" data-id="${node.id}">Отмена</button>
                </div>
            </div>
        `;
    }
    return `
        <div class="sa-objection-card" data-id="${node.id}">
            <div class="sa-node-label">${escapeHtml(node.label || '(без метки)')}</div>
            <div class="sa-node-content">${escapeHtml(node.content)}</div>
            <div class="sa-actions" style="margin-top:8px;">
                <button type="button" class="btn btn-secondary btn-sm" data-action="edit-objection" data-id="${node.id}">Изменить</button>
                <button type="button" class="btn btn-danger btn-sm" data-action="delete-objection" data-id="${node.id}">Удалить</button>
            </div>
        </div>
    `;
}

function renderObjectionsBlock(objections, uiState) {
    const cards = objections.map((o) => renderObjectionCard(o, uiState.editingObjectionId === o.id)).join('');
    const addForm = uiState.addingObjection ? `
        <div class="sa-objection-card">
            <div class="form-group">
                <label for="saObjectionNewLabel">Метка</label>
                <input type="text" id="saObjectionNewLabel" placeholder="Например: Возражение: дорого">
            </div>
            <div class="form-group">
                <label for="saObjectionNewContent">Текст</label>
                <textarea id="saObjectionNewContent" rows="3"></textarea>
            </div>
            <div class="sa-actions">
                <button type="button" class="btn btn-primary btn-sm" id="saObjectionCreateBtn">Добавить</button>
                <button type="button" class="btn btn-secondary btn-sm" id="saObjectionCreateCancelBtn">Отмена</button>
            </div>
        </div>
    ` : '';

    return `
        <div class="sa-objections-box">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
                <h3 style="margin:0;">Возражения</h3>
                ${!uiState.addingObjection ? '<button type="button" class="btn btn-secondary btn-sm" id="saObjectionAddBtn">+ Добавить возражение</button>' : ''}
            </div>
            ${objections.length ? `<div class="sa-objections-list">${cards}</div>` : '<div class="sa-empty-state">Пока нет возражений.</div>'}
            ${addForm}
        </div>
    `;
}

// uiState = { rootEditing, addingObjection, editingObjectionId }
// handlers = { onEditRootStart, onCancelRootEdit, onCreateRoot(html), onSaveRoot(root, html),
//              onAddObjectionStart, onAddObjectionCancel, onCreateObjection({label, content}),
//              onEditObjectionStart(id), onEditObjectionCancel, onSaveObjection(node, {label, content}),
//              onDeleteObjection(id) }
export function renderNodesPanel(container, nodes, uiState, handlers) {
    const root = nodes.find((n) => n.parentId === null) || null;
    const objections = root ? nodes.filter((n) => n.parentId === root.id) : [];

    container.innerHTML = renderRootBlock(root, uiState.rootEditing) + (root ? renderObjectionsBlock(objections, uiState) : '');

    if (!root) {
        const editorEl = container.querySelector('#saRootNewContent');
        initRichTextEditor(editorEl);
        attachRichTextToolbar(container, editorEl);
        container.querySelector('#saRootCreateBtn').addEventListener('click', () => {
            handlers.onCreateRoot(getEditorHtmlForSave(editorEl));
        });
        return;
    }

    if (uiState.rootEditing) {
        const editorEl = container.querySelector('#saRootEditContent');
        initRichTextEditor(editorEl);
        attachRichTextToolbar(container, editorEl);
        container.querySelector('#saRootSaveBtn').addEventListener('click', () => {
            handlers.onSaveRoot(root, getEditorHtmlForSave(editorEl));
        });
        container.querySelector('#saRootCancelBtn').addEventListener('click', handlers.onCancelRootEdit);
    } else {
        container.querySelector('#saRootEditBtn').addEventListener('click', handlers.onEditRootStart);
    }

    const addBtn = container.querySelector('#saObjectionAddBtn');
    if (addBtn) addBtn.addEventListener('click', handlers.onAddObjectionStart);

    const createBtn = container.querySelector('#saObjectionCreateBtn');
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            const label = container.querySelector('#saObjectionNewLabel').value;
            const content = container.querySelector('#saObjectionNewContent').value;
            handlers.onCreateObjection({ label, content });
        });
        container.querySelector('#saObjectionCreateCancelBtn').addEventListener('click', handlers.onAddObjectionCancel);
    }

    container.querySelectorAll('[data-action="edit-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onEditObjectionStart(Number(btn.dataset.id)));
    });
    container.querySelectorAll('[data-action="cancel-edit-objection"]').forEach((btn) => {
        btn.addEventListener('click', handlers.onEditObjectionCancel);
    });
    container.querySelectorAll('[data-action="save-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = Number(btn.dataset.id);
            const label = container.querySelector(`#saObjectionEditLabel-${id}`).value;
            const content = container.querySelector(`#saObjectionEditContent-${id}`).value;
            const node = objections.find((o) => o.id === id);
            handlers.onSaveObjection(node, { label, content });
        });
    });
    container.querySelectorAll('[data-action="delete-objection"]').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onDeleteObjection(Number(btn.dataset.id)));
    });
}
