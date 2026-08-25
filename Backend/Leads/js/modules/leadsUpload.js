// --- leadsUpload.js: массовая загрузка базы (Excel/CSV) ---
// Разбор файла — на фронте (библиотека SheetJS/xlsx), бэку уходит готовый JSON.
// Формат файла — решение куратора (dialog.md, 13.08.2026): первая строка —
// заголовок (пропускается), дальше колонки читаются по фиксированному порядку
// (не по тексту заголовка): Фамилия, Имя, Отчество, Телефон. Пустые ФИО
// допускаются, обязателен только телефон — строки без телефона в партию не
// попадают вообще.
//
// К партии привязан весь набор параметров подбора: линия, скрипт, статусы
// показа, условный скрипт для повторных, офферы и опциональный пул раздачи.
// Один набор на всю партию.

import { createPickList } from './leadsPickList.js';
import { createScriptPairs } from './leadsScriptPairs.js';
import { createOfferInlinePicker } from './leadsOffers.js';
import { openModal } from '/ui/modal.js';


// Раньше библиотека подключалась тегом <script> в leads.html. Во фрагменте
// раздела так нельзя: фрагмент вставляется через innerHTML, а скрипты оттуда
// браузер не выполняет — молча, без единой ошибки. Грузим по требованию.
//
// Промис держим на уровне модуля, а не панели: XLSX — глобальная переменная,
// один экземпляр на документ, и второе открытие раздела не должно тянуть
// 900 КБ заново.
//
// Побочно это лучше прежнего: до переноса библиотека грузилась при каждом
// заходе на страницу «Лиды», даже если базу никто не загружал.
// Библиотека лежит В ПРОЕКТЕ (Leads/vendor/, раздаётся статикой раздела), а не
// на cdnjs. Это не новая зависимость, а перенос уже используемой: SheetJS
// 0.18.5, тот же файл, что грузился с CDN. Решение владельца 19.08.2026 —
// после перевода значков на свой набор внешний CDN оставался единственной
// причиной, по которой приложению нужна сеть, и без доступа к нему массовая
// загрузка лидов просто не работала.
const XLSX_URL = '/vendor/xlsx.full.min.js';
let xlsxPromise = null;

function loadXlsx() {
    if (typeof XLSX !== 'undefined') return Promise.resolve();
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = XLSX_URL;
        script.addEventListener('load', () => resolve(), { once: true });
        script.addEventListener('error', () => {
            // Промис сбрасываем: следующая попытка должна пробовать заново, а
            // не отдавать сохранённый отказ до перезагрузки вкладки.
            xlsxPromise = null;
            reject(new Error('Библиотека для чтения файла не загрузилась — обновите страницу и попробуйте ещё раз'));
        }, { once: true });
        document.head.appendChild(script);
    });
    return xlsxPromise;
}

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fillSelect(select, items, placeholder) {
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`
        + items.map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`).join('');
}

// CSV — читаем как текст (File.text() всегда декодирует как UTF-8) и отдаём
// XLSX.read строкой (type: 'string'): так парсер работает с уже готовым
// unicode-текстом, не гадая кодовую страницу по сырым байтам. Раньше здесь
// читалось через arrayBuffer()+type:'array' для ВСЕХ форматов сразу — для
// .xlsx/.xls это верно (бинарный zip), но для .csv так парсер получал сырые
// байты и распознавал их не как UTF-8, а в другой кодовой странице — кириллица
// и «+» в номере телефона молча портились (обнаружено тестом: дубль-проверка
// и поиск по фамилии переставали находить только что загруженные строки).
async function parseFile(file) {
    await loadXlsx();
    const isCsv = /\.csv$/i.test(file.name);
    const workbook = isCsv
        ? XLSX.read(await file.text(), { type: 'string' })
        : XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // raw:false — берём отформатированный текст ячейки (.w), а не
    // автоопределённое значение (.v): без этого телефон вроде «+79995551111»
    // SheetJS распознаёт как ЧИСЛО и молча теряет ведущий «+».
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false });

    return rows
        .slice(1) // первая строка — заголовок
        .map((row) => ({
            lastName: row[0] !== undefined ? String(row[0]).trim() : '',
            firstName: row[1] !== undefined ? String(row[1]).trim() : '',
            middleName: row[2] !== undefined ? String(row[2]).trim() : '',
            phone: row[3] !== undefined ? String(row[3]).trim() : ''
        }))
        .filter((r) => r.phone); // без телефона строку вставить нельзя (leads.phone NOT NULL)
}

/**
 * @param {HTMLElement} root  контейнер панели
 * @param {Object}      deps  { storage, toast, isAlive, isAbort, onImported }
 */
export function createUpload(root, deps) {
    const { wrap, storage, toast, isAlive, isAbort, onImported } = deps;

    const $ = (sel) => root.querySelector(sel);
    // Блок полей окна. Пока окно закрыто, висит в разметке раздела с hidden;
    // открытие переставляет его в коробку окна, закрытие возвращает обратно.
    const fieldsNode = $('[data-role="upload-fields"]');
    const fileInput = $('[data-role="up-file-input"]');

    // Открытое окно слоя или null. Кнопки подвала строит слой — они ищутся по
    // роли каждый раз, а не запоминаются: до открытия их не существует.
    let modal = null;
    const leaveBtn = () => $('[data-role="upload-cancel"]');

    let selectedFile = null;
    let scriptPairs = null;
    let poolPick = null;
    let offerPick = null;
    let allEmployees = [];
    let allStatuses = [];

    /** Один вход для выбранного файла — и из диалога, и из перетаскивания. */
    function takeFile(file) {
        selectedFile = file;
        $('[data-role="up-file-name"]').textContent = file ? file.name : '';
    }

    function resetSummary() {
        $('[data-role="upload-summary"]').hidden = true;
        // Партии ещё нет — уход из окна отменяет начатое (К55). Кнопки подвала
        // может ещё не быть: сброс зовут и до открытия окна.
        const leave = leaveBtn();
        if (leave) leave.textContent = 'Отмена';
        $('[data-role="up-total"]').textContent = '0';
        $('[data-role="up-assigned"]').textContent = '0';
        $('[data-role="up-queued"]').textContent = '0';
        $('[data-role="up-dupes"]').textContent = '0';
    }

    // Пул раздачи заполняется только после выбора линии и показывает лишь
    // сотрудников этой линии: раздача всё равно идёт только по своей линии,
    // остальные в списке были бы ловушкой.
    function syncPoolByLine() {
        const line = $('#upLine').value;
        if (!line) {
            poolPick.setItems([]);
            poolPick.setDisabled(true);
            return;
        }
        poolPick.setDisabled(false);
        poolPick.setItems(
            allEmployees
                .filter((e) => e.lineType === line && e.status === 'active')
                .map((e) => ({ id: e.id, label: `${e.lastName} ${e.firstName}` }))
        );
    }

    // Партия начинается с одного набора, в котором предвыбран «Новый»:
    // загруженные лиды приходят именно с ним, и оператор увидит скрипт
    // сразу, а не после ручной правки каждого.
    function preselectNewStatus() {
        const newStatus = allStatuses.find((s) => s.stageNumber === 0);
        scriptPairs.setValues(newStatus ? [{ scriptId: null, statusIds: [newStatus.id] }] : []);
    }

    // Окно открывается пустым: файл, параметры и сводка сбрасываются при
    // каждом открытии.
    function openUploadModal() {
        if (modal) return;
        selectedFile = null;
        $('[data-role="up-file-name"]').textContent = '';
        fileInput.value = '';
        $('#upSource').value = '';
        $('#upLine').value = '';
        preselectNewStatus();
        syncPoolByLine();
        offerPick.clear();
        resetSummary();

        fieldsNode.hidden = false;
        modal = openModal({
            title: 'Загрузить базу',
            sub: 'Excel или CSV — каждая строка станет лидом. Один набор параметров на всю партию',
            body: fieldsNode,
            scope: wrap,
            actions: [
                // Кнопка ухода называется по тому, что произойдёт (К55):
                // «Отмена», пока партия не загружена, и «Закрыть» — после того,
                // как показана сводка. Отменять уже загруженное нечего.
                // Роль нужна, чтобы модуль мог до неё дотянуться: кнопку строит
                // слой.
                { label: 'Отмена', variant: 'ghost', role: 'upload-cancel' },
                // Возврат false всегда: сводку показывает само окно, и закрывать
                // его после удачной загрузки нельзя — человек не увидел бы ни
                // одного из четырёх чисел.
                { label: 'Загрузить', role: 'upload-go', onClick: () => handleGo() }
            ]
        });
        modal.result.then(() => {
            fieldsNode.hidden = true;
            wrap.appendChild(fieldsNode);
            modal = null;
        });
        // Кнопку подвала слой построил только что — теперь подпись можно
        // привести к состоянию окна.
        resetSummary();

        const first = $('#upSource');
        if (first) first.focus();

        // Библиотеку разбора начинаем тянуть сразу: пока человек заполняет
        // параметры партии, она успевает приехать. Отказ здесь не показываем —
        // о нём скажет сам разбор, если до него дойдёт.
        loadXlsx().catch(() => {});
    }

    async function handleGo() {
        const params = {
            sourceId: $('#upSource').value,
            lineType: $('#upLine').value,
            scriptPairs: scriptPairs.getValues(),
            poolEmployeeIds: poolPick.getValues(),
            offerIds: offerPick.getValues()
        };

        const problem = (message) => { toast(message, 'error'); return false; };
        if (!params.sourceId) return problem('Выберите источник для партии');
        if (!params.lineType) return problem('Выберите линию');
        // Наборы отказывают под полем, а не тостом: ошибка живёт там, где её
        // исправляют.
        const pairsProblem = scriptPairs.validate();
        if (pairsProblem) {
            pairsProblem.focus.scrollIntoView({ block: 'center', behavior: 'smooth' });
            const control = pairsProblem.focus.querySelector('select, input');
            if (control) control.focus();
            return false;
        }
        if (params.offerIds.length === 0) return problem('Выберите хотя бы один оффер');
        if (!selectedFile) return problem('Выберите файл');

        try {
            const rows = await parseFile(selectedFile);
            if (!isAlive()) return false;
            if (rows.length === 0) {
                return problem('В файле не найдено ни одной строки с номером телефона');
            }
            // Имя файла уходит на сервер вместе со строками: браузер разбирает
            // файл сам, и без этого поля партия в журнале изменений осталась бы
            // без ответа на первый же вопрос — «а что залили?» (часть 3).
            const result = await storage.bulkImportLeads({ ...params, rows, fileName: selectedFile.name });
            // Партия уже загружена — но панели, в которую надо нарисовать
            // сводку, может уже не быть.
            if (!isAlive()) return false;
            $('[data-role="up-total"]').textContent = result.imported;
            $('[data-role="up-assigned"]').textContent = result.distributed;
            $('[data-role="up-queued"]').textContent = result.queued;
            // Массив страхуем: партия к этому моменту УЖЕ загружена, и падать
            // из-за одного отсутствующего поля в ответе нельзя — человек
            // увидел бы красную ошибку сразу после успешной загрузки.
            $('[data-role="up-dupes"]').textContent = (result.duplicates || []).length;
            // Строки, чей номер не привёлся к единому виду (часть 4). Лид
            // заведён и работает, но номер лежит как пришёл и ждёт разбора —
            // сказать об этом надо там же, где показаны остальные числа
            // загрузки, иначе о них никто не узнает.
            const unresolvedCell = $('[data-role="up-unresolved"]');
            if (unresolvedCell) unresolvedCell.textContent = result.unresolved || 0;
            $('[data-role="upload-summary"]').hidden = false;
            // Партия уже в базе: отменять нечего, окно теперь просто закрывают.
            const leave = leaveBtn();
            if (leave) leave.textContent = 'Закрыть';
            toast(`Загружено лидов: ${result.imported}`, 'success');
            if (onImported) await onImported();
        } catch (e) {
            if (!isAlive() || isAbort(e)) return false;
            toast(e.message, 'error');
        }
        // Окно остаётся открытым в любом исходе: до загрузки — чтобы не терять
        // набранные параметры, после — чтобы человек увидел сводку.
        return false;
    }

    function init({ sources, employees, statuses, scripts }) {
        allEmployees = employees;
        allStatuses = statuses;

        fillSelect($('#upSource'), sources.map((s) => ({ id: s.id, name: s.leadSource || s.rootSource })), '— выберите источник —');
        // Тот же блок наборов, что в карточке лида и в окне массового
        // назначения: один модуль на три места (решение 85).
        scriptPairs = createScriptPairs($('[data-role="up-script-pairs"]'), { createPickList });
        scriptPairs.setScripts(scripts);
        scriptPairs.setStatuses(statuses);

        // Без emptyText: та же мысль уже сказана в подписи поля под списком —
        // две одинаковые подсказки подряд читаются как ошибка вёрстки.
        poolPick = createPickList($('[data-role="up-pool-pick"]'));
        poolPick.setDisabled(true);

        offerPick = createOfferInlinePicker($('[data-role="up-offer-pick"]'), {
            storage, toast, isAlive, isAbort
        });

        $('#upLine').addEventListener('change', syncPoolByLine);

        $('[data-role="upload-btn"]').addEventListener('click', openUploadModal);
        // Крестик, Esc, щелчок по затемнению и кнопка ухода — всё это теперь
        // даёт слой; своих обработчиков закрытия у модуля нет.

        $('[data-role="up-file-trigger"]').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            takeFile(fileInput.files[0] || null);
        });

        // Перетаскивание (К48). preventDefault на dragover обязателен: без него
        // браузер считает, что бросать сюда нельзя, и отпущенный файл просто
        // откроется вместо страницы. Проверка расширения здесь же — тот же
        // список, что у поля выбора: браузер фильтрует по accept только в
        // диалоге, перетащить можно что угодно.
        const drop = $('[data-role="up-drop"]');
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        drop.addEventListener('dragover', (e) => {
            stop(e);
            drop.classList.add('is-dropping');
        });
        drop.addEventListener('dragleave', (e) => {
            stop(e);
            drop.classList.remove('is-dropping');
        });
        drop.addEventListener('drop', (e) => {
            stop(e);
            drop.classList.remove('is-dropping');
            const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
            if (!file) return;
            if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
                toast('Нужен файл .xlsx, .xls или .csv', 'error');
                return;
            }
            takeFile(file);
        });
    }

    return {
        init,
        isOpen: () => modal !== null,
        destroy() {
            if (modal) modal.close(false);
            if (offerPick) offerPick.destroy();
        }
    };
}
