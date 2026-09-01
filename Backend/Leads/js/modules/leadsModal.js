// --- leadsModal.js: окно лида (создание/редактирование) ---
// Две вкладки: «Данные лида» | «Офферы (N)» — счётчик выбранных прямо на
// ярлыке, сохранение без офферов само переключает на вкладку «Офферы»
// (композиция дизайн-сессии, report_designer.md, 13.08.2026).
//
// Обязательные поля: номер, линия, источник, минимум один оффер, скрипт и
// минимум один статус показа. «Скрипт для повторных» условный — появляется и
// становится обязательным, когда среди статусов показа есть этапы 5–6.
//
// ПЕРЕНОС В ОБОЛОЧКУ. Модуль был набором функций уровня файла: состояние в
// переменных модуля, узлы — через document. Одна открытая панель это терпела,
// две — нет. Теперь это фабрика на монтирование: createLeadModal(root, deps)
// возвращает объект окна, и всё его состояние живёт внутри замыкания.

import { openModal } from '/ui/modal.js';

// Экспортируется: тот же список нужен одноимённому полю окна «Фильтры».
// Второй копией он однажды разошёлся бы с этой, и отбор предлагал бы значение,
// которого в карточку поставить нельзя.
export const DOWN_PAYMENT_OPTIONS = ['10', '15', '20', '25', '30', '50'];

// «Повторные» — этапы воронки 5 и 6 (решение владельца п.2).

// Поля, читаемые/заполняемые 1:1 по value (id = `ld` + key с большой первой
// буквы) — и текстовые, и выпадающие: у select тот же .value. Телефон, связки и
// чекбокс «иной заёмщик» обрабатываются отдельно.
const PLAIN_FIELDS = [
    'lastName', 'firstName', 'middleName', 'decisionMaker',
    'category', 'propertyType', 'propertyClass', 'roomCount', 'finish', 'deliveryDeadline',
    'priceFrom', 'priceTo', 'areaFrom', 'areaTo',
    'region', 'city', 'district', 'locality',
    'clientRegion', 'clientCity', 'clientDistrict', 'clientLocality',
    'purchaseMethod', 'mortgageType', 'downPaymentPercent', 'clientType', 'purchaseTimeframe',
    'notes'
];

// Каскады — та же логика, что в форме оффера и в карточке оператора, включая
// нестрогое сравнение по подстроке (значение могли переименовать через
// «Настройку списков»).
const DOWN_PAYMENT_WORDS = ['ипотек', 'материнск', 'рассрочк'];
const RETIREE_VALUE = 'Пенсионер';

// Кавычки экранируются тоже: значения справочников подставляются в
// `value="…"`, и значение с кавычкой обрывало бы атрибут (см. тот же разбор в
// leadsApp.js — общего escapeHtml в слое по-прежнему нет).
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fieldId(key) {
    return 'ld' + key.charAt(0).toUpperCase() + key.slice(1);
}

function fillSelectFromList(select, items, placeholder, withNone) {
    let html = `<option value="">${escapeHtml(placeholder)}</option>`;
    if (withNone) html += '<option value="none">— без оператора —</option>';
    html += items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
    select.innerHTML = html;
}

function fillPlainSelect(select, values, placeholder) {
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}`;
}

// Значение, сохранённое у лида, но отсутствующее в справочнике (владелец удалил
// его через «Настройку списков» или лид заведён до появления списка), нельзя ни
// обнулять, ни подменять — оно показывается отдельным пунктом с пометкой, сразу
// после пустого (dialog.md C1/C2). До 14.08.2026 такое значение просто не
// попадало ни в один <option>, select становился пустым, и первое же сохранение
// карточки затирало данные оператора.
function setSelectValue(select, value) {
    const previousOrphan = select.querySelector('option[data-out-of-list]');
    if (previousOrphan) previousOrphan.remove();

    const raw = value === null || value === undefined ? '' : String(value);
    const known = Array.from(select.options).some((option) => option.value === raw);
    if (raw && !known) {
        const option = document.createElement('option');
        option.value = raw;
        option.textContent = `${raw} — вне списка`;
        option.dataset.outOfList = 'true';
        select.insertBefore(option, select.options[1] || null);
    }
    select.value = raw;
}

// Тот же паттерн, что buildFunnelStatusOptions в Operator/js/modules/operatorLeadForm.js.
// Экспортируется — переиспользуется в leadsApp.js для фильтра и массового
// действия «Сменить статус» (те же ~59 значений, тот же паттерн optgroup).
//
// ⚠ ЧЕТЫРЕ РОЛИ У ОДНОГО СПИСКА, И ОНИ РАЗНЫЕ ПО СМЫСЛУ. Заход 6 завёл системные
// статусы — те, что ставит система, а не человек, — и граница между ролями стала
// видимой: список либо СТАВИТ статус лиду, либо ИЩЕТ по нему.
//
//   'set'    — карточка лида и массовая смена: человек назначает статус, и
//              системного среди предлагаемых быть не должно;
//   'filter' — отбор и быстрый отбор: отбор ищет, а не ставит, и системные в нём
//              нужны — красный статус придуман, чтобы такие лиды было ВИДНО.
//              Убрать их из отбора значило бы заставить искать красное глазами
//              среди тысяч строк.
//
// Роль называет ВЫЗЫВАЮЩИЙ, а не угадывает список: место вызова знает, что оно
// делает, а функция — нет.
//
// ⚠ И ГЛАВНОЕ: ТЕКУЩИЙ СТАТУС ПОКАЗЫВАЕТСЯ ВСЕГДА, даже системный. Простое
// «спрятать» открывает молчаливую дыру: у лида с «Нет результата» поле окажется
// пустым, руководитель нажмёт «Сохранить» — и `|| null` обнулит статус без
// единого слова. Поэтому системный текущий остаётся в списке; выбрать ДРУГОЙ
// системный по-прежнему нельзя.
export function fillFunnelStatusSelect(select, statuses, includeEmpty, options = {}) {
    const { purpose = 'filter', currentId = null } = options;
    const setting = purpose === 'set';
    const keep = currentId === null || currentId === undefined ? null : String(currentId);

    let html = includeEmpty ? '<option value="">— не выбран —</option>' : '';
    const byStage = new Map();
    statuses.forEach((s) => {
        if (setting && s.isSystem && String(s.id) !== keep) return;
        if (!byStage.has(s.stageNumber)) byStage.set(s.stageNumber, { stageName: s.stageName, items: [] });
        byStage.get(s.stageNumber).items.push(s);
    });
    Array.from(byStage.keys()).sort((a, b) => a - b).forEach((num) => {
        const { stageName, items } = byStage.get(num);
        const options = items.map((s) => `<option value="${s.id}">${escapeHtml(s.statusName)}</option>`).join('');
        html += `<optgroup label="${escapeHtml(`${num}. ${stageName}`)}">${options}</optgroup>`;
    });
    select.innerHTML = html;

    // Статус, ждущий решения руководителя, — красным (решение владельца:
    // «просто красным отображается в поле статус»). ⚠ К260: красное берёт
    // признак `awaitsManager`, а не `isSystem`, — системных статусов два, а
    // красный из них один. Прятать из выбора по-прежнему нужно ОБА, и это
    // разные правила на одном списке. Красит СЕЛЕКТ, а не пункт списка: цвет
    // пункта браузеры красят по-разному, а поле выглядит одинаково везде.
    // Значение передаётся ЯВНО: на этом шаге оно селекту ещё не присвоено —
    // его ставит вызывающий, после наполнения. Первая редакция читала
    // `select.value`, и поле открывалось некрашеным; поймано прогоном.
    paintSystemStatus(select, statuses, keep);
}

/**
 * К247 · Красное у поля статуса — ОДНИМ УСЛОВИЕМ НА ДВА МЕСТА.
 *
 * Прежде класс вешался только при наполнении списка, по значению на тот
 * момент. Человек менял статус руками — поле оставалось красным до
 * сохранения и переоткрытия: экран показывал состояние, которого в поле уже
 * не было.
 *
 * Условие вынесено, а не переписано вторым разом: две редакции одного правила
 * совпадают в день написания и расходятся в первый же день правки.
 */
function paintSystemStatus(select, statuses, id) {
    // Без явного значения берётся то, что в поле сейчас, — это случай
    // слушателя смены. С явным — случай наполнения списка.
    const want = id === undefined || id === null ? select.value : String(id);
    const current = (statuses || []).find((s) => String(s.id) === String(want));
    // ⚠ ПРИЗНАК `awaitsManager`, А НЕ `isSystem` — это К260. Красным по решению
    // владельца 106 отмечается ОДИН статус из двух системных: тот, по которому
    // лид дальше не двинется без руководителя. Имя класса осталось прежним
    // намеренно — оно живёт в паспорте и в CSS раздела; менять его значит
    // тянуть правку в документы ради слова.
    select.classList.toggle('ld-status--system', Boolean(current && current.awaitsManager));
}

// Живая маска «+7 (___) ___-__-__» — только российский формат (design-решение,
// report_designer.md, «правки по фидбеку владельца», 12.08.2026).
function maskRuPhone(raw) {
    let d = raw.replace(/\D/g, '');
    if (d.startsWith('8')) d = '7' + d.slice(1);
    if (!d.startsWith('7')) d = '7' + d;
    d = d.slice(0, 11);
    let out = '+7';
    if (d.length > 1) out += ' (' + d.slice(1, 4);
    if (d.length >= 4) out += ')';
    if (d.length > 4) out += ' ' + d.slice(4, 7);
    if (d.length > 7) out += '-' + d.slice(7, 9);
    if (d.length > 9) out += '-' + d.slice(9, 11);
    return out;
}

function employeeName(employee) {
    return `${employee.lastName} ${employee.firstName}`;
}

/**
 * @param {HTMLElement} root   контейнер панели
 * @param {Object}      deps   { storage, toast, isAlive, isAbort, createPickList,
 *                               createScriptPairs, createOfferTabPicker, createGeo,
 *                               onSaved }
 */
import { createHistoryPane } from '/history/historyTable.js';

export function createLeadModal(root, deps) {
    const {
        wrap, confirm, storage, toast, isAlive, isAbort, api,
        createPickList, createScriptPairs, createOfferTabPicker, createGeo, onSaved
    } = deps;

    const $ = (sel) => root.querySelector(sel);
    // Блоки полей карточки: вкладки уходят в полосу под шапкой окна, форма —
    // в его тело. Пока окно закрыто, оба висят в разметке раздела с hidden.
    const tabsNode = $('[data-role="lead-tabs"]');
    const fieldsNode = $('[data-role="lead-fields"]');

    // Открытое окно слоя или null. Кнопки подвала строит слой, своей ссылки на
    // «Сохранить» у модуля больше нет: до открытия окна её не существует.
    let modal = null;
    // Снимок формы на момент открытия — по нему и только по нему решается,
    // спрашивать ли про несохранённое.
    let openedSnapshot = null;

    let editingLeadId = null;
    let funnelStatuses = [];
    let allEmployees = [];
    let scriptPairs = null;
    let offerPicker = null;
    let geo = null;
    let saving = false;
    // Сотрудник, уже назначенный открытому лиду. Нужен отдельно от списка: он
    // остаётся доступным, даже если не проходит фильтр по линии или уволен
    // (легаси-данные, dialog.md B1/B4) — иначе сохранение карточки молча
    // обнулило бы существующее назначение.
    let assignedEmployeeId = null;
    let cascadeTouched = false;
    // Значение «иного заёмщика», с которым карточку открыли: чекбокс
    // трёхзначное состояние не хранит (NULL и false выглядят одинаково),
    // поэтому исходное состояние запоминается отдельно.
    let openedOtherBorrower = null;

    // ---------------------------------------------------------------- каскады

    // Раздача уводит лида только оператору его линии, поэтому и вручную
    // назначить можно только такого же (окно загрузки фильтрует пул раздачи
    // ровно так же). Исключение — уже назначенный сотрудник: он остаётся в
    // списке с пометкой причины, по которой не прошёл бы фильтр, чтобы
    // сохранение карточки не потеряло существующее назначение.
    function syncEmployeesByLine() {
        const line = $('#ldLine').value;
        const select = $('#ldEmployee');
        const previous = select.value;

        if (!line) {
            select.innerHTML = '<option value="">— сначала выберите линию —</option>';
            select.disabled = true;
            select.value = '';
            return;
        }

        const matching = allEmployees.filter((e) => e.lineType === line && e.status === 'active');
        const options = matching.map((e) => ({ id: e.id, name: employeeName(e) }));

        const assigned = assignedEmployeeId ? allEmployees.find((e) => e.id === assignedEmployeeId) : null;
        if (assigned && !matching.some((e) => e.id === assigned.id)) {
            const reasons = [];
            if (assigned.lineType !== line) reasons.push('другая линия');
            if (assigned.status !== 'active') reasons.push('неактивен');
            options.unshift({ id: assigned.id, name: `${employeeName(assigned)} (${reasons.join(', ')})` });
        }

        select.disabled = false;
        fillSelectFromList(select, options, '— не назначен —');
        // Прежний выбор сохраняем, только если он всё ещё в списке: при смене
        // линии сотрудник старой линии из выбора уходит.
        select.value = options.some((o) => String(o.id) === previous) ? previous : '';
    }

    // Каскады «Покупки» — те же три правила, что в карточке оператора: без них
    // администратор сохранил бы взнос без ипотеки или «иного заёмщика» без
    // пенсионера, и данные разошлись бы с тем, что видит оператор (dialog.md G2).
    // Скрытое поле обнуляется, включая первоначальный взнос: у лида это критерий
    // будущего подбора, и «Наличные + взнос 20 %» — мусор (dialog.md F3).
    // keepValues=true — открытие карточки: поля прячутся, но НЕ обнуляются,
    // иначе первое же сохранение стёрло бы значения легаси-лида, которых
    // администратор даже не видел на экране.
    function syncPurchaseCascades(keepValues) {
        const payment = ($('#ldPurchaseMethod').value || '').toLowerCase();
        const showDownPayment = DOWN_PAYMENT_WORDS.some((word) => payment.includes(word));
        const showMortgage = payment.includes('ипотек');
        const showOtherBorrower = $('#ldClientType').value === RETIREE_VALUE && showMortgage;

        $('[data-role="down-payment-wrap"]').hidden = !showDownPayment;
        if (!showDownPayment && !keepValues) $('#ldDownPaymentPercent').value = '';

        $('[data-role="mortgage-wrap"]').hidden = !showMortgage;
        if (!showMortgage && !keepValues) $('#ldMortgageType').value = '';

        $('[data-role="other-borrower-wrap"]').hidden = !showOtherBorrower;
        if (!showOtherBorrower && !keepValues) $('#ldOtherBorrower').checked = false;
    }

    function handleCascadeChange() {
        cascadeTouched = true;
        syncPurchaseCascades(false);
    }

    // ТРИ ВКЛАДКИ. Переключение прячет БЛОК ПОЛЕЙ, а не сохраняет и не отменяет
    // форму: введённое на «Данных лида» остаётся в окне, пока окно открыто.
    // Переключение вкладки — не сохранение и не отмена.
    function switchTab(tab) {
        ['main', 'offers', 'history'].forEach((name) => {
            const btn = $(`[data-role="tab-${name}"]`);
            const panel = $(`[data-role="tab-panel-${name}"]`);
            const on = name === tab;
            btn.classList.toggle('ui-tabs__tab--active', on);
            btn.setAttribute('aria-selected', String(on));
            panel.hidden = !on;
        });

        // ПОДВАЛ НА «ИСТОРИИ» — ОДНА КНОПКА «ЗАКРЫТЬ». «Сохранить» на вкладке,
        // где нечего сохранять, читается как «сохранить историю».
        if (modal) {
            const save = modal.box.querySelector('[data-role="lead-save"]');
            const cancel = modal.box.querySelector('[data-role="lead-cancel"]');
            if (save) save.hidden = tab === 'history';
            if (cancel) cancel.textContent = tab === 'history' ? 'Закрыть' : 'Отмена';
        }

        if (tab === 'history') loadHistory();
    }

    // ------------------------------------------------------------ история записи
    //
    // ЗАГРУЗКУ, ПОРЯДОК, ПОДВАЛ И ПУСТОТУ ВЕДЁТ ОБЩИЙ МОДУЛЬ ЖУРНАЛА. Здесь
    // лежала своя копия всего этого, и такая же вторая — в карточке сотрудника.
    // Как только у вкладки появился подвал и порядок, копий стало бы три; они
    // расходятся на первой же правке, а показывают одно и то же.

    let historyPane = null;

    function loadHistory() {
        if (!editingLeadId) return;
        if (!historyPane) {
            historyPane = createHistoryPane($('[data-role="tab-panel-history"]'), {
                api,
                recordTable: 'leads',
                recordId: () => editingLeadId,
                noteText: 'Показаны изменения самой записи лида.',
                // Уходя в журнал, карточку закрываем: два ответа на один вопрос
                // на одном экране — это не «подробнее», это спор.
                onLeave: async () => {
                    if (!(await confirmDiscard())) return false;
                    close();
                    return true;
                },
                isAlive,
                isAbort
            });
        }
        historyPane.ensure();
    }

    async function handlePhoneBlur() {
        const phone = $('#ldPhone').value.trim();
        const dupWarning = $('[data-role="dup-warning"]');
        if (!phone) {
            dupWarning.hidden = true;
            return;
        }
        try {
            const { duplicateId } = await storage.checkPhoneDuplicate(phone);
            // Панель могли закрыть, пока шла проверка.
            if (!isAlive()) return;
            const isDuplicate = duplicateId && duplicateId !== editingLeadId;
            dupWarning.hidden = !isDuplicate;
            if (isDuplicate) $('[data-role="dup-warning-id"]').textContent = '#' + duplicateId;
        } catch (e) {
            // Проверка дубля не блокирует работу с формой — тихо игнорируем
            // сбой сервиса. Отмена запроса сюда же и приходит.
        }
    }

    // ---------------------------------------------------------------- сборка

    function gatherLeadData() {
        const data = { phone: $('#ldPhone').value.trim() };
        PLAIN_FIELDS.forEach((key) => { data[key] = $('#' + fieldId(key)).value.trim(); });
        data.sourceId = $('#ldSource').value || null;
        data.lineType = $('#ldLine').value || null;
        data.employeeId = $('#ldEmployee').value || null;
        data.funnelStatusId = $('#ldFunnelStatus').value || null;
        // Наборы «скрипт и его статусы» вместо трёх прежних полей: сервер
        // раскладывает их по строкам, одна строка на статус.
        data.scriptPairs = scriptPairs.getValues();
        data.offerIds = offerPicker.getValues();
        data.poolEmployeeIds = [];
        // Трёхзначность: null — условие каскада не выполнено, поле неприменимо;
        // true/false — ответ. Не путать «нет» и «не спрашивали». Если поле
        // скрыто, но каскад в этом сеансе не трогали, отдаём то, что пришло из
        // базы: карточку могли просто открыть и сохранить.
        if (!$('[data-role="other-borrower-wrap"]').hidden) {
            data.otherBorrower = $('#ldOtherBorrower').checked;
        } else {
            data.otherBorrower = cascadeTouched ? null : (openedOtherBorrower ?? null);
        }
        return data;
    }

    /**
     * Сохранение. ВОЗВРАТ FALSE ОСТАВЛЯЕТ ОКНО ОТКРЫТЫМ — это договор слоя, и
     * промахнуться здесь дорого: любой выход без явного false закроет карточку
     * с тремя десятками заполненных полей на первой же непройденной проверке.
     */
    async function handleSave() {
        // Двойной щелчок по «Сохранить» до переноса создавал ДВА лида. Кнопку
        // на время обработчика блокирует уже слой; свой замок оставлен как
        // второй заслон — обработчик зовут не только из подвала.
        if (saving) return false;

        const data = gatherLeadData();

        // Клиентская проверка — ровно та же, что на сервере, чтобы пользователь
        // не ловил 400 на каждое пропущенное поле по очереди. Сообщение всегда
        // переключает на вкладку, где стоит виновное поле: иначе тост говорит
        // про поле, которого в этот момент не видно.
        const problem = (message, tab) => { toast(message, 'error'); switchTab(tab); return false; };
        if (!data.phone) return problem('Укажите номер телефона', 'main');
        if (!data.lineType) return problem('Выберите линию', 'main');
        if (!data.sourceId) return problem('Выберите источник', 'main');
        // Наборы отказывают ИНАЧЕ, чем остальные поля карточки: ошибка
        // живёт под полем, а не в тосте (паспорт Р11). Тост исчезает через
        // три секунды, а исправлять человек будет дольше. Тоста здесь нет
        // намеренно: окно переключает вкладку, прокручивается к неверному
        // набору и ставит фокус в поле — этого видно достаточно.
        const pairsProblem = scriptPairs.validate();
        if (pairsProblem) {
            switchTab('main');
            pairsProblem.focus.scrollIntoView({ block: 'center', behavior: 'smooth' });
            const control = pairsProblem.focus.querySelector('select, input');
            if (control) control.focus();
            return false;
        }
        // Сохранение без офферов само переключает на вкладку «Офферы» — там же
        // и подсказка «обязателен минимум один» (решение дизайн-сессии).
        if (data.offerIds.length === 0) return problem('Выберите хотя бы один оффер', 'offers');

        saving = true;
        const savedId = editingLeadId;
        try {
            if (savedId) {
                await storage.updateLead(savedId, data);
            } else {
                await storage.createLead(data);
            }
        } catch (e) {
            if (!isAlive()) return false;
            if (!isAbort(e)) toast(e.message, 'error');
            // Ошибка сервера оставляет окно открытым: набранное не должно
            // пропадать.
            return false;
        } finally {
            saving = false;
        }
        if (!isAlive()) return false;
        toast(savedId ? 'Лид сохранён' : 'Лид добавлен', 'success');
        // Сохранённое больше не «несохранённое»: иначе закрытие после успеха
        // спросило бы про потерю того, что уже в базе.
        openedSnapshot = snapshot();
        if (onSaved) await onSaved();
        return true;
    }

    /**
     * Состояние формы одной строкой. Сравнением с этим снимком и решается,
     * спрашивать ли про несохранённое: если с момента открытия ничего не
     * менялось, спрашивать не о чем и окно закрывается молча.
     */
    function snapshot() {
        try {
            return JSON.stringify(gatherLeadData());
        } catch (e) {
            // Мультивыборы могли ещё не собраться — тогда считаем, что
            // сравнивать не с чем, и вопрос задаём (ошибаемся в сторону
            // сохранности данных).
            return null;
        }
    }

    /**
     * Вопрос перед уходом — ОДИН НА ВСЕ ЧЕТЫРЕ ВЫХОДА (К123). «Отмена» идёт
     * сюда своим onClick, Esc, крестик и щелчок по затемнению — через
     * confirmClose слоя. Достаточно одного выхода в обход, чтобы проверки не
     * стало вовсе; до правки в обход шли все четыре.
     */
    async function confirmDiscard() {
        if (openedSnapshot !== null && snapshot() === openedSnapshot) return true;
        const ok = await confirm({
            title: 'Закрыть без сохранения?',
            message: 'Введённые данные лида не сохранятся.',
            confirmLabel: 'Закрыть без сохранения',
            // НА ВЕСЬ ЭКРАН, а не поверх панели: так это записано в паспорте
            // раздела, и так оно обязано быть по устройству — вопрос задаётся
            // ПОВЕРХ уже открытой карточки, а карточка сама теперь окно панели.
            // Два окна одного слоя разошлись бы только порядком в разметке;
            // экранное окно живёт слоем выше (1100) и спорить не с чем.
            screen: true
        });
        return Boolean(ok) && isAlive();
    }

    /** Программное закрытие — после сохранения, вопрос там неуместен. */
    function close() {
        if (modal) modal.close(true);
    }

    // ---------------------------------------------------------------- запуск

    function init({ sources, employees, statuses, paramLists, scripts }) {
        funnelStatuses = statuses;
        allEmployees = employees;

        // Источник лидов, а не корневой: см. правку данных 25.08.2026 —
        // в корневом у всех записей одно слово, выбирать по нему нельзя.
        fillSelectFromList($('#ldSource'), sources.map((s) => ({ id: s.id, name: s.leadSource || s.rootSource })), '— не выбран —');
        fillFunnelStatusSelect($('#ldFunnelStatus'), funnelStatuses, true, { purpose: 'set' });

        fillPlainSelect($('#ldDecisionMaker'), paramLists.decisionMaker || [], '— не выбран —');
        fillPlainSelect($('#ldCategory'), paramLists.category || [], '— не выбрана —');
        fillPlainSelect($('#ldPropertyType'), paramLists.objType || [], '— не выбран: жилое —');
        fillPlainSelect($('#ldPropertyClass'), paramLists.objClass || [], '— не выбран: все классы —');
        fillPlainSelect($('#ldRoomCount'), paramLists.rooms || [], '— не выбрана —');
        fillPlainSelect($('#ldFinish'), paramLists.finish || [], '— не выбрана —');
        fillPlainSelect($('#ldDeliveryDeadline'), paramLists.deadline || [], '— не выбран —');
        fillPlainSelect($('#ldPurchaseMethod'), paramLists.paymentMethod || [], '— не выбран —');
        fillPlainSelect($('#ldMortgageType'), paramLists.mortgageType || [], '— не выбран —');
        fillPlainSelect($('#ldClientType'), paramLists.clientType || [], '— не выбран —');
        fillPlainSelect($('#ldPurchaseTimeframe'), paramLists.purchaseTerm || [], '— не выбран —');
        fillPlainSelect($('#ldDownPaymentPercent'), DOWN_PAYMENT_OPTIONS, '— не выбран —');

        // Счётчик «N из 5» в шапке раздела: потолок обязан быть виден до
        // того, как человек упрётся в неактивную кнопку.
        const pairsCount = $('[data-role="script-pairs-count"]');
        scriptPairs = createScriptPairs($('[data-role="script-pairs"]'), {
            createPickList,
            onCountChange: (count, max) => { pairsCount.textContent = `${count} из ${max}`; }
        });
        // Справочники ставятся ПОСЛЕ сборки блока, и порядок здесь не
        // косметика: обращение к нему раньше валит init целиком, а вместе с
        // ним и всю карточку — окно просто не открывается, а ошибка уходит
        // тостом, не в консоль. Поймано визуальной проверкой.
        scriptPairs.setStatuses(funnelStatuses);
        scriptPairs.setScripts(scripts);

        offerPicker = createOfferTabPicker({
            platSelect: $('#ofltPlat'),
            geoSelects: {
                region: $('#ofltRegion'), city: $('#ofltCity'),
                district: $('#ofltDistrict'), locality: $('#ofltLocality')
            },
            searchInput: $('#offerSearchInput'), resetBtn: $('[data-role="offer-filters-reset"]'),
            foldHead: $('[data-role="offer-filters-head"]'),
            foldBody: $('[data-role="offer-filters-body"]'),
            filterCountEl: $('[data-role="offer-filters-count"]'),
            resultsEl: $('[data-role="offer-results"]'), tagsEl: $('[data-role="offer-sel-tags"]'),
            countEl: $('[data-role="offer-sel-count"]'), emptyEl: $('[data-role="offer-sel-empty"]'),
            clearAllBtn: $('[data-role="offer-clear-all"]'), tabCountEl: $('[data-role="offer-tab-count"]')
        });

        geo = createGeo();

        $('[data-role="tab-main"]').addEventListener('click', () => switchTab('main'));
        $('[data-role="tab-offers"]').addEventListener('click', () => switchTab('offers'));
        $('[data-role="tab-history"]').addEventListener('click', () => switchTab('history'));
        // К247 · Красное у поля статуса пересчитывается ПРИ СМЕНЕ, а не только
        // при открытии карточки. Слушатель здесь, рядом с остальными: список
        // статусов у окна один, и второго места, где он меняется, нет.
        $('#ldFunnelStatus').addEventListener('change', (e) => paintSystemStatus(e.target, funnelStatuses));
        $('#ldLine').addEventListener('change', syncEmployeesByLine);
        $('#ldPurchaseMethod').addEventListener('change', handleCascadeChange);
        $('#ldClientType').addEventListener('change', handleCascadeChange);

        $('#ldPhone').addEventListener('input', (e) => {
            const pos = e.target.selectionStart;
            const before = e.target.value.length;
            e.target.value = maskRuPhone(e.target.value);
            const after = e.target.value.length;
            e.target.selectionEnd = Math.max(0, pos + (after - before));
        });
        $('#ldPhone').addEventListener('blur', handlePhoneBlur);

        // Кнопок подвала и крестика здесь больше нет: их строит слой при
        // открытии окна, и обработчики висят на них там же.
    }

    async function open(lead) {
        if (modal) return;
        editingLeadId = lead ? lead.id : null;
        openedSnapshot = null;
        if (historyPane) historyPane.reset();
        geo.reset();
        // У НОВОЙ ЗАПИСИ ВКЛАДКИ «ИСТОРИЯ» НЕТ ВОВСЕ: читать нечего, а
        // неактивная вкладка была бы обещанием, которого никто не давал.
        $('[data-role="tab-history"]').hidden = !editingLeadId;
        switchTab('main');
        $('[data-role="dup-warning"]').hidden = true;

        $('#ldPhone').value = lead ? (lead.phone || '') : '';
        PLAIN_FIELDS.forEach((key) => {
            const el = $('#' + fieldId(key));
            const value = lead && lead[key] !== null && lead[key] !== undefined ? lead[key] : '';
            // Селекты — через setSelectValue: значение вне справочника должно
            // остаться в поле, а не превратиться в пустоту при сохранении.
            if (el.tagName === 'SELECT') setSelectValue(el, value);
            else el.value = value;
        });
        $('#ldOtherBorrower').checked = lead ? lead.otherBorrower === true : false;
        openedOtherBorrower = lead && (lead.otherBorrower === true || lead.otherBorrower === false) ? lead.otherBorrower : null;
        cascadeTouched = false;
        syncPurchaseCascades(true);
        $('#ldSource').value = lead && lead.sourceId ? lead.sourceId : '';
        $('#ldLine').value = lead && lead.lineType ? lead.lineType : '';
        // Список сотрудников зависит от линии, поэтому заполняется ПОСЛЕ неё, и
        // только потом выставляется текущее назначение.
        assignedEmployeeId = lead && lead.employeeId ? lead.employeeId : null;
        syncEmployeesByLine();
        $('#ldEmployee').value = lead && lead.employeeId ? lead.employeeId : '';
        // СПИСОК СТАТУСОВ ПЕРЕСОБИРАЕТСЯ ПОД КОНКРЕТНОГО ЛИДА, а не один раз на
        // окно: системный статус в нём есть ровно тогда, когда он у лида сейчас
        // стоит. Без этого у лида с «Нет результата» поле осталось бы пустым, а
        // «Сохранить» молча обнулило бы статус — `|| null` в сборке данных.
        fillFunnelStatusSelect($('#ldFunnelStatus'), funnelStatuses, true,
            { purpose: 'set', currentId: lead && lead.funnelStatusId });
        $('#ldFunnelStatus').value = lead && lead.funnelStatusId ? lead.funnelStatusId : '';
        // Пометка «заполнена частично» — только у существующего лида и только
        // когда она стоит. Снимается пометка сохранением, поэтому плашка исчезнет
        // сама при следующем открытии карточки, а не гасится здесь руками.
        $('[data-role="lead-partial"]').hidden = !(lead && lead.partiallyFilled);
        // «Новый» предвыбран у нового лида (требование куратора): иначе легко
        // создать лида, у которого оператор сразу не увидит скрипта. Правило
        // пережило переделку на наборы — оно про первый набор.
        if (lead) {
            scriptPairs.setValues(lead.scriptPairs || []);
        } else {
            const newStatus = funnelStatuses.find((s) => s.stageNumber === 0);
            scriptPairs.setValues(newStatus ? [{ scriptId: null, statusIds: [newStatus.id] }] : []);
        }

        tabsNode.hidden = false;
        fieldsNode.hidden = false;
        modal = openModal({
            title: lead ? `Лид #${lead.id}` : 'Новый лид',
            sub: 'Обязательные поля: номер, линия, источник, офферы, скрипт и статусы показа — остальное можно заполнить позже',
            toolbar: tabsNode,
            body: fieldsNode,
            scope: wrap,
            size: 'wide',
            confirmClose: confirmDiscard,
            actions: [
                // Уход тихий, как всякий уход в проекте. Возврат false
                // оставляет окно открытым: человек передумал уходить.
                //
                // РОЛИ НУЖНЫ ВКЛАДКЕ «ИСТОРИЯ»: там подвал — одна кнопка
                // «Закрыть», и раздел находит обе по роли, а не по подписи.
                { label: 'Отмена', variant: 'ghost', role: 'lead-cancel', onClick: () => confirmDiscard() },
                { label: 'Сохранить', role: 'lead-save', onClick: () => handleSave() }
            ]
        });
        modal.result.then(() => {
            tabsNode.hidden = true;
            fieldsNode.hidden = true;
            // Блоки возвращаются в раздел: они остаются в границах .leads-wrap,
            // и модуль продолжает находить свои поля по id.
            wrap.appendChild(tabsNode);
            wrap.appendChild(fieldsNode);
            modal = null;
            editingLeadId = null;
            openedSnapshot = null;
        });

        // Фокус — в поле телефона: это первое поле карточки и единственное,
        // без которого лида не существует. Слой по умолчанию взял бы крестик.
        const phone = $('#ldPhone');
        if (phone) phone.focus();

        await offerPicker.open(lead ? lead.offers : []);
        // Снимок берётся ПОСЛЕ офферов: они часть формы, и до их загрузки
        // сравнивать было бы не с чем — карточка считалась бы изменённой сразу
        // после открытия и спрашивала бы всегда.
        if (modal) openedSnapshot = snapshot();
    }

    return {
        init,
        open,
        close,
        isOpen: () => modal !== null,
        destroy() {
            if (modal) modal.close(false);
            if (offerPicker) offerPicker.destroy();
            if (geo) geo.destroy();
        }
    };
}
