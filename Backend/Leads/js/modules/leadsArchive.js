// --- leadsArchive.js: окна архива лида (пункт Р7, часть 5Б) ----------------
//
// Отправка в архив поодиночке, отправка пачкой и возврат. Вынесены из
// leadsApp.js отдельным файлом по той же причине, что у сотрудников: тот и без
// них велик, а у окон своя разметка, свои тексты и свой разговор с сервером.
//
// АРХИВ — ЭТО ПОМЕТКА, А НЕ УДАЛЕНИЕ. Лид уходит из очереди, из раздачи и из
// подбора оператора, но остаётся: комментарии, история и связи с объектами на
// месте, вернуть его можно в любой момент.

import { openModal } from '/ui/modal.js';
import { icon } from '/ui/icons.js';
import { openDeleteBlocked, isDeleteBlocked } from '/deleteBlocked.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function note(kind, title, text) {
    const box = el('div', kind === 'warn' ? 'ui-note ui-note--warn' : 'ui-note');
    box.innerHTML = icon(kind === 'warn' ? 'warn' : 'info', 'sm', 'ui-note__icon');
    const body = el('div', 'ui-note__body');
    body.append(el('div', 'ui-note__title', title), el('div', 'ui-note__text', text));
    box.appendChild(body);
    return box;
}

function leadTitle(lead) {
    const name = [lead.lastName, lead.firstName].filter(Boolean).join(' ');
    return name || lead.phone || `Лид #${lead.id}`;
}

/**
 * Окно отказа, собранное для лида. Одно и то же на пять разделов — своё сюда
 * не заводится (ответ на И118).
 */
function showBlocked(scope, lead, blockers) {
    openDeleteBlocked({
        scope,
        sub: `Лид «${leadTitle(lead)}»`,
        lead: 'К лиду привязано то, что удалением потерялось бы навсегда:',
        tail: 'Отправьте его в архив — данные останутся на месте.',
        blockers
    });
}

/**
 * Окно «Отправить в архив?» — ДВА СОСТОЯНИЯ, и выбирается оно ДО открытия.
 *
 * КОГДА УДАЛЯТЬ НЕЛЬЗЯ, КНОПКИ НЕТ, А НЕ «ОНА НЕАКТИВНА» (паспорт Р7).
 * Неактивная кнопка обещает, что есть условие, при котором она оживёт; здесь
 * такого условия нет — работа с лидом уже началась и назад не отматывается.
 *
 * Сегодня помеха ровно одна — влитые дубли (часть 4). Подобранные объекты из
 * помех ушли (Р7-4): офферы обязательны при заведении лида, и по прежнему
 * чтению «Удалить насовсем» отказывало бы всегда. Звонки добавятся частью 7 —
 * состояние собрано целиком заранее, чтобы к нему не возвращаться.
 */
export function openLeadArchive({ scope, lead, storage, toast, onDone }) {
    const blocked = (lead.mergedCount || 0) > 0;

    const body = document.createDocumentFragment();
    body.appendChild(el('p', '',
        'Лид выйдет из раздачи, из отчётов и из подбора. Комментарии, история и '
        + 'связи с объектами останутся; вернуть его можно в любой момент.'));

    body.appendChild(blocked
        ? note('warn', 'Удалить насовсем уже нельзя',
            `В этого лида влиты дубли: ${lead.mergedCount}. Их история привязана к нему, `
            + 'и удаление унесло бы её. Архив — единственный путь.')
        : note('info', 'Это не удаление',
            'Если лида завели по ошибке и работать с ним никто не начинал — '
            + 'его можно удалить насовсем.'));

    const actions = [
        { label: 'Отмена', variant: 'ghost', value: 'cancel' },
        {
            label: 'В архив',
            icon: 'archive',
            value: 'archive',
            onClick: async () => {
                await storage.archiveLead(lead.id);
                toast(`Отправлено в архив: ${leadTitle(lead)}`, 'success');
                await onDone();
            }
        }
    ];

    if (!blocked) {
        // ЕДИНСТВЕННЫЙ КРАСНЫЙ НА ВЕСЬ ПУНКТ. Стоит СЛЕВА, отдельно от пары
        // «Отмена — В архив» (--spread): это не альтернатива архиву, а другой
        // разговор, и рука не должна промахиваться. Второго подтверждения у
        // него нет — окно уже назвало последствия и уже спросило.
        actions.unshift({
            label: 'Удалить насовсем',
            variant: 'danger',
            icon: 'trash',
            side: 'start',
            value: 'delete',
            onClick: async () => {
                try {
                    await storage.deleteLead(lead.id);
                } catch (err) {
                    // ЭКРАН НЕ ВПРАВЕ СЧИТАТЬ, ЧТО РАЗ КНОПКА ПОКАЗАНА — УДАЛЕНИЕ
                    // ПРОЙДЁТ (ответ И107). Между открытием окна и нажатием в
                    // лида могли влить дубль. Тогда это окно закрывается и
                    // открывается седьмое — общее окно помех; второго окна под
                    // этот случай не заводится.
                    if (isDeleteBlocked(err)) {
                        showBlocked(scope, lead, err.blockers);
                        await onDone();
                        return;
                    }
                    throw err;
                }
                toast('Лид удалён', 'success');
                await onDone();
            }
        });
    }

    return openModal({
        title: 'Отправить в архив?',
        sub: `Лид «${leadTitle(lead)}»`,
        body,
        scope,
        size: 'narrow',
        spread: !blocked,
        actions
    });
}

/**
 * Возврат из архива — ТРИ ИСХОДА, а не один.
 *
 * Паспорт редакции 2 обещал одной строкой «Лид вернётся в очередь на раздачу».
 * Это неправда для лида с окончательным статусом: статусы окончательны
 * (решение владельца 75), и возврат сам по себе очереди не обещает. Сервер
 * отдаёт признак placement именно затем, чтобы окно не обещало лишнего, а
 * третью строку писать ОБЯЗАТЕЛЬНО: молчаливое «вернётся в очередь» вскроется
 * через день, когда лид так и не придёт оператору.
 *
 * Спросить исход ДО действия неоткуда: условие очереди проверяет, что лид не в
 * архиве, и на архивном ответ был бы всегда «не попадёт». Поэтому окно
 * подтверждает возврат, а исход называет тостом — это единственное место
 * пункта, где число приходит после действия, и приходит оно потому, что до
 * действия его не существует.
 */
const PLACEMENT_TEXT = {
    now: 'Лид вернётся в очередь на раздачу',
    later: 'Лид вернётся, когда наступит время перезвона',
    none: 'Лид вернётся в список, но в раздачу не попадёт — статус окончательный'
};

export function openLeadReturn({ scope, lead, storage, toast, onDone }) {
    const body = document.createDocumentFragment();
    body.appendChild(el('p', '',
        'Лид вернётся в список и снова станет доступен для работы. '
        + 'Статус останется прежним — его не меняет ни архив, ни возврат.'));

    return openModal({
        title: 'Вернуть из архива?',
        sub: `Лид «${leadTitle(lead)}»`,
        body,
        scope,
        size: 'narrow',
        actions: [
            { label: 'Отмена', variant: 'ghost', value: 'cancel' },
            {
                label: 'Вернуть из архива',
                value: 'ok',
                onClick: async () => {
                    const res = await storage.unarchiveLead(lead.id);
                    toast(PLACEMENT_TEXT[res.placement] || PLACEMENT_TEXT.none, 'success');
                    await onDone();
                }
            }
        ]
    });
}
