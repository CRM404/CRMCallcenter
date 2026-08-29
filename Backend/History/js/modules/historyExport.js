// --- History/js/modules/historyExport.js: выгрузка журнала в Excel ---------
//
// ВЫГРУЖАЕТСЯ РОВНО ТО, ЧТО НА ЭКРАНЕ: тот же отбор, те же строки, те же три
// уровня подробности. Маскированное уезжает маскированным, «только факт» —
// фактом. Выгрузка, показывающая больше экрана, означала бы, что экран прятал
// не по правилам, а по вежливости.
//
// Библиотека — та же, что у «Лидов» и «Звонков»; она живёт в общем слое, и
// второй копии не заводится.
//
// ТОСТА ОБ УСПЕХЕ НЕТ: успех виден браузером. Тост остаётся за отказом
// действия, которое человек запросил сам.

import { fieldLabel } from '/history/historyFields.js';

const XLSX_URL = '/vendor/xlsx.full.min.js';

const ACTOR_KIND = {
    browser: 'указан браузером',
    none: 'не указан (правка из админки)',
    service: 'служебный автор'
};

const OP_LABEL = {
    insert: 'создание',
    update: 'изменение',
    delete: 'удаление',
    export: 'выгрузка журнала',
    batch: 'массовая операция'
};

let loading = null;

function loadXlsx() {
    if (typeof XLSX !== 'undefined') return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = XLSX_URL;
        script.onload = () => resolve();
        script.onerror = () => {
            loading = null;
            reject(new Error('Не удалось загрузить библиотеку выгрузки'));
        };
        document.head.appendChild(script);
    });
    return loading;
}

export async function buildWorkbook(rows, filters) {
    await loadXlsx();

    const data = rows.map((r) => ({
        'Когда': dateTime(r.changedAt),
        'Кто': r.actor.kind === 'none' ? 'не указан' : (r.actor.name || ''),
        'Вид автора': ACTOR_KIND[r.actor.kind] || '',
        'Раздел': r.page || '',
        'Таблица': r.table || '',
        'Номер записи': r.recordId || '',
        'Запись': r.recordTitle || (r.kind === 'batch' ? 'массовая операция' : ''),
        'Вид': OP_LABEL[r.op] || r.op || '',
        'Что изменилось': changesText(r)
    }));

    const sheet = XLSX.utils.json_to_sheet(data);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Журнал');
    XLSX.writeFile(book, fileName(filters));
}

/**
 * Изменения одной строки — одним текстом, по строке на поле.
 *
 * ТРИ УРОВНЯ СОХРАНЯЮТСЯ ДОСЛОВНО. Маскированное значение в файле остаётся
 * маскированным, «только факт» — фактом: файл не имеет права знать больше
 * экрана, потому что журнал и сам этого не знает.
 */
function changesText(row) {
    if (row.kind === 'batch') {
        const b = row.batch || {};
        return [b.title, b.rows ? `${b.rows} строк журнала` : '', b.fileName]
            .filter(Boolean).join('; ');
    }
    if (row.op === 'insert' && !row.changes.length) return 'Запись создана';
    if (row.op === 'delete' && !row.changes.length) return 'Запись удалена';

    const head = row.op === 'insert' ? ['Запись создана'] : (row.op === 'delete' ? ['Запись удалена'] : []);
    const lines = row.changes.map((item) => {
        // В ФАЙЛЕ СКОБКИ — ЧАСТЬ СТРОКИ, а не слой: CSS туда не едет, а
        // техническое имя нужно в файле ровно затем же, зачем на экране
        // (К258, паспорт Р5 редакции 9). Подписи нет — остаётся одно
        // техническое имя, без скобок: обрамлять нечего.
        const known = fieldLabel(row.table, item.field);
        const label = known ? `${known} (${item.field})` : item.field;
        if (item.level === 'fact') return `${label}: изменено, значение не записано`;
        const before = value(item.beforeTitle, item.before);
        const after = value(item.afterTitle, item.after);
        return `${label}: ${before} → ${after}`;
    });
    return head.concat(lines).join('\n');
}

function value(title, raw) {
    if (title) return title;
    if (raw === null || raw === undefined || raw === '') return 'пусто';
    return String(raw);
}

// Имя файла называет период: три файла с именем «Журнал.xlsx» в папке загрузок
// неразличимы, а разбираются они обычно не в тот же день.
function fileName(filters) {
    const from = filters && filters.from ? filters.from : '';
    const to = filters && filters.to ? filters.to : '';
    const period = from && to && from !== to ? `${from}—${to}` : (from || to || '');
    return period ? `Журнал изменений ${period}.xlsx` : 'Журнал изменений.xlsx';
}

function dateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
