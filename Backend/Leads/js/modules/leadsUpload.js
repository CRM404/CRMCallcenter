// --- leadsUpload.js: массовая загрузка базы (Excel/CSV) ---
// Парсинг — на фронте (библиотека SheetJS/xlsx через CDN, см. leads.html),
// бэку уходит уже готовый JSON. Формат файла — решение куратора (dialog.md,
// 13.08.2026): первая строка — заголовок (пропускается), дальше колонки
// читаются по фиксированному порядку (не по тексту заголовка): Фамилия, Имя,
// Отчество, Телефон. Пустые ФИО допускаются, обязателен только телефон —
// строки без телефона в партию не попадают вообще.
//
// Задача «скрипты: привязка к лиду»: к партии добавился весь набор параметров
// подбора — линия, скрипт, статусы показа, условный скрипт для повторных,
// офферы и опциональный пул раздачи. Один набор на всю партию.

import { bulkImportLeads } from './leadsStorage.js';
import { showToast } from './leadsToast.js';
import { createPickList } from './leadsPickList.js';
import { createOfferInlinePicker } from './leadsOffers.js';

const $ = (sel) => document.querySelector(sel);

const REPEAT_STAGE_FROM = 5;

let selectedFile = null;
let statusPick = null;
let poolPick = null;
let offerPick = null;
let allEmployees = [];
let allStatuses = [];

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
// и "+" в номере телефона молча портились (обнаружено тестом: дубль-проверка
// и поиск по фамилии переставали находить только что загруженные строки).
async function parseFile(file) {
    if (typeof XLSX === 'undefined') {
        throw new Error('Библиотека для чтения файла не загрузилась — проверьте подключение к интернету и обновите страницу');
    }
    const isCsv = /\.csv$/i.test(file.name);
    const workbook = isCsv
        ? XLSX.read(await file.text(), { type: 'string' })
        : XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // raw:false — берём отформатированный текст ячейки (.w), а не автоопределённое
    // значение (.v): без этого телефон вроде "+79995551111" SheetJS распознаёт
    // как ЧИСЛО и молча теряет ведущий "+" (обнаружено тестом).
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

function resetSummary() {
    $('#uploadSummary').hidden = true;
    $('#upTotal').textContent = '0';
    $('#upAssigned').textContent = '0';
    $('#upQueued').textContent = '0';
    $('#upDupes').textContent = '0';
}

function syncRepeatVisibility() {
    const chosen = new Set(statusPick.getValues());
    const needsRepeat = allStatuses.some((s) => chosen.has(s.id) && s.stageNumber >= REPEAT_STAGE_FROM);
    $('#upRepeatWrap').hidden = !needsRepeat;
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

export function initUpload({ sources, employees, statuses, scripts }, onImported) {
    allEmployees = employees;
    allStatuses = statuses;

    fillSelect($('#upSource'), sources.map((s) => ({ id: s.id, name: s.rootSource })), '— выберите источник —');
    fillSelect($('#upScript'), scripts.map((s) => ({ id: s.id, name: s.title })), '— не выбран —');
    fillSelect($('#upRepeatScript'), scripts.map((s) => ({ id: s.id, name: s.title })), '— не выбран —');

    statusPick = createPickList($('#upStatusPick'), {
        emptyText: 'Ни один статус не выбран — обязателен минимум один.',
        onChange: syncRepeatVisibility
    });
    statusPick.setItems(statuses.map((s) => ({
        id: s.id, label: s.statusName, stageNumber: s.stageNumber, stageName: s.stageName
    })));

    poolPick = createPickList($('#upPoolPick'), { emptyText: 'Пусто — раздаётся всем подходящим по линии.' });
    poolPick.setDisabled(true);

    offerPick = createOfferInlinePicker($('#upOfferPick'));

    $('#upLine').addEventListener('change', syncPoolByLine);

    $('#uploadBtn').addEventListener('click', () => {
        selectedFile = null;
        $('#upFileName').textContent = '';
        $('#upFileInput').value = '';
        $('#upSource').value = '';
        $('#upLine').value = '';
        $('#upScript').value = '';
        $('#upRepeatScript').value = '';
        preselectNewStatus();
        syncRepeatVisibility();
        syncPoolByLine();
        offerPick.clear();
        resetSummary();
        $('#uploadModal').hidden = false;
    });
    $('#uploadModalClose').addEventListener('click', () => { $('#uploadModal').hidden = true; });
    $('#uploadModalCancel').addEventListener('click', () => { $('#uploadModal').hidden = true; });
    $('#uploadModal').addEventListener('click', (e) => { if (e.target.id === 'uploadModal') $('#uploadModal').hidden = true; });

    $('#upFileTrigger').addEventListener('click', () => $('#upFileInput').click());
    $('#upFileInput').addEventListener('change', () => {
        selectedFile = $('#upFileInput').files[0] || null;
        $('#upFileName').textContent = selectedFile ? selectedFile.name : '';
    });

    $('#uploadModalGo').addEventListener('click', async () => {
        const params = {
            sourceId: $('#upSource').value,
            lineType: $('#upLine').value,
            scriptId: $('#upScript').value,
            repeatScriptId: $('#upRepeatScript').value || null,
            scriptStatusIds: statusPick.getValues(),
            poolEmployeeIds: poolPick.getValues(),
            offerIds: offerPick.getValues()
        };

        if (!params.sourceId) { showToast('Выберите источник для партии', 'error'); return; }
        if (!params.lineType) { showToast('Выберите линию', 'error'); return; }
        if (!params.scriptId) { showToast('Выберите скрипт', 'error'); return; }
        if (params.scriptStatusIds.length === 0) { showToast('Выберите хотя бы один статус показа скрипта', 'error'); return; }
        if (syncRepeatVisibility() && !params.repeatScriptId) {
            showToast('Среди статусов показа есть этапы 5–6 — укажите скрипт для повторных', 'error');
            return;
        }
        if (params.offerIds.length === 0) { showToast('Выберите хотя бы один оффер', 'error'); return; }
        if (!selectedFile) { showToast('Выберите файл', 'error'); return; }

        $('#uploadModalGo').disabled = true;
        try {
            const rows = await parseFile(selectedFile);
            if (rows.length === 0) {
                showToast('В файле не найдено ни одной строки с номером телефона', 'error');
                return;
            }
            const result = await bulkImportLeads({ ...params, rows });
            $('#upTotal').textContent = result.imported;
            $('#upAssigned').textContent = result.distributed;
            $('#upQueued').textContent = result.queued;
            $('#upDupes').textContent = result.duplicates.length;
            $('#uploadSummary').hidden = false;
            showToast(`Загружено лидов: ${result.imported}`, 'success');
            if (onImported) await onImported();
        } catch (e) {
            showToast(e.message, 'error');
        } finally {
            $('#uploadModalGo').disabled = false;
        }
    });
}
