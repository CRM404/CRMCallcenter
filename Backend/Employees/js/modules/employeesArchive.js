// --- employeesArchive.js: три окна архива сотрудника (пункт Р7, часть 5Б) ---
//
// Вывод из работы поодиночке, вывод пачкой и возврат. Вынесены из
// employeesTable.js отдельным файлом: тот и без них на восемьсот строк, а окна
// живут своей жизнью — у них своя разметка, свои тексты и свой разговор с
// сервером.
//
// ЭКРАН НЕ СЧИТАЕТ НИЧЕГО САМ (паспорт Р7). Ни числа последствий, ни кто занял
// добавочный, ни список занятых — всё приходит с сервера готовым
// (`archive-preview`). Вторая копия расчёта совпала бы в день написания и
// разошлась в первый же день правки, а выглядело бы это как «окно соврало», и
// искать пошли бы в окне.

import { openModal } from '/ui/modal.js';
import { icon } from '/ui/icons.js';

const KIND_LABEL = { dismissed: 'Уволен', frozen: 'Заморожен' };

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function formatDate(value) {
    if (!value) return '';
    const parts = String(value).slice(0, 10).split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : String(value);
}

function fullName(emp) {
    return [emp.lastName, emp.firstName].filter(Boolean).join(' ');
}

/** Строка списка последствий: число слева колонкой 34, что это — справа. */
function blockRow(count, what) {
    const row = el('div', 'arc-block__row');
    row.append(el('span', 'arc-block__count', String(count)), el('span', 'arc-block__what', what));
    return row;
}

/**
 * Третья строка последствий — ТРИ ЧИСЛА, а не два (Р7-5, ответ куратора И88).
 *
 * Средний случай — «перезвон на завтра» — у работающего оператора самый частый,
 * и свалить его в любую из крайних значит соврать в том самом окне, по которому
 * человек принимает решение. Деление считает сервер условием очереди, а не
 * флагом releases_lead: флаг описывает, что делать ПОСЛЕ звонка, а не попадёт
 * ли лид в раздачу.
 */
function leadsLine(queue) {
    return `лидов открепятся сразу: ${queue.now} вернутся в очередь, `
        + `${queue.later} придут позже по времени перезвона, `
        + `${queue.none} — с окончательным статусом, работы по ним больше нет`;
}

/**
 * Переключатель «Уволен / Заморожен».
 *
 * ПОЧЕМУ .ui-switch, А НЕ РАДИО (Р7-3): это выбор значения в форме, и радио
 * просилось бы больше всего — но радио в слое нет вовсе, а заводить узел ради
 * одного окна дороже, чем взять существующий переключатель. Он называет оба
 * значения словами и несёт метку required. Сказано вслух намеренно: следующий,
 * кто соберёт похожую форму, должен повторить приём как решение, а не как
 * случайно найденный образец.
 *
 * Стоит ПЕРВЫМ и обязателен: меняет не поведение, а слово в карточке человека,
 * и выбирать его надо осознанно, до чтения последствий.
 */
function kindField(state) {
    const field = el('div', 'ui-field');
    field.appendChild(el('label', 'ui-field__label ui-field__label--required', 'Что записать'));

    const sw = el('div', 'ui-switch');
    sw.setAttribute('role', 'tablist');
    for (const kind of ['dismissed', 'frozen']) {
        const btn = el('button', 'ui-switch__option', KIND_LABEL[kind]);
        btn.type = 'button';
        btn.dataset.kind = kind;
        // Умолчание — «Уволен», как более частый случай (ответ куратора И81).
        if (kind === state.kind) btn.classList.add('ui-switch__option--active');
        btn.addEventListener('click', () => {
            state.kind = kind;
            sw.querySelectorAll('.ui-switch__option').forEach((b) => {
                b.classList.toggle('ui-switch__option--active', b.dataset.kind === kind);
            });
        });
        sw.appendChild(btn);
    }
    field.appendChild(sw);
    field.appendChild(el('span', 'ui-field__hint',
        'Заморозка — декрет, долгий отпуск, отстранение. Для системы разницы нет: '
        + 'добавочный освобождается и ключ отзывается в обоих случаях.'));
    return field;
}

/** Плашка слоя: вид, значок, заголовок и текст. */
function note(kind, title, text) {
    const box = el('div', kind === 'warn' ? 'ui-note ui-note--warn' : 'ui-note');
    box.innerHTML = icon(kind === 'warn' ? 'warn' : 'info', 'sm', 'ui-note__icon');
    const body = el('div', 'ui-note__body');
    body.append(el('div', 'ui-note__title', title), el('div', 'ui-note__text', text));
    box.appendChild(body);
    return box;
}

/**
 * Окно «Вывести из работы?» — один сотрудник.
 *
 * ВЫВОД ИДЁТ ЧЕРЕЗ ТОТ ЖЕ МАРШРУТ, ЧТО И ПАЧКА, со списком из одного. Так у
 * одиночного и массового вывода одна дорога на сервере: те же колонки, тот же
 * отзыв ключа, то же открепление лидов, та же партия журнала. Второй путь
 * (PUT всей карточкой) существует и работает, но он требует гонять карточку
 * туда-обратно и однажды разойдётся с первым.
 */
export async function openEmployeeArchive({ scope, employee, storage, toast, onDone }) {
    const preview = await storage.fetchArchivePreview(employee.id);
    const state = { kind: 'dismissed' };

    const body = document.createDocumentFragment();
    body.appendChild(kindField(state));
    body.appendChild(el('p', '',
        'Карточка, документы и график останутся на месте. '
        + 'Сотрудник уйдёт из раздачи, из отчётов и из списков выбора.'));

    const list = el('div', 'arc-block');
    // Строка появляется только тогда, когда последствие есть: «добавочный
    // освободится» без добавочного — обещание того, чего не произойдёт.
    if (preview.extension && preview.extension.value) {
        list.appendChild(blockRow(preview.extension.value,
            'добавочный освободится — его смогут выдать другому'));
    }
    if (preview.tunnelKeyActive) {
        list.appendChild(blockRow(1, 'ключ туннеля будет отозван'));
    }
    if (preview.leads.detached > 0) {
        list.appendChild(blockRow(preview.leads.detached, leadsLine(preview.leads.queue)));
    }
    if (list.children.length > 0) body.appendChild(list);

    const sub = [fullName(employee), employee.pbxExtension ? `доб. ${employee.pbxExtension}` : '']
        .filter(Boolean).join(', ');

    openModal({
        title: 'Вывести из работы?',
        sub,
        body,
        scope,
        size: 'narrow',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: 'cancel' },
            {
                label: 'Вывести',
                icon: 'archive',
                value: 'ok',
                onClick: async () => {
                    await storage.bulkArchive([employee.id], state.kind);
                    toast(`Выведен из работы: ${fullName(employee)}`, 'success');
                    await onDone();
                }
            }
        ]
    });
}

/**
 * Окно «Вывести из работы?» — пачкой.
 *
 * Подпись называет число вместо имени, список последствий — сумма по выбранным
 * (ответ дизайн-сессии И115). Числа приходят ОДНИМ запросом: собранные из N
 * ответов, они посчитаны в N разных моментов, и сумма может не сойтись с тем,
 * что произойдёт после нажатия.
 */
export async function openEmployeeMassArchive({ scope, ids, storage, toast, onDone }) {
    const preview = await storage.fetchBulkArchivePreview(ids);
    const state = { kind: 'dismissed' };

    const body = document.createDocumentFragment();
    body.appendChild(kindField(state));
    body.appendChild(el('p', '',
        'Карточки, документы и графики останутся на месте. '
        + 'Сотрудники уйдут из раздачи, из отчётов и из списков выбора.'));

    const list = el('div', 'arc-block');
    if (preview.extensionsFreed > 0) {
        list.appendChild(blockRow(preview.extensionsFreed,
            'добавочных освободятся — их смогут выдать другим'));
    }
    if (preview.tunnelKeys > 0) {
        list.appendChild(blockRow(preview.tunnelKeys, 'ключей туннеля будут отозваны'));
    }
    if (preview.leads.detached > 0) {
        list.appendChild(blockRow(preview.leads.detached, leadsLine(preview.leads.queue)));
    }
    if (list.children.length > 0) body.appendChild(list);

    // Пропущенных называем сразу, а не после действия: человек выделил пятерых,
    // а выведут троих — он обязан узнать это ДО нажатия, а не из тоста.
    if (preview.skipped > 0) {
        body.appendChild(note('warn', `Уже выведены: ${preview.skipped}`,
            'Их состояние не изменится — действие к ним не применится.'));
    }

    openModal({
        title: 'Вывести из работы?',
        sub: `Выбрано сотрудников: ${ids.length}`,
        body,
        scope,
        size: 'narrow',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: 'cancel' },
            {
                label: 'Вывести',
                icon: 'archive',
                value: 'ok',
                onClick: async () => {
                    const res = await storage.bulkArchive(ids, state.kind);
                    const tail = res.skipped > 0 ? `, пропущено: ${res.skipped} — уже выведены` : '';
                    toast(`Выведено из работы сотрудников: ${res.archived}${tail}`, 'success');
                    await onDone();
                }
            }
        ]
    });
}

/**
 * Окно «Вернуть в работу?» — одно окно, два наполнения.
 *
 * ВОЗВРАТ БЕЗ ДОБАВОЧНОГО ЗАПРЕЩЁН (решение владельца 71), и причина не в
 * технике: сотрудник без добавочного системой предусмотрен, ключ туннеля ему
 * выдаётся. Причина в раздаче — она смотрит на status, on_line и line_type, а
 * добавочного в запросе нет вовсе. Вернувшийся без номера вышел бы на линию и
 * получил лида, которому не может позвонить.
 *
 * ТУПИКА НЕТ И БЕЗ ВЕТКИ «вернуть без номера»: подсказка называет ЗАНЯТЫЕ
 * номера. Свободные назвать нельзя — диапазона добавочных в базе нет, станция
 * своего списка не отдаёт, и выдумывать его экран не вправе (решение
 * владельца 77).
 */
export async function openEmployeeReturn({ scope, employee, storage, toast, onDone }) {
    const preview = await storage.fetchArchivePreview(employee.id);
    const held = preview.extension && preview.extension.heldBy;
    const previous = preview.extension ? preview.extension.value : '';

    const body = document.createDocumentFragment();

    if (held) {
        // Точки после имени НЕТ намеренно: фамилия с инициалами уже кончается
        // точкой («Волков П.»), и вторая дала бы «П.. Нужен другой».
        const when = held.since
            ? `Его выдали ${formatDate(held.since)} — ${held.fio}`
            : `Он у ${held.fio}`;
        body.appendChild(note('warn', `Прежний номер ${previous} занят`, `${when} Нужен другой.`));
    } else {
        body.appendChild(el('p', '',
            'Сотрудник вернётся в раздачу, в отчёты и в списки выбора.'));
    }

    const field = el('div', 'ui-field');
    const label = el('label', 'ui-field__label ui-field__label--required', 'Добавочный');
    label.setAttribute('for', 'empArcExtension');
    const input = el('input', 'ui-field__control');
    input.id = 'empArcExtension';
    input.type = 'text';
    // Прежний номер подставляется ТОЛЬКО если он свободен. Подставить занятый
    // значило бы предложить человеку заведомо отбиваемое значение.
    input.value = held ? '' : (previous || '');

    const taken = (preview.extensionsTaken || []).map((x) => x.extension).filter(Boolean);
    const hint = held || !previous
        ? (taken.length
            ? `Заняты: ${taken.join(', ')}. Свободен любой другой номер.`
            : 'Занятых номеров нет — свободен любой.')
        : `Прежний номер ${previous} свободен — подставлен. Можно заменить любым свободным.`;
    field.append(label, input, el('span', 'ui-field__hint', hint));
    body.appendChild(field);

    // ПРО КЛЮЧ ТУННЕЛЯ ГОВОРИТСЯ ОБЯЗАТЕЛЬНО. При выводе он отзывается, и
    // вернувшийся без нового ключа просто не войдёт. Молчание здесь стоило бы
    // дня разбирательств.
    body.appendChild(note('info', 'Ключ туннеля придётся выдать заново',
        'Прежний отозван при выводе из работы и работать не будет.'));

    const kindWord = employee.archiveKind === 'frozen' ? 'заморожен' : 'уволен';
    const when = employee.archiveKind === 'frozen' ? employee.frozenAt : employee.terminationDate;
    const sub = [fullName(employee), when ? `${kindWord} ${formatDate(when)}` : kindWord]
        .filter(Boolean).join(', ');

    const modal = openModal({
        title: 'Вернуть в работу?',
        sub,
        body,
        scope,
        size: 'narrow',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: 'cancel' },
            {
                label: 'Вернуть',
                value: 'ok',
                role: 'return',
                onClick: async () => {
                    const extension = input.value.trim();
                    if (!extension) return false;
                    const card = await storage.fetchEmployeeById(employee.id);
                    await storage.updateEmployee(employee.id,
                        { ...card, status: 'active', pbxExtension: extension });
                    toast(`Возвращён в работу: ${fullName(employee)}, доб. ${extension}`, 'success');
                    await onDone();
                }
            }
        ]
    });

    // Кнопка неактивна, пока поле пустое (паспорт: «кнопка неактивна при пустом
    // поле»). Считается по значению, а не по тому, трогали ли поле: с занятым
    // прежним номером оно пустое с самого начала.
    const btn = modal.el.querySelector('[data-role="return"]');
    const sync = () => { if (btn) btn.disabled = input.value.trim() === ''; };
    input.addEventListener('input', sync);
    sync();

    return modal;
}
