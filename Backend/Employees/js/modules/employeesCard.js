// --- employeesCard.js: окно сотрудника (два шага, заполнение, сохранение) ---
//
// Переименован из modal.js и переведён на фабрику: раньше сорок с лишним узлов
// брались через document на верхнем уровне модуля — один раз, при импорте. В
// оболочке модуль импортируется один раз, а монтируется много: ссылки
// указывали бы на поля первой панели даже после её закрытия.
//
// Подтверждение «закрыть без сохранения» больше не своё окно, а ctx.confirm из
// слоя. Удаление сотрудника подтверждает таблица, тоже слоем.
//
// САМО ОКНО ТОЖЕ СОБИРАЕТ СЛОЙ (К110, К111). Раньше карточка была объявлена
// разметкой и показывалась снятием hidden: вид у неё был правильный, а
// поведения окна не было — Tab на первом же шаге уводил в панель под
// затемнением, фокус при открытии оставался на кнопке-открывашке, и после
// закрытия уходил в BODY.
//
// ТРИ ДВЕРИ — ОДНА ПРОВЕРКА (К112). Esc, щелчок по затемнению и крестик ведут
// через confirmClose слоя, «Отмена» — через свой onClick, и все четыре
// спрашивают об одном и том же. До этого Esc обрабатывался общим слушателем
// раздела и ставил hidden напрямую, мимо проверки изменений: окно с набранной
// фамилией закрывалось молча — именно той дверью, которую нажимают не глядя.

import { openModal } from '/ui/modal.js';
import { createHistoryPane } from '/history/historyTable.js';
import { iconNode } from '/ui/icons.js';
import { DOCUMENT_TYPE_MAP } from './employeesStorage.js';
import { validatePhone, validateEmail, formatPhone } from './employeesValidation.js';
import { parseShiftInput, parseWorkDaysInput, formatShiftInput } from './employeesScheduleTime.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Ключ поля -> id в разметке. Раньше это был список ссылок на узлы; теперь
// список имён, а узел берётся в границах своей панели.
const FIELDS = [
    'lastName', 'firstName', 'middleName', 'email', 'phone', 'whatsapp', 'telegram',
    'position', 'department', 'hireDate', 'status', 'terminationDate', 'lineType',
    'workSchedule', 'pbxExtension', 'password', 'country', 'registration', 'passportSeries',
    'passportNumber', 'issuedBy', 'issueDate', 'inn', 'bank', 'account'
];
// Пароль АТС в общий список не входит: его значение с сервера не приходит
// вовсе, приходит только признак «задан». Всё про него — ниже, отдельно.
// Два поля не совпадают с ключом данных: список руководителей и время смены,
// которое в базе лежит двумя колонками.
const MANAGER_FIELD = 'managerId';
const SHIFT_FIELD = 'shiftTime';

const DOC_FIELDS = ['passportFront', 'passportBack', 'patent', 'contract', 'additionalAgreement'];

// Подписи блока «График работы» — под полем три состояния: обычное,
// предупреждение о пустом времени и ошибка формата.
const WORK_SCHEDULE_HINT = 'Рабочих дней подряд и выходных подряд: 5/2, 3/3, 2/2, 4/2. Справочная запись: выходные при заполнении месяца отмечает администратор, из этого поля они не считаются.';
const SHIFT_TIME_HINT = 'С минутами, 24 часа. Смена через полночь — 22:00-06:00.';
const SHIFT_TIME_EMPTY_HINT = 'Без времени смены месяц по этому сотруднику заполнить нельзя, а в меню дня пункт «Смена» неактивен. Поле «Дни» на заполнение не влияет — пустым оно ничего не ломает.';

// Пароль АТС. Подсказка объясняет не «что ввести», а чем грозит утечка: формат
// пароля задаёт оператор связи, и проверять его нам нечем.
const PBX_PASSWORD_HINT = 'Кто знает — звонит за счёт компании.';
// Восемь точек — ТЕКСТ приглашения, а не замаскированное значение: значения в
// поле нет, пока человек не нажал «показать» (паспорт Р4, «скрыт навсегда»).
const PBX_PASSWORD_MASK = '••••••••';
const PBX_PASSWORD_EMPTY = 'Не задан';

function fieldId(key) {
    return '#emp' + key.charAt(0).toUpperCase() + key.slice(1);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, confirm, isAlive, isAbort, onSaved }
 */
export function createCard(root, deps) {
    const { storage, toast, confirm, confirmDanger, isAlive, isAbort, onSaved, api } = deps;

    const $ = (sel) => root.querySelector(sel);
    const tpl = $('[data-role="employee-tpl"]');

    // Открытое окно слоя или null. Кнопки подвала строит слой, поэтому они
    // ищутся по роли КАЖДЫЙ РАЗ, а не запоминаются при монтировании: до
    // открытия окна их не существует.
    let modal = null;
    const saveBtn = () => $('[data-role="employee-save"]');

    let editingId = null;
    let currentStep = 1;
    let originalFormData = {};
    let saving = false;

    // ПАРОЛЬ АТС — ТРИ ПРИЗНАКА ВМЕСТО ЗНАЧЕНИЯ.
    //   pbxPasswordSet   — задан ли пароль на сервере (пришло с карточкой).
    //   pbxPasswordDirty — трогал ли его человек. Только при true ключ уходит
    //                      в запрос: не отправлен — не меняется.
    //   pbxPasswordShown — открыт ли он сейчас на экране.
    // Значение живёт только в самом поле и только пока окно открыто.
    let pbxPasswordSet = false;
    let pbxPasswordDirty = false;
    let pbxPasswordShown = false;

    const pbxInput = () => $('#empPbxPassword');
    const pbxButton = () => $('[data-role="pbx-reveal"]');

    /** Кнопка мертва, когда показывать нечего: пусто и на сервере ничего нет. */
    function syncPbxButton() {
        const button = pbxButton();
        if (!button) return;
        button.disabled = !pbxPasswordSet && !pbxInput().value;
    }

    /** Открыть/закрыть показ. Значок и подпись меняются парой с типом поля. */
    function setPbxShown(shown) {
        const input = pbxInput();
        const button = pbxButton();
        if (!input || !button) return;
        pbxPasswordShown = shown;
        input.type = shown ? 'text' : 'password';
        button.setAttribute('aria-pressed', String(shown));
        button.setAttribute('aria-label', shown ? 'Скрыть пароль' : 'Показать пароль');
        const use = button.querySelector('use');
        if (use) use.setAttribute('href', shown ? '#ui-ic-eye-off' : '#ui-ic-eye');
    }

    /**
     * Приводит поле к состоянию «пароль задан / не задан».
     * Точки в приглашении — это ТЕКСТ: значения в поле нет, пока не нажали
     * «показать». Открытым поле не остаётся ни между вкладками, ни между
     * сеансами — карточка каждый раз собирается заново.
     */
    function resetPbxPasswordField(isSet) {
        pbxPasswordSet = Boolean(isSet);
        pbxPasswordDirty = false;
        const input = pbxInput();
        if (!input) return;
        input.value = '';
        input.placeholder = pbxPasswordSet ? PBX_PASSWORD_MASK : PBX_PASSWORD_EMPTY;
        setPbxShown(false);
        syncPbxButton();
        const hint = $('[data-role="pbx-password-hint"]');
        if (hint) hint.textContent = PBX_PASSWORD_HINT;
    }

    function docInput(key) {
        return $(`[data-doc="${key}"]`);
    }

    // ------------------------------------------------------- ключ туннеля
    //
    // КЛЮЧ — ЭТО ДЕЙСТВИЕ, А НЕ ПОЛЕ. Значения, которое вводят, у него нет:
    // строка собрана из пилюль и кнопки, метка — span. Поэтому здесь нет ни
    // разбора значения, ни отправки его на сервер: карточка только показывает
    // состояние и нажимает кнопку.
    //
    // СОСТОЯНИЕ ЖИВЁТ В ОТВЕТЕ СЕРВЕРА, а не в форме: выдача идёт отдельной
    // точкой и к сохранению карточки отношения не имеет. «Сохранить» ключа не
    // выдаёт и не отзывает.
    //
    // СОБЫТИЙ ДВА, И МЕЖДУ НИМИ ЧАСЫ. Сначала руководитель выдаёт ссылку —
    // ключа ещё нет, потому что пара рождается в момент, когда сотрудник
    // ссылку откроет. Потом ключ появляется, и только тогда его есть чем
    // впустить на сервере. Карточка про эти два состояния говорит разное
    // (паспорт Р1Б редакции 3, состояния 4 и 5), и вторая строка — открытый
    // ключ — приезжает вместе со вторым из них.
    let tunnel = null;      // данные ключа с сервера
    let tunnelBusy = false; // идёт выдача

    const TUNNEL_HINT_NEW = 'Сначала сохраните карточку: ключ привязывается к сотруднику, а записи ещё нет.';
    const TUNNEL_HINT_NONE = 'Настройка туннеля для звонков из-за рубежа. Нужна не всем: только тем, кто работает из другой страны.';
    const TUNNEL_HINT_ARCHIVED = 'Ключ отозван при отправке в архив. Вернёте сотрудника — выдадите заново.';

    // «Не указан», а не прочерк, и не случайно: тем же словом об отсутствующем
    // авторе говорит экран «История изменений» (паспорт Р5). Прочерк в середине
    // фразы читается как обрыв, а два экрана про одно и то же обязаны говорить
    // одинаково. Сегодня это единственный возможный случай: входа в проекте
    // нет, автора не существует, и колонка `tunnel_issued_by` ждёт часть 3.
    const TUNNEL_AUTHOR_UNKNOWN = 'не указан';

    function tunnelHint(byName, tail) {
        return `Настройка туннеля для звонков из-за рубежа. Выдал: ${byName || TUNNEL_AUTHOR_UNKNOWN} · ${tail}`;
    }

    /** Пилюля показывается только когда ей есть что сказать. */
    function setPill(role, text, kind) {
        const pill = $(`[data-role="${role}"]`);
        if (!pill) return;
        pill.hidden = !text;
        pill.textContent = text || '';
        pill.className = `ui-pill ui-pill--${kind || 'mute'}`;
    }

    /**
     * Строка открытого ключа. Есть ровно в одном состоянии — «ключ получен».
     * До открытия ссылки строки НЕТ ВОВСЕ, а не пустое поле и не прочерк:
     * показывать место под значение, которого физически не существует, значит
     * обещать его. В архиве её тоже нет — впускать нечего.
     */
    function renderTunnelKeyRow(show, value) {
        const field = $('[data-role="tunnel-key-field"]');
        const input = $('[data-role="tunnel-key-value"]');
        if (!field || !input) return;
        field.hidden = !show;
        input.value = show ? (value || '') : '';
    }

    /**
     * Шесть состояний строки (паспорт Р1Б редакции 3). Считаются из ОДНОГО
     * источника — ответа сервера, — поэтому и живут в одном месте, а не
     * разбегаются по обработчикам.
     */
    function renderTunnelRow() {
        const field = $('[data-role="tunnel-field"]');
        const button = $('[data-role="tunnel-issue"]');
        const label = $('[data-role="tunnel-issue-label"]');
        const hint = $('[data-role="tunnel-hint"]');
        if (!field || !button) return;

        const isNew = editingId === null;
        const linkIssued = Boolean(tunnel && tunnel.tunnelKeyIssued);
        const keyBorn = linkIssued && Boolean(tunnel && tunnel.tunnelPublicKey);
        const wasRevoked = Boolean(tunnel && tunnel.tunnelRevokedAt);
        // Архив — состояние СОХРАНЁННОЕ. Выбранный, но не сохранённый статус
        // пилюлю не меняет: «Отозван» до отзыва было бы неправдой. Но кнопку
        // он гасит — выдавать ключ тому, кого сейчас отправят в архив, незачем.
        const archived = Boolean(tunnel && tunnel.status === 'inactive');
        const goingToArchive = $('#empStatus') && $('#empStatus').value === 'inactive';

        field.classList.toggle('ui-field--disabled', archived);
        label.textContent = tunnelBusy ? 'Выдаём…' : (linkIssued ? 'Выдать заново' : 'Выдать ключ');

        if (isNew) {
            setPill('tunnel-pill', '', 'mute');
            setPill('tunnel-address', '', 'mute');
            renderTunnelKeyRow(false);
            button.disabled = true;
            hint.textContent = TUNNEL_HINT_NEW;
            return;
        }
        if (archived) {
            setPill('tunnel-pill', wasRevoked ? `Отозван ${tunnel.tunnelRevokedAtLabel}` : 'Не выдан', 'mute');
            setPill('tunnel-address', '', 'mute');
            renderTunnelKeyRow(false);
            label.textContent = 'Выдать ключ';
            button.disabled = true;
            hint.textContent = wasRevoked ? TUNNEL_HINT_ARCHIVED : TUNNEL_HINT_NONE;
            return;
        }
        if (keyBorn) {
            setPill('tunnel-pill', `Ключ получен ${tunnel.tunnelKeyAtLabel}`, 'ok');
            setPill('tunnel-address', tunnel.tunnelAddress, 'mute');
            renderTunnelKeyRow(true, tunnel.tunnelPublicKey);
            button.disabled = tunnelBusy || goingToArchive;
            hint.textContent = tunnelHint(tunnel.tunnelIssuedByName,
                'заработает после того, как ключ впустят на сервере.');
            return;
        }
        if (linkIssued) {
            setPill('tunnel-pill', `Ссылка выдана ${tunnel.tunnelIssuedAtLabel}`, 'mute');
            setPill('tunnel-address', tunnel.tunnelAddress, 'mute');
            renderTunnelKeyRow(false);
            button.disabled = tunnelBusy || goingToArchive;
            hint.textContent = tunnelHint(tunnel.tunnelIssuedByName,
                'ключ появится, когда сотрудник откроет ссылку.');
            return;
        }
        setPill('tunnel-pill', 'Не выдан', 'mute');
        setPill('tunnel-address', '', 'mute');
        renderTunnelKeyRow(false);
        button.disabled = tunnelBusy || goingToArchive;
        hint.textContent = TUNNEL_HINT_NONE;
    }

    function resetTunnel(employee) {
        tunnel = employee ? {
            status: employee.status,
            tunnelKeyIssued: employee.tunnelKeyIssued,
            tunnelPublicKey: employee.tunnelPublicKey,
            tunnelAddress: employee.tunnelAddress,
            tunnelIssuedAtLabel: employee.tunnelIssuedAtLabel,
            tunnelKeyAtLabel: employee.tunnelKeyAtLabel,
            tunnelIssuedByName: employee.tunnelIssuedByName,
            tunnelRevokedAt: employee.tunnelRevokedAt,
            tunnelRevokedAtLabel: employee.tunnelRevokedAtLabel
        } : null;
        tunnelBusy = false;
        const block = $('[data-role="tunnel-link-block"]');
        if (block) { block.hidden = true; block.replaceChildren(); }
        renderTunnelRow();
    }

    /** Копирование машинного текста — приём один на ссылку и на ключ. */
    async function copyMachineText(input, okMessage, failMessage) {
        try {
            await navigator.clipboard.writeText(input.value);
            toast(okMessage, 'success');
        } catch (e) {
            // Буфер обмена недоступен без защищённого соединения и без
            // разрешения. Молчать нельзя: человек нажал и ждёт результата.
            input.select();
            toast(failMessage, 'error');
        }
    }

    /**
     * Блок со ссылкой. Показывается ОДИН РАЗ, на месте строки, и живёт, пока
     * открыто окно: закрыли — не вернётся. Кнопки «показать ещё раз» здесь нет
     * и не будет — именно она возвращает схему в «настройка лежит на странице».
     *
     * Предупреждение стоит НАД ссылкой: человек, увидевший ссылку, тянется её
     * копировать и уходит, а текст под ней прочитает уже после закрытия окна.
     */
    function showTunnelLink(issued) {
        const block = $('[data-role="tunnel-link-block"]');
        if (!block) return;
        const link = `${location.origin}${issued.linkPath}`;
        block.replaceChildren();
        block.hidden = false;

        const note = document.createElement('div');
        note.className = 'ui-note ui-note--warn';
        note.appendChild(iconNode('warn', 'sm', 'ui-note__icon'));
        const body = document.createElement('div');
        body.className = 'ui-note__body';
        const title = document.createElement('div');
        title.className = 'ui-note__title';
        title.textContent = 'Ссылка показывается один раз';
        const text = document.createElement('div');
        text.className = 'ui-note__text';
        text.textContent = `Отдайте её сотруднику сейчас. Она сгорит при первом открытии, а если не откроют — ${issued.expiresLabel} по Москве. Показать её повторно нельзя: потеряется — выдайте ключ заново.`;
        body.append(title, text);
        note.appendChild(body);

        // Отступ строки задан в css раздела, а не атрибутом разметки: значение,
        // живущее в style=, при следующей правке раскладки никто не найдёт (К174).
        const row = document.createElement('div');
        row.className = 'ui-field__row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ui-field__control';
        input.readOnly = true;
        input.value = link;
        input.setAttribute('aria-label', 'Ссылка на настройку туннеля');
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'ui-btn ui-btn--secondary';
        copy.appendChild(iconNode('copy', 'sm'));
        // Подпись кнопки после нажатия НЕ меняется: подменённая подпись
        // читается как смена смысла кнопки. О результате говорит тост.
        copy.append('Скопировать');
        copy.addEventListener('click', () => copyMachineText(input, 'Ссылка скопирована',
            'Браузер не дал доступ к буферу обмена — ссылка выделена, скопируйте её сами'));
        row.append(input, copy);

        const hint = document.createElement('span');
        hint.className = 'ui-field__hint';
        hint.textContent = `По ссылке сотрудник скачает файл ${issued.fileName}. Ключ выдан на ${issued.address} и заработает после того, как его впустят на сервере.`;

        block.append(note, row, hint);
        input.focus();
        input.select();
    }

    /** Отказ выдачи — плашкой НА МЕСТЕ блока, а не тостом: тост исчезнет, а
     *  разбираться надо здесь (паспорт Р1Б). */
    function showTunnelError(message) {
        const block = $('[data-role="tunnel-link-block"]');
        if (!block) return;
        block.replaceChildren();
        block.hidden = false;
        const note = document.createElement('div');
        note.className = 'ui-note ui-note--danger';
        note.appendChild(iconNode('warn', 'sm', 'ui-note__icon'));
        const body = document.createElement('div');
        body.className = 'ui-note__body';
        const title = document.createElement('div');
        title.className = 'ui-note__title';
        // Заголовок один на все причины отказа, текст приходит с сервера —
        // оба дословно из ответа куратора (zakaz_maketov.md, ответ 5 по Р1Б).
        title.textContent = 'Не удалось выдать ключ';
        const text = document.createElement('div');
        text.className = 'ui-note__text';
        text.textContent = message;
        body.append(title, text);
        note.appendChild(body);
        block.appendChild(note);
    }

    async function issueTunnelKey() {
        if (tunnelBusy || editingId === null) return;

        // ПЕРЕВЫПУСК СПРАШИВАЕТ, И СПРАШИВАЕТ ПРО ПОСЛЕДСТВИЕ. Прежний ключ
        // перестаёт работать сразу: оператор с ним теряет связь и не поймёт
        // почему. Окно на весь экран, кнопка названа глаголом с объектом —
        // «Да» в списке недавних действий ничего не значит.
        if (tunnel && tunnel.tunnelKeyIssued) {
            const extension = $('#empPbxExtension').value.trim();
            const who = [`${$('#empLastName').value.trim()} ${$('#empFirstName').value.trim()}`.trim(),
                extension ? `доб. ${extension}` : null].filter(Boolean).join(', ');
            // Тело — ДВА абзаца, а не один (К173): последствие и оговорка про
            // новую ссылку — разные мысли, и слитые в один абзац они читаются
            // как одна длинная. confirm() отдаёт message в openModal, а тот
            // принимает узел, поэтому собираем фрагмент.
            const message = document.createDocumentFragment();
            const first = document.createElement('p');
            first.textContent = 'Прежний ключ перестанет работать сразу. Пока сотрудник не поставит новый, звонить из-за границы он не сможет.';
            const second = document.createElement('p');
            second.textContent = 'Новая ссылка будет показана один раз и сгорит при первом открытии.';
            message.append(first, second);

            const ok = await confirmDanger({
                title: 'Выдать новый ключ?',
                // Подпись называет, КОМУ выдаём. Вопрос в заголовке,
                // последствие в тексте, объект в подписи — иначе окно
                // подтверждения читается как «вы уверены?».
                sub: who,
                message,
                confirmLabel: 'Выдать новый',
                cancelLabel: 'Отмена'
            });
            if (!ok || !isAlive() || !modal) return;
        }

        tunnelBusy = true;
        renderTunnelRow();
        let issued;
        try {
            issued = await storage.issueTunnelKey(editingId);
            if (!isAlive() || !modal) return;
        } catch (err) {
            if (isAbort(err)) return;
            showTunnelError(err.message);
            return;
        } finally {
            tunnelBusy = false;
            if (isAlive() && modal) renderTunnelRow();
        }

        // Ссылка отдана — но ключа ещё нет и не будет, пока сотрудник её не
        // откроет. Прежний открытый ключ при перевыпуске обнулён на сервере,
        // и карточка обязана показать то же самое.
        tunnel = {
            ...(tunnel || {}),
            status: 'active',
            tunnelKeyIssued: true,
            tunnelPublicKey: null,
            tunnelKeyAtLabel: null,
            tunnelAddress: issued.address,
            tunnelIssuedAtLabel: issued.issuedAtLabel,
            tunnelRevokedAt: null,
            tunnelRevokedAtLabel: null
        };
        renderTunnelRow();
        showTunnelLink(issued);
    }


    // ------------------------------------------------------------ форма

    async function populateManagerSelect(excludeId) {
        const select = $('#empManager');
        select.innerHTML = '<option value="">Без руководителя</option>';
        let managers = [];
        try {
            managers = await storage.fetchManagerList(excludeId);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }
        managers.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = String(m.id);
            opt.textContent = m.fullName;
            select.appendChild(opt);
        });
    }

    function fillForm(emp) {
        FIELDS.forEach((key) => { $(fieldId(key)).value = emp[key] || ''; });
        $('#empManager').value = emp[MANAGER_FIELD] || '';
        $('#empShiftTime').value = formatShiftInput(emp.shiftStart, emp.shiftEnd) || '';
        resetPbxPasswordField(emp.pbxPasswordSet);
        resetTunnel(emp);
        DOC_FIELDS.forEach((key) => {
            const input = docInput(key);
            const area = input.closest('.file-upload-area');
            const nameSpan = area.querySelector('.file-name');
            const icon = area.querySelector('.file-status-icon');
            const fileName = (emp[key] && emp[key].name) || '';
            nameSpan.textContent = fileName;
            icon.hidden = !fileName;
        });
    }

    function clearForm() {
        FIELDS.forEach((key) => { $(fieldId(key)).value = ''; });
        $('#empManager').value = '';
        $('#empShiftTime').value = '';
        resetPbxPasswordField(false);
        resetTunnel(null);
        $('#empStatus').value = 'active';
        $('#empCountry').value = 'Российская Федерация';
    }

    function currentFormData() {
        const data = {};
        FIELDS.forEach((key) => { data[key] = $(fieldId(key)).value; });
        data[MANAGER_FIELD] = $('#empManager').value;
        data[SHIFT_FIELD] = $('#empShiftTime').value;
        // У пароля АТС сравнивается НЕ значение, а факт правки. Иначе показ
        // пароля кнопкой (значение подставляется программно) выглядел бы как
        // изменение, и закрытие окна спрашивало бы про несохранённое там, где
        // человек ничего не менял. Очистка поля, наоборот, правка и есть.
        data.pbxPasswordTouched = pbxPasswordDirty ? '1' : '';
        DOC_FIELDS.forEach((key) => {
            const input = docInput(key);
            data[key] = input.files.length ? input.files[0].name : '';
        });
        return data;
    }

    function captureOriginalData() {
        originalFormData = currentFormData();
    }

    function goToStep(step) {
        if (!modal) return;
        currentStep = step;
        $('[data-role="step-1-fields"]').hidden = step !== 1;
        $('[data-role="step-2-fields"]').hidden = step !== 2;
        // Подпись под заголовком строит слой (параметр sub), своей роли у неё
        // больше нет — берётся классом слоя из коробки открытого окна.
        const stepNote = modal.box.querySelector('.ui-modal__sub');
        if (stepNote) stepNote.textContent = `Шаг ${step} из 2`;
        $('[data-role="prev-step"]').hidden = step !== 2;
        $('[data-role="next-step"]').hidden = step !== 1;
        saveBtn().hidden = step !== 2;
    }

    // ------------------------------------------------------------ ошибка поля

    /**
     * Ошибка поля живёт ПОД ПОЛЕМ, а не только в тосте (К113). Тост говорил
     * «Заполните обязательные поля: Фамилия, Имя, Email, Телефон» и исчезал —
     * какие из семнадцати полей виноваты, человек искал глазами.
     *
     * Механизм — слоя (`ui-field--error` + `.ui-field__error`), тот же, что в
     * «Источниках»: рамка и подложка красным, подсказка поля уступает место
     * тексту ошибки. Своего раздел не заводит.
     */
    function markFieldError(sel, message) {
        const control = $(sel);
        const field = control && control.closest('.ui-field');
        if (!field) return;
        field.classList.add('ui-field--error');
        let note = field.querySelector('.ui-field__error');
        if (!note) {
            note = document.createElement('span');
            note.className = 'ui-field__error';
            field.appendChild(note);
        }
        note.textContent = message;
        // К170: красная рамка — признак для глаза, а озвучке нужен атрибут.
        // Подпись получает id и привязывается к полю, иначе экранный диктор
        // прочитает метку и умолчит о причине. id от id поля: полей в окне
        // двадцать девять, и общий id столкнул бы их между собой.
        if (control.id) {
            note.id = `${control.id}Error`;
            control.setAttribute('aria-describedby', note.id);
        }
        control.setAttribute('aria-invalid', 'true');
    }

    /** Исправленное поле не должно оставаться красным. */
    function clearFieldErrors() {
        if (!modal) return;
        modal.box.querySelectorAll('.ui-field--error').forEach((field) => {
            field.classList.remove('ui-field--error');
            // Атрибуты снимаются вместе с классом: поле, которое больше не
            // ошибочно, не должно оставаться помеченным для озвучки.
            const control = field.querySelector('.ui-field__control');
            if (control) {
                control.removeAttribute('aria-invalid');
                control.removeAttribute('aria-describedby');
            }
        });
    }

    // ------------------------------------------------------------ «График работы»

    function setScheduleFieldState(fieldRole, { error = false, warn = false, text }) {
        const group = $(`[data-role="${fieldRole}"]`);
        if (!group) return;
        group.classList.toggle('bad', error);
        const hint = group.querySelector('.field-hint');
        if (!hint) return;
        hint.classList.toggle('warn', warn);
        hint.textContent = text;
    }

    // Проверяет и НОРМАЛИЗУЕТ значение. Нормализация видна сразу: если ввод
    // остаётся как набрали, а в таблице появляется другое, человек решит, что
    // система поправила его молча и неизвестно как.
    function validateWorkDaysField() {
        const input = $('#empWorkSchedule');
        const result = parseWorkDaysInput(input.value);
        if (result.error) {
            setScheduleFieldState('work-days-field', { error: true, text: result.error });
            return null;
        }
        input.value = result.value || '';
        setScheduleFieldState('work-days-field', { text: WORK_SCHEDULE_HINT });
        return result;
    }

    function validateShiftTimeField() {
        const input = $('#empShiftTime');
        const result = parseShiftInput(input.value);
        if (result.error) {
            setScheduleFieldState('shift-time-field', { error: true, text: result.error });
            return null;
        }
        input.value = formatShiftInput(result.start, result.end);
        setScheduleFieldState('shift-time-field', {
            warn: !result.start,
            text: result.start ? SHIFT_TIME_HINT : SHIFT_TIME_EMPTY_HINT
        });
        return result;
    }

    // Ошибка от прошлого сотрудника не должна висеть на новом.
    function resetScheduleFieldHints() {
        const hasTime = Boolean($('#empShiftTime').value.trim());
        setScheduleFieldState('work-days-field', { text: WORK_SCHEDULE_HINT });
        setScheduleFieldState('shift-time-field', {
            warn: !hasTime,
            text: hasTime ? SHIFT_TIME_HINT : SHIFT_TIME_EMPTY_HINT
        });
    }

    // ------------------------------------------------------------ открытие/закрытие

    /** Набрано ли что-то, чего ещё нет на сервере. */
    function isDirty() {
        if (!modal) return false;
        const data = currentFormData();
        return Object.keys(originalFormData).some((key) => originalFormData[key] !== data[key]);
    }

    /**
     * Вопрос перед уходом — общий для всех четырёх дверей (К112).
     * Вопрос стоит в ЗАГОЛОВКЕ, последствие — в тексте (К92).
     */
    async function confirmDiscard() {
        if (!isDirty()) return true;
        const ok = await confirm({
            title: 'Закрыть без сохранения?',
            message: 'Введённые данные сотрудника не сохранятся.',
            confirmLabel: 'Закрыть без сохранения'
        });
        return Boolean(ok) && isAlive();
    }

    async function open(title, employee = null) {
        if (modal) return;

        const body = document.createElement('div');
        body.appendChild(tpl.content.cloneNode(true));

        // ОКНО С ШАГАМИ ПОЛУЧАЕТ ПОЛОСУ ВКЛАДОК, а шаги живут внутри первой.
        //
        // Историю НЕЛЬЗЯ ставить третьим шагом: шаг — часть заполнения, и
        // человек, идущий по шагам, наткнулся бы на чтение вместо ввода.
        //
        // Полоса уходит в слот `toolbar` слоя — тот же, что у карточки лида:
        // она остаётся на месте, пока тело едет под ней. Своего способа для
        // этого раздел не заводит (ответ куратора И212).
        const tabsNode = buildTabs();
        const paneNode = buildHistoryPane();
        body.appendChild(paneNode);
        // РАЗМЕТКА ОКНА КЛОНИРУЕТСЯ НА КАЖДОЕ ОТКРЫТИЕ, значит и панель журнала
        // заводится заново: прежняя держала бы узлы закрытого окна.
        historyPane = createHistoryPane(paneNode, {
            api,
            recordTable: 'employees',
            recordId: () => editingId,
            noteText: 'Показаны изменения самой записи сотрудника.',
            onLeave: async () => {
                if (!(await confirmDiscard())) return false;
                await close(true);
                return true;
            },
            isAlive,
            isAbort
        });

        modal = openModal({
            toolbar: tabsNode,
            title: employee
                ? `${title} (ID: ${String(employee.id).padStart(4, '0')})`
                : title,
            sub: 'Шаг 1 из 2',
            body,
            scope: root,
            size: 'wide',


            confirmClose: confirmDiscard,
            actions: [
                {
                    label: 'Отмена',
                    variant: 'ghost',
                    role: 'employee-cancel',
                    // Возврат false оставляет окно открытым: человек передумал уходить.
                    onClick: () => confirmDiscard()
                },
                {
                    label: 'Назад',
                    variant: 'secondary',
                    role: 'prev-step',
                    onClick: () => { goToStep(1); return false; }
                },
                {
                    label: 'Далее',
                    role: 'next-step',
                    onClick: () => { if (checkStep1()) goToStep(2); return false; }
                },
                {
                    label: 'Сохранить',
                    role: 'employee-save',
                    onClick: () => handleSubmit()
                }
            ]
        });
        modal.result.then(() => { modal = null; editingId = null; historyPane = null; });

        bindFormEvents(body);
        // У НОВОЙ ЗАПИСИ ВКЛАДКИ «ИСТОРИЯ» НЕТ ВОВСЕ: читать нечего, а
        // неактивная вкладка была бы обещанием, которого никто не давал.
        tabsNode.hidden = !employee;
        switchCardTab('card');
        goToStep(1);

        // Выбор файла с прошлого открытия сюда не переносится: поля клонируются
        // из шаблона, а не переиспользуются.
        await populateManagerSelect(employee ? employee.id : null);
        if (!isAlive() || !modal) return;

        if (employee) {
            // editingId ставится ДО заполнения формы, а не после. Строка
            // «Ключ туннеля» рисуется во время заполнения и по нему отличает
            // сохранённого сотрудника от нового: при прежнем порядке
            // открытая карточка показывала состояние «сначала сохраните
            // карточку» — то есть у существующего человека кнопка выдачи была
            // мертва (найдено проверкой интерфейса).
            editingId = employee.id;
            fillForm(employee);
            saveBtn().textContent = 'Сохранить изменения';
        } else {
            clearForm();
            saveBtn().textContent = 'Добавить сотрудника';
            editingId = null;
        }

        resetScheduleFieldHints();
        captureOriginalData();

        // Фокус — в ПЕРВОЕ ПОЛЕ, а не на крестик (К110). Слой по умолчанию
        // берёт первый фокусируемый элемент коробки, а это кнопка закрытия:
        // она стоит выше по разметке.
        const first = $('#empLastName');
        if (first) first.focus();
    }

    // ------------------------------------------------------------ вкладки окна

    // Какая вкладка открыта и загружена ли история. Обе живут в экземпляре
    // модуля, а не в разметке: разметка окна клонируется из шаблона заново на
    // каждое открытие.
    let cardTab = 'card';
    // Панель журнала живого окна. Загрузку, порядок, подвал и пустоту ведёт
    // общий модуль — здесь остаётся только сказать ему «покажись».
    let historyPane = null;

    function buildTabs() {
        const box = document.createElement('div');
        box.className = 'ui-tabs';
        box.setAttribute('role', 'tablist');
        box.dataset.role = 'employee-tabs';

        const make = (key, label) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ui-tabs__tab' + (key === 'card' ? ' ui-tabs__tab--active' : '');
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', String(key === 'card'));
            b.dataset.role = `employee-tab-${key}`;
            b.textContent = label;
            b.addEventListener('click', () => switchCardTab(key));
            return b;
        };

        box.appendChild(make('card', 'Карточка'));
        // СЧЁТЧИКА У «ИСТОРИИ» НЕТ — по той же причине, что и в карточке лида.
        box.appendChild(make('history', 'История'));
        return box;
    }

    function buildHistoryPane() {
        const pane = document.createElement('div');
        pane.dataset.role = 'employee-history-pane';
        pane.hidden = true;
        // ИМЕНА РОЛЕЙ ЗАДАЁТ ОБЩИЙ МОДУЛЬ, и в карточке лида разметка ровно
        // такая же. Подвал — тот же, что у раздела: без него вкладка обрывалась
        // на тридцатой строке молча.
        pane.innerHTML = `
            <div class="hi-section">
                <div class="ui-table-wrap" data-role="hi-wrap">
                    <table class="ui-table">
                        <thead><tr>
                            <th>Когда</th>
                            <th>Кто</th>
                            <th>Что изменилось</th>
                        </tr></thead>
                        <tbody data-role="hi-body"></tbody>
                    </table>
                </div>
                <div class="ui-table-foot" data-role="hi-foot" hidden>
                    <span data-role="hi-shown"></span>
                    <button type="button" class="ui-btn ui-btn--ghost" data-role="hi-more">Открыть в журнале</button>
                </div>
                <div class="ui-empty ui-empty--inline" data-role="hi-empty" hidden>
                    <div class="ui-empty__title">Изменений не записано</div>
                    <div class="ui-empty__text" data-role="hi-empty-text"></div>
                </div>
                <p class="ui-table-note" data-role="hi-note"></p>
            </div>`;
        return pane;
    }

    /**
     * Переключение вкладки окна.
     *
     * ВВЕДЁННОЕ НЕ ТЕРЯЕТСЯ: скрывается блок полей, а не сохраняется форма.
     * Переключение вкладки — не сохранение и не отмена.
     *
     * ПОДПИСЬ ОКНА НА «ИСТОРИИ» НЕ МЕНЯЕТСЯ (паспорт Р5, редакция 6): она
     * принадлежит карточке, а не вкладке, и меняющаяся вместе со вкладкой была
     * бы вторым заголовком при живом первом. Всё, что нужно сказать про журнал,
     * говорит подпись под таблицей — та же, что в карточке лида.
     *
     * Кнопки шага и сохранения скрыты: остаётся «Закрыть». Возврат на
     * «Карточку» возвращает кнопки в том же состоянии, в каком их оставили, —
     * задаёт его goToStep, и он же зовётся при возврате.
     */
    function switchCardTab(tab) {
        if (!modal) return;
        cardTab = tab;
        const onCard = tab === 'card';

        const tabs = modal.box.querySelector('[data-role="employee-tabs"]');
        if (tabs) {
            ['card', 'history'].forEach((key) => {
                const btn = tabs.querySelector(`[data-role="employee-tab-${key}"]`);
                if (!btn) return;
                btn.classList.toggle('ui-tabs__tab--active', key === tab);
                btn.setAttribute('aria-selected', String(key === tab));
            });
        }

        const fields = modal.box.querySelector('[data-role="step-1-fields"]');
        const fields2 = modal.box.querySelector('[data-role="step-2-fields"]');
        const pane = modal.box.querySelector('[data-role="employee-history-pane"]');
        if (pane) pane.hidden = onCard;

        if (onCard) {
            goToStep(currentStep);
        } else {
            if (fields) fields.hidden = true;
            if (fields2) fields2.hidden = true;
            ['prev-step', 'next-step', 'employee-save'].forEach((role) => {
                const btn = modal.box.querySelector(`[data-role="${role}"]`);
                if (btn) btn.hidden = true;
            });
            const cancel = modal.box.querySelector('[data-role="employee-cancel"]');
            if (cancel) cancel.textContent = 'Закрыть';
            if (historyPane) historyPane.ensure();
        }

        if (onCard) {
            const cancel = modal.box.querySelector('[data-role="employee-cancel"]');
            if (cancel) cancel.textContent = 'Отмена';
        }
    }

    /** Закрыть окно. skipConfirm — после сохранения, вопрос там неуместен. */
    async function close(skipConfirm = false) {
        if (!modal) return;
        if (skipConfirm) { modal.close(true); return; }
        await modal.requestClose(false);
    }

    // ------------------------------------------------------------ сохранение

    // Порядок тот же, что в форме: подпись из него идёт и в тост, и под поле.
    const REQUIRED_STEP1 = [
        { sel: '#empLastName', label: 'Фамилия' },
        { sel: '#empFirstName', label: 'Имя' },
        { sel: '#empEmail', label: 'Email' },
        { sel: '#empPhone', label: 'Телефон' }
    ];

    // Общая проверка первого шага: она же на кнопке «Далее» и на сохранении.
    function checkStep1() {
        clearFieldErrors();
        // Ошибка первого шага, найденная при сохранении, показывается на самом
        // первом шаге: краснеющее поле, которого не видно, не объясняет ничего.
        if (currentStep !== 1) goToStep(1);

        const lastName = $('#empLastName').value.trim();
        const firstName = $('#empFirstName').value.trim();
        const email = $('#empEmail').value.trim();
        const phone = $('#empPhone').value.trim();

        const empty = REQUIRED_STEP1.filter((f) => !$(f.sel).value.trim());
        if (empty.length) {
            toast(`Заполните обязательные поля: ${empty.map((f) => f.label).join(', ')}`, 'error');
            // Краснеют ВСЕ незаполненные, а не только первое: тост перечисляет
            // их все, и глазами их искать не нужно.

            empty.forEach((f) => markFieldError(f.sel, 'Поле обязательно'));
            $(empty[0].sel).focus();
            return null;
        }
        if (!validateEmail(email)) {
            toast('Введите корректный email', 'error');
            markFieldError('#empEmail', 'Нужен адрес вида ivan@company.ru');
            $('#empEmail').focus();
            return null;
        }
        if (!validatePhone(phone)) {
            const message = 'Номер должен соответствовать форматам: +7 9xx xxx-xx-xx (Россия), +7 7xx xxx-xx-xx (Казахстан), +998 xx xxx-xx-xx (Узбекистан), +996 xx xxx-xx-xx (Кыргызстан)';
            toast(message, 'error');
            markFieldError('#empPhone', message);
            $('#empPhone').focus();
            return null;
        }
        return { lastName, firstName, email, phone };
    }

    async function uploadChangedDocuments(employeeId) {
        const errors = [];
        for (const key of DOC_FIELDS) {
            const input = docInput(key);
            if (!input.files.length) continue;
            const file = input.files[0];
            try {
                const data = await readFileAsDataUrl(file);
                await storage.uploadEmployeeDocument(employeeId, DOCUMENT_TYPE_MAP[key], file.name, data);
            } catch (err) {
                if (isAbort(err)) return errors;
                errors.push(`${file.name}: ${err.message}`);
            }
            if (!isAlive()) return errors;
        }
        return errors;
    }

    /**
     * Возвращает false, если окно должно остаться открытым: слой понимает это
     * как «действие не удалось» и возвращает кнопке рабочее состояние.
     */
    async function handleSubmit() {
        // Двойной щелчок по «Сохранить» создавал бы двух сотрудников: запрос
        // идёт секунду, а кнопка всё это время активна.
        if (saving) return false;
        if (currentStep !== 2) {
            toast('Сначала заполните поля первого шага и нажмите «Далее»', 'error');
            return false;
        }

        const base = checkStep1();
        if (!base) return false;

        // Блок «График работы»: сохранить непонятное значение нельзя. Ошибка
        // показывается второй раз (первый — при уходе из поля).
        const workDays = validateWorkDaysField();
        const shiftTimes = validateShiftTimeField();
        if (!workDays || !shiftTimes) {
            toast('Проверьте блок «График работы»: значение не распознано', 'error');
            goToStep(1);
            $(workDays ? '#empShiftTime' : '#empWorkSchedule').focus();
            return false;
        }

        const empData = {
            lastName: base.lastName,
            firstName: base.firstName,
            middleName: $('#empMiddleName').value.trim(),
            email: base.email,
            phone: formatPhone(base.phone),
            whatsapp: $('#empWhatsapp').value.trim(),
            telegram: $('#empTelegram').value.trim(),
            position: $('#empPosition').value.trim(),
            department: $('#empDepartment').value.trim(),
            managerId: $('#empManager').value ? Number($('#empManager').value) : null,
            hireDate: $('#empHireDate').value,
            status: $('#empStatus').value,
            terminationDate: $('#empTerminationDate').value,
            lineType: $('#empLineType').value.trim(),
            workSchedule: workDays.value,
            shiftStart: shiftTimes.start,
            shiftEnd: shiftTimes.end,
            password: $('#empPassword').value.trim(),
            pbxExtension: $('#empPbxExtension').value.trim(),
            country: $('#empCountry').value,
            registration: $('#empRegistration').value.trim(),
            passportSeries: $('#empPassportSeries').value.trim(),
            passportNumber: $('#empPassportNumber').value.trim(),
            issuedBy: $('#empIssuedBy').value.trim(),
            issueDate: $('#empIssueDate').value,
            inn: $('#empInn').value.trim(),
            bank: $('#empBank').value.trim(),
            account: $('#empAccount').value.trim()
        };

        // Ключ пароля АТС уходит ТОЛЬКО когда его трогали. Сервер отличает
        // «не прислали» от «прислали пустое» по наличию ключа: первое оставляет
        // пароль как есть, второе очищает его сознательно.
        // Значение не тримится: пробел может быть частью пароля, а формат
        // задаёт оператор связи — проверять его нам нечем.
        if (pbxPasswordDirty) {
            empData.pbxPassword = pbxInput().value;
        }

        saving = true;
        const wasEditing = editingId !== null;
        let saved;
        try {
            saved = wasEditing
                ? await storage.updateEmployee(editingId, empData)
                : await storage.createEmployee(empData);
        } catch (err) {
            if (!isAlive()) return false;
            if (isAbort(err)) return false;
            // «Номер 102 уже у Иванова И. И.» — ответ сервера, а не догадка
            // формы: занятость проверяет база, и только она знает, кто занял.
            // Текст идёт под поле, потому что исправлять надо именно его.
            // К169: показанное под полем тостом не повторяется — правило слоя
            // «ошибка живёт под полем, а не в тосте». Остальные отказы тостом
            // показывать по-прежнему нужно: своего поля у них нет.
            if (err.code === 'extension_taken') {
                goToStep(1);
                markFieldError('#empPbxExtension', err.message);
                $('#empPbxExtension').focus();
                return false;
            }
            toast(err.message, 'error');
            return false;
        } finally {
            saving = false;
        }
        if (!isAlive()) return false;

        const docErrors = await uploadChangedDocuments(saved.id);
        if (!isAlive()) return false;

        await close(true);
        if (onSaved) await onSaved();
        if (!isAlive()) return true;

        if (docErrors.length > 0) {
            toast(`Сотрудник сохранён, но не удалось загрузить документы: ${docErrors.join('; ')}`, 'error');
        } else {
            toast(wasEditing ? 'Изменения сохранены' : 'Сотрудник добавлен', 'success');
        }
        return true;
    }

    /** Открыть карточку по id — из таблицы. */
    async function openById(id) {
        let emp;
        let documents;
        try {
            emp = await storage.fetchEmployeeById(id);
            documents = await storage.fetchEmployeeDocuments(id);
            if (!isAlive()) return;
        } catch (err) {
            if (!isAbort(err)) toast(err.message, 'error');
            return;
        }
        const docsByKey = {};
        documents.forEach((doc) => {
            const key = Object.keys(DOCUMENT_TYPE_MAP).find((k) => DOCUMENT_TYPE_MAP[k] === doc.documentType);
            if (key) docsByKey[key] = { name: doc.fileName };
        });
        await open('Редактирование сотрудника', { ...emp, ...docsByKey });
    }

    /**
     * Подписки на поля окна. Раньше стояли в init() один раз на всю жизнь
     * панели — поля были в разметке и не менялись. Теперь поля клонируются на
     * каждое открытие, и подписываться надо на свежие узлы.
     */
    function bindFormEvents(form) {
        // Ошибка формата показывается при уходе из поля и повторно при сохранении.
        form.querySelector('#empWorkSchedule').addEventListener('blur', validateWorkDaysField);
        form.querySelector('#empShiftTime').addEventListener('blur', validateShiftTimeField);

        // Исправляют поле — красная рамка уходит сразу, а не после следующей
        // проверки: иначе исправленное поле остаётся помеченным ошибкой.
        form.addEventListener('input', (e) => {
            const field = e.target.closest && e.target.closest('.ui-field--error');
            if (field) field.classList.remove('ui-field--error');
        });

        // Кнопка «показать / скрыть». Значение приезжает ПО НАЖАТИЮ и только
        // при редактировании: у нового сотрудника показывать нечего, кроме
        // того, что человек сам набрал.
        form.querySelector('[data-role="pbx-reveal"]').addEventListener('click', async () => {
            const input = form.querySelector('#empPbxPassword');
            if (pbxPasswordShown) {
                setPbxShown(false);
                return;
            }
            if (!input.value && pbxPasswordSet && editingId !== null) {
                try {
                    const answer = await storage.fetchPbxPassword(editingId);
                    if (!isAlive() || !modal) return;
                    input.value = (answer && answer.pbxPassword) || '';
                } catch (err) {
                    if (!isAbort(err)) toast(err.message, 'error');
                    return;
                }
            }
            setPbxShown(true);
            syncPbxButton();
        });

        // Ключ туннеля: выдача и перевыпуск. Кнопка одна на оба случая —
        // заведение и редактирование в проекте одно и то же окно.
        form.querySelector('[data-role="tunnel-issue"]').addEventListener('click', issueTunnelKey);

        // Открытый ключ копируют, а не читают глазами: он нужен целиком и
        // без опечаток тому, кто впускает его на сервере.
        form.querySelector('[data-role="tunnel-key-copy"]').addEventListener('click', () => {
            copyMachineText(form.querySelector('[data-role="tunnel-key-value"]'),
                'Открытый ключ скопирован',
                'Браузер не дал доступ к буферу обмена — ключ выделен, скопируйте его сами');
        });

        // Статус влияет на кнопку выдачи: тому, кого сейчас отправят в архив,
        // ключ выдавать незачем. Пилюлю выбранный статус не трогает — она про
        // сохранённое состояние.
        form.querySelector('#empStatus').addEventListener('change', renderTunnelRow);

        // Правка поля — единственный повод отправить пароль на сервер.
        form.querySelector('#empPbxPassword').addEventListener('input', () => {
            pbxPasswordDirty = true;
            syncPbxButton();
        });

        form.querySelector('[data-role="generate-password"]').addEventListener('click', () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
            let password = '';
            for (let i = 0; i < 10; i++) password += chars.charAt(Math.floor(Math.random() * chars.length));
            form.querySelector('#empPassword').value = password;
        });

        // Enter в поле нажимает главную кнопку шага: на первом «Далее», на
        // втором «Сохранить». Это давала разметочная <form>, и терять привычку
        // из-за переезда незачем.
        // К167: Enter с КНОПКИ принадлежит кнопке, а не шагу. Иначе нажатие
        // Enter на кнопке показа пароля перехватывалось здесь и нажимало
        // «Далее»: показ не переключался, а на заполненной карточке уезжал
        // шаг 2, и пароль исчезал с экрана вместе с шагом 1. Пропускается по
        // той же причине, что и TEXTAREA.
        form.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.target.tagName === 'TEXTAREA'
                || event.target.tagName === 'BUTTON') return;
            event.preventDefault();
            const btn = currentStep === 1 ? $('[data-role="next-step"]') : saveBtn();
            if (btn && !btn.disabled) btn.click();
        });

        // Загрузчики файлов
        Array.from(form.querySelectorAll('.file-upload-area')).forEach((area) => {
            const input = area.querySelector('.hidden-file-input');
            const nameSpan = area.querySelector('.file-name');
            const icon = area.querySelector('.file-status-icon');
            const trigger = area.querySelector('.file-trigger');
            if (!input || !trigger) return;

            trigger.addEventListener('click', () => input.click());
            input.addEventListener('change', () => {
                if (!input.files || input.files.length === 0) {
                    nameSpan.textContent = '';
                    icon.hidden = true;
                    return;
                }
                const file = input.files[0];
                if (file.size > MAX_FILE_SIZE) {
                    toast('Файл слишком большой (максимум 5 МБ)', 'error');
                    input.value = '';
                    nameSpan.textContent = '';
                    icon.hidden = true;
                    return;
                }
                nameSpan.textContent = file.name;
                icon.hidden = false;
            });
        });
    }

    function init() {
        $('[data-role="add-employee"]').addEventListener('click', () => open('Новый сотрудник'));
    }

    return { init, open, openById, close, isOpen: () => modal !== null };
}
