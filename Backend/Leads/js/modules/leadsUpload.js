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
import { createOfferInlinePicker } from './leadsOffers.js';

const REPEAT_STAGE_FROM = 5;

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
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
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
            reject(new Error('Библиотека для чтения файла не загрузилась — проверьте подключение к интернету и попробуйте ещё раз'));
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
    const { storage, toast, isAlive, isAbort, onImported } = deps;

    const $ = (sel) => root.querySelector(sel);
    const modal = $('[data-role="upload-modal"]');
    const goBtn = $('[data-role="upload-go"]');
    const fileInput = $('[data-role="up-file-input"]');

    let selectedFile = null;
    let statusPick = null;
    let poolPick = null;
    let offerPick = null;
    let allEmployees = [];
    let allStatuses = [];

    function resetSummary() {
        $('[data-role="upload-summary"]').hidden = true;
        $('[data-role="up-total"]').textContent = '0';
        $('[data-role="up-assigned"]').textContent = '0';
        $('[data-role="up-queued"]').textContent = '0';
        $('[data-role="up-dupes"]').textContent = '0';
    }

    function syncRepeatVisibility() {
        const chosen = new Set(statusPick.getValues());
        const needsRepeat = allStatuses.some((s) => chosen.has(s.id) && s.stageNumber >= REPEAT_STAGE_FROM);
        $('[data-role="up-repeat-wrap"]').hidden = !needsRepeat;
        return needsRepeat;
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

    function preselectNewStatus() {
        const newStatus = allStatuses.find((s) => s.stageNumber === 0);
        statusPick.setValues(newStatus ? [newStatus.id] : []);
    }

    function openModal() {
        selectedFile = null;
        $('[data-role="up-file-name"]').textContent = '';
        fileInput.value = '';
        $('#upSource').value = '';
        $('#upLine').value = '';
        $('#upScript').value = '';
        $('#upRepeatScript').value = '';
        preselectNewStatus();
        syncRepeatVisibility();
        syncPoolByLine();
        offerPick.clear();
        resetSummary();
        modal.hidden = false;
        // Библиотеку разбора начинаем тянуть сразу: пока человек заполняет
        // параметры партии, она успевает приехать. Отказ здесь не показываем —
        // о нём скажет сам разбор, если до него дойдёт.
        loadXlsx().catch(() => {});
    }

    function closeModal() {
        modal.hidden = true;
    }

    async function handleGo() {
        const params = {
            sourceId: $('#upSource').value,
            lineType: $('#upLine').value,
            scriptId: $('#upScript').value,
            repeatScriptId: $('#upRepeatScript').value || null,
            scriptStatusIds: statusPick.getValues(),
            poolEmployeeIds: poolPick.getValues(),
            offerIds: offerPick.getValues()
        };

        if (!params.sourceId) { toast('Выберите источник для партии', 'error'); return; }
        if (!params.lineType) { toast('Выберите линию', 'error'); return; }
        if (!params.scriptId) { toast('Выберите скрипт', 'error'); return; }
        if (params.scriptStatusIds.length === 0) { toast('Выберите хотя бы один статус показа скрипта', 'error'); return; }
        if (syncRepeatVisibility() && !params.repeatScriptId) {
            toast('Среди статусов показа есть этапы 5–6 — укажите скрипт для повторных', 'error');
            return;
        }
        if (params.offerIds.length === 0) { toast('Выберите хотя бы один оффер', 'error'); return; }
        if (!selectedFile) { toast('Выберите файл', 'error'); return; }

        goBtn.disabled = true;
        try {
            const rows = await parseFile(selectedFile);
            if (!isAlive()) return;
            if (rows.length === 0) {
                toast('В файле не найдено ни одной строки с номером телефона', 'error');
                return;
            }
            const result = await storage.bulkImportLeads({ ...params, rows });
            // Партия уже загружена — но панели, в которую надо нарисовать
            // сводку, может уже не быть.
            if (!isAlive()) return;
            $('[data-role="up-total"]').textContent = result.imported;
            $('[data-role="up-assigned"]').textContent = result.distributed;
            $('[data-role="up-queued"]').textContent = result.queued;
            $('[data-role="up-dupes"]').textContent = result.duplicates.length;
            $('[data-role="upload-summary"]').hidden = false;
            toast(`Загружено лидов: ${result.imported}`, 'success');
            if (onImported) await onImported();
        } catch (e) {
            if (!isAlive() || isAbort(e)) return;
            toast(e.message, 'error');
        } finally {
            goBtn.disabled = false;
        }
    }

    function init({ sources, employees, statuses, scripts }) {
        allEmployees = employees;
        allStatuses = statuses;

        fillSelect($('#upSource'), sources.map((s) => ({ id: s.id, name: s.rootSource })), '— выберите источник —');
        fillSelect($('#upScript'), scripts.map((s) => ({ id: s.id, name: s.title })), '— не выбран —');
        fillSelect($('#upRepeatScript'), scripts.map((s) => ({ id: s.id, name: s.title })), '— не выбран —');

        statusPick = createPickList($('[data-role="up-status-pick"]'), {
            emptyText: 'Ни один статус не выбран — обязателен минимум один.',
            onChange: syncRepeatVisibility
        });
        statusPick.setItems(statuses.map((s) => ({
            id: s.id, label: s.statusName, stageNumber: s.stageNumber, stageName: s.stageName
        })));

        // Без emptyText: та же мысль уже сказана в подписи поля под списком —
        // две одинаковые подсказки подряд читаются как ошибка вёрстки.
        poolPick = createPickList($('[data-role="up-pool-pick"]'));
        poolPick.setDisabled(true);

        offerPick = createOfferInlinePicker($('[data-role="up-offer-pick"]'), {
            storage, toast, isAlive, isAbort
        });

        $('#upLine').addEventListener('change', syncPoolByLine);

        $('[data-role="upload-btn"]').addEventListener('click', openModal);
        $('[data-role="upload-close"]').addEventListener('click', closeModal);
        $('[data-role="upload-cancel"]').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

        $('[data-role="up-file-trigger"]').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            selectedFile = fileInput.files[0] || null;
            $('[data-role="up-file-name"]').textContent = selectedFile ? selectedFile.name : '';
        });

        goBtn.addEventListener('click', handleGo);
    }

    return {
        init,
        isOpen: () => !modal.hidden,
        destroy() {
            if (offerPick) offerPick.destroy();
        }
    };
}
