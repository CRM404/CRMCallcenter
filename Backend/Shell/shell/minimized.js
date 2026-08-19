// --- shell/minimized.js: полоса свёрнутых панелей и кнопка «Главная» ---
//
// Полоса — вторая половина навигации после стола: рейки в проекте нет, и
// возврат к свёрнутому разделу возможен только отсюда.
//
// Три правила, которые обязаны работать буквально (бриф, 5.3):
//   - чип возвращает панель; если обе половины заняты, оболочка сама свернёт
//     активную и проговорит это тостом — здесь ничего специального делать не
//     нужно, восстановление идёт через shell.restoreSection;
//   - «Свернуть все» именно СВОРАЧИВАЕТ: содержимое и позиция сохраняются;
//   - полоса не перекрывает панели — пока она видна, сцена получает нижний
//     отступ (класс на сцене, правило в desktop.css).

import { iconNode } from '../ui/icons.js';

let shellApi = null;
let barEl = null;
let listEl = null;
let homeEl = null;
let stageEl = null;
let unsubscribe = [];

export function initMinimized(options = {}) {
    shellApi = options.shell;
    barEl = options.bar;
    stageEl = options.stage;
    if (!shellApi || !barEl || !stageEl) throw new Error('initMinimized: нужны shell, bar и stage');

    renderFrame();
    sync();
    unsubscribe.push(shellApi.on('change', sync));

    return { destroy };
}

export function destroy() {
    unsubscribe.forEach((off) => off());
    unsubscribe = [];
    if (homeEl) { homeEl.remove(); homeEl = null; }
}

function renderFrame() {
    const label = document.createElement('span');
    label.className = 'shell-minimized__label';
    label.textContent = 'Свёрнуто';

    listEl = document.createElement('div');
    listEl.className = 'shell-minimized__list';
    listEl.dataset.role = 'minimized-list';

    barEl.append(label, listEl);

    // «Главная» — ЕДИНСТВЕННАЯ кнопка «свернуть всё», и она вне полосы.
    //
    // В брифе (5.1) эта роль отдана кнопке «Свернуть все» ВНУТРИ полосы. Так
    // сделать нельзя: полоса появляется только когда что-то уже свёрнуто, а
    // нужна кнопка ровно в противоположном состоянии — две панели открыты,
    // свёрнутых нет, полосы нет. Тогда кнопка была бы недостижима в момент,
    // ради которого существует. В макете эту роль играет «Главная» внизу
    // слева, и он в таких расхождениях главнее (бриф, 5.1). Двух кнопок с
    // одинаковым действием в одном углу не делаем.
    homeEl = document.createElement('button');
    homeEl.type = 'button';
    homeEl.className = 'shell-home';
    homeEl.dataset.role = 'home';
    homeEl.title = 'На рабочий стол: панели свернутся, работа сохранится';
    homeEl.setAttribute('aria-label', 'На рабочий стол');
    homeEl.appendChild(iconNode('home', 'sm'));
    homeEl.addEventListener('click', goHome);
    document.body.appendChild(homeEl);

    listEl.addEventListener('click', (event) => {
        const close = event.target.closest('[data-close]');
        if (close) {
            shellApi.closeSection(close.dataset.close);
            return;
        }
        const open = event.target.closest('[data-restore]');
        if (open) shellApi.restoreSection(open.dataset.restore);
    });
}

/**
 * Возврат на стол. Панели именно СВОРАЧИВАЮТСЯ: содержимое, введённый текст и
 * позиция прокрутки остаются. Исчезновение панелей проговаривается — иначе
 * это читается как «всё закрылось».
 */
function goHome() {
    const before = document.querySelectorAll('.shell-panel:not([hidden])').length;
    shellApi.minimizeAll();
    if (before > 0) shellApi.toast('Панели свёрнуты — они внизу');
}

function sync() {
    const items = shellApi.getMinimized();

    listEl.innerHTML = '';
    items.forEach((item) => listEl.appendChild(chip(item)));

    barEl.hidden = items.length === 0;
    // Отступ сцены — пока полоса видна: панель не должна уезжать под неё.
    stageEl.classList.toggle('shell-stage--with-bar', items.length > 0);

    // Кнопка «Главная» нужна, только когда со стола что-то открыто: на пустом
    // столе она вела бы туда, где человек и так находится.
    const hasPanels = items.length > 0 || !stageEl.hidden;
    homeEl.hidden = !hasPanels;

    // Кнопка накрывает панель — сцена резервирует под неё полосу ровно тогда,
    // когда кнопка видна (Д10).
    stageEl.classList.toggle('shell-stage--with-home', hasPanels);
}

function chip(item) {
    const box = document.createElement('span');
    box.className = 'shell-mini';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'shell-mini__open';
    open.dataset.restore = item.panelId;

    const icon = iconNode(item.meta.icon || 'split', 'sm', 'shell-mini__icon');

    const title = document.createElement('span');
    title.textContent = item.meta.title || item.key;

    open.append(icon, title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'shell-mini__close';
    close.dataset.close = item.panelId;
    close.title = `Закрыть «${item.meta.title || item.key}»`;
    close.setAttribute('aria-label', `Закрыть «${item.meta.title || item.key}»`);
    close.appendChild(iconNode('close', 'sm'));

    box.append(open, close);
    return box;
}
