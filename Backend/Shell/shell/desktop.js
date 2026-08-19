// --- shell/desktop.js: рабочий стол и плитки ---
//
// Стол — это и есть навигация: боковой рейки в проекте нет (решение владельца
// 17.08.2026). Отсюда требования, которые проверяются на приёмке этапа 1:
// первый экран после входа — стол, а возврат на него достижим одним действием
// из любого состояния (кнопка «Главная» в полосе свёрнутых).
//
// Модуль подписывается на оболочку и НЕ трогает её внутренности:
//   shell.registry / shell.openSection / shell.isMigrated / shell.on('change')
//
// Какие разделы сейчас на экране, спрашиваем у оболочки (shell.getVisible),
// а пока метода нет — читаем адрес: оболочка пишет туда ключи ВИДИМЫХ панелей
// до того, как разошлёт событие. Чужой DOM не читаем: это привязка к разметке
// панелей, которую куратор вправе менять.

import { getRoute } from './router.js';
import { createPopover } from '../ui/popover.js';
import { iconNode } from '../ui/icons.js';

// Служебные плитки. В реестре разделов их нет намеренно: это не разделы CRM,
// у них нет ни модуля, ни маршрута — просто ссылка. Каталог элементов открыт
// со стола, потому что им пользуются и дизайн-сессия, и разработчик.
const SERVICE_TILES = [
    { key: 'catalog', title: 'Элементы', icon: 'catalog', href: '/ui-catalog.html' }
];

let shellApi = null;
let desktopEl = null;
let stageEl = null;
let tilesEl = null;
let picker = null;
let pickerEl = null;
let unsubscribe = [];

export function initDesktop(options = {}) {
    shellApi = options.shell;
    desktopEl = options.desktop;
    stageEl = options.stage;
    if (!shellApi || !desktopEl || !stageEl) throw new Error('initDesktop: нужны shell, desktop и stage');

    renderFrame();
    renderTiles();
    sync();

    unsubscribe.push(shellApi.on('change', sync));
    unsubscribe.push(shellApi.on('split-request', openPicker));

    return { destroy };
}

export function destroy() {
    unsubscribe.forEach((off) => off());
    unsubscribe = [];
    if (picker) { picker.destroy(); picker = null; }
    if (pickerEl) { pickerEl.remove(); pickerEl = null; }
}

// ---------------------------------------------------------------- разметка

function renderFrame() {
    const inner = document.createElement('div');
    inner.className = 'shell-desktop__inner';

    const head = document.createElement('div');
    head.className = 'shell-desktop__head';

    const titles = document.createElement('div');
    const eyebrow = document.createElement('div');
    eyebrow.className = 'shell-desktop__eyebrow';
    eyebrow.textContent = 'CRM';
    const title = document.createElement('h1');
    title.className = 'shell-desktop__title';
    title.textContent = 'Рабочий стол';
    titles.append(eyebrow, title);

    const date = document.createElement('div');
    date.className = 'shell-desktop__date';
    date.textContent = today();

    const hint = document.createElement('div');
    hint.className = 'shell-desktop__hint';
    hint.textContent = 'Раздел открывается панелью поверх стола. Панелей может быть две — вторую добавляет «Разделить экран» в шапке панели.';

    head.append(titles, date, hint);

    const groupSections = document.createElement('div');
    groupSections.className = 'shell-desktop__group';
    groupSections.textContent = 'Разделы';

    tilesEl = document.createElement('div');
    tilesEl.className = 'shell-tiles';
    tilesEl.dataset.role = 'tiles';

    const groupService = document.createElement('div');
    groupService.className = 'shell-desktop__group';
    groupService.textContent = 'Служебное';

    const serviceTiles = document.createElement('div');
    serviceTiles.className = 'shell-tiles';
    serviceTiles.dataset.role = 'tiles-service';
    SERVICE_TILES.forEach((item) => serviceTiles.appendChild(serviceTile(item)));

    inner.append(head, groupSections, tilesEl, groupService, serviceTiles);
    desktopEl.appendChild(inner);

    tilesEl.addEventListener('click', (event) => {
        const tile = event.target.closest('[data-key]');
        if (!tile) return;
        shellApi.openSection(tile.dataset.key);
    });
}

function renderTiles() {
    tilesEl.innerHTML = '';
    shellApi.registry.forEach((section) => tilesEl.appendChild(sectionTile(section)));
}

function sectionTile(section) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'shell-tile';
    tile.dataset.key = section.key;

    const icon = document.createElement('span');
    icon.className = 'shell-tile__icon';
    icon.appendChild(iconNode(section.icon, 'lg'));

    const name = document.createElement('span');
    name.className = 'shell-tile__name';
    name.textContent = section.title;

    tile.append(icon, name);
    return tile;
}

function serviceTile(item) {
    const tile = document.createElement('a');
    tile.className = 'shell-tile';
    tile.href = item.href;
    tile.target = '_blank';
    tile.rel = 'noopener';
    tile.dataset.service = item.key;

    const mark = document.createElement('span');
    mark.className = 'shell-tile__legacy-mark';
    mark.append(iconNode('ext', 'xs'), document.createTextNode('в новой вкладке'));

    const icon = document.createElement('span');
    icon.className = 'shell-tile__icon';
    icon.appendChild(iconNode(item.icon, 'lg'));

    const name = document.createElement('span');
    name.className = 'shell-tile__name';
    name.textContent = item.title;

    tile.append(mark, icon, name);
    return tile;
}

// Значок берётся из набора проекта (ui/icons.js): раньше здесь строился <i>
// с классом Font Awesome, и стол был последним местом, где жил внешний набор.

// ---------------------------------------------------------------- состояние

/**
 * Пометки плиток и видимость стола. Стол не разрушается при открытии панели —
 * он остаётся под ней: спрятать и собрать заново значило бы терять позицию
 * прокрутки на каждом открытии.
 */
// Какие разделы были открыты на прошлой перерисовке стола: по разнице
// вычисляется закрытый раздел, чтобы вернуть на его плитку фокус (К19).
let prevOpen = [];

function sync() {
    const open = openKeys();

    Array.from(tilesEl.children).forEach((tile) => {
        const key = tile.dataset.key;
        const isOpen = open.includes(key);
        const legacy = !shellApi.isMigrated(key);

        tile.classList.toggle('shell-tile--open', isOpen);
        tile.classList.toggle('shell-tile--legacy', legacy);

        const oldMark = tile.querySelector('.shell-tile__mark, .shell-tile__legacy-mark');
        if (oldMark) oldMark.remove();

        if (isOpen) {
            const mark = document.createElement('span');
            mark.className = 'shell-tile__mark';
            mark.textContent = 'открыт';
            tile.prepend(mark);
        } else if (legacy) {
            const mark = document.createElement('span');
            mark.className = 'shell-tile__legacy-mark';
            mark.append(iconNode('ext', 'xs'), document.createTextNode('в новой вкладке'));
            tile.prepend(mark);
        }
    });

    const stageVisible = visibleKeys().length > 0;
    stageEl.hidden = !stageVisible;

    // Стол НЕ разрушается, когда открыта панель, — это осознанное решение, и
    // менять его нельзя. Но пока сцена накрывает его, плитки не должны быть
    // достижимы: до этой строки первые четыре остановки Tab с начала документа
    // приходились на плитки ПОД панелью, и только пятая заходила внутрь неё
    // (К11). `inert` заодно убирает стол из дерева доступности — отдельный
    // aria-hidden не нужен и был бы вторым источником правды.
    desktopEl.inert = stageVisible;

    // Фокус ВОЗВРАЩАЕТСЯ на плитку закрытого раздела. Без этого он терялся в
    // начало документа: панель, в которой он стоял, исчезала, и следующий Tab
    // начинал обход заново (К19). Возвращаем только если фокус действительно
    // потерян, — иначе перебьём осознанный переход человека в другое место.
    //
    // Строго ПОСЛЕ снятия inert: в inert-контейнере focus() молча не работает,
    // и первая версия этой правки не делала ничего.
    const closed = prevOpen.filter((key) => !open.includes(key));
    prevOpen = open;
    if (closed.length === 1 && !desktopEl.inert
        && (!document.activeElement || document.activeElement === document.body)) {
        const tile = tilesEl.querySelector(`[data-key="${closed[0]}"]`);
        if (tile) tile.focus();
    }
}

/** Открытые разделы: видимые панели плюс свёрнутые. */
function openKeys() {
    const minimized = shellApi.getMinimized().map((item) => item.key);
    return visibleKeys().concat(minimized);
}

/**
 * Ключи видимых панелей. Спрашиваем оболочку, если она умеет отвечать, и
 * только иначе читаем адрес: адрес — глобальное состояние страницы, и стол,
 * который на него опирается, нельзя ни проверить в изоляции, ни завести
 * вторым экземпляром. Метод getVisible запрошен у куратора (dialog.md).
 */
function visibleKeys() {
    return typeof shellApi.getVisible === 'function' ? shellApi.getVisible() : getRoute();
}

function today() {
    // Пояс приложения задан константой на сервере; на клиенте подпись даты
    // считается по тому же поясу, иначе у сотрудника из другого часового
    // пояса на столе будет вчерашнее число.
    return new Date().toLocaleDateString('ru-RU', {
        timeZone: 'Europe/Moscow',
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    });
}

// ---------------------------------------------------------------- вторая панель

/**
 * «Разделить экран» → выбор раздела для второй половины.
 *
 * В макете это отдельная панель-заглушка со списком. Сделано поповером у самой
 * кнопки: панель-заглушка потребовала бы служебного раздела в реестре и
 * особого случая в panels.js, а поповер уже есть в слое и по своему контракту
 * не выходит за границы своей панели. Расхождение с макетом описано в
 * dialog.md.
 */
function openPicker(event) {
    const anchor = document.querySelector(`.shell-panel[data-panel-id="${event.panelId}"] [data-act="split"]`);
    if (!anchor) return;

    const open = openKeys();
    const free = shellApi.registry.filter((section) => !open.includes(section.key));

    buildPicker(free);
    picker.open(anchor);
}

function buildPicker(sections) {
    if (!pickerEl) {
        pickerEl = document.createElement('div');
        pickerEl.className = 'ui-popover';
        pickerEl.dataset.role = 'picker';
        pickerEl.hidden = true;
        document.body.appendChild(pickerEl);
        picker = createPopover(pickerEl);
        pickerEl.addEventListener('click', (clickEvent) => {
            const option = clickEvent.target.closest('[data-pick]');
            if (!option) return;
            picker.close();
            shellApi.openSection(option.dataset.pick);
        });
    }

    pickerEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'shell-picker__title';
    title.textContent = 'Что открыть рядом';
    const sub = document.createElement('div');
    sub.className = 'shell-picker__sub';
    sub.textContent = 'Раздел откроется во второй половине экрана. Границу между панелями можно тянуть.';
    pickerEl.append(title, sub);

    if (!sections.length) {
        const empty = document.createElement('div');
        empty.className = 'shell-picker__sub';
        empty.textContent = 'Все разделы уже открыты или свёрнуты.';
        pickerEl.appendChild(empty);
        return;
    }

    const step = document.createElement('div');
    step.className = 'ui-popover__step';

    sections.forEach((section) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'ui-popover__option';
        option.dataset.pick = section.key;

        const icon = iconNode(section.icon, 'sm', 'shell-picker__icon');
        const label = document.createElement('span');
        label.textContent = section.title;

        // Неперенесённый раздел подписан прямо в списке: он откроется не рядом,
        // а в новой вкладке, и узнать об этом лучше до нажатия.
        if (!shellApi.isMigrated(section.key)) {
            const sub2 = document.createElement('span');
            sub2.className = 'ui-popover__option-sub';
            sub2.textContent = 'по старому адресу';
            label.appendChild(sub2);
        }

        option.append(icon, label);
        step.appendChild(option);
    });

    pickerEl.appendChild(step);
}
