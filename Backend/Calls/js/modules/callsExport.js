// --- Calls/js/modules/callsExport.js: выгрузка журнала звонков в Excel ------
//
// БИБЛИОТЕКА ТА ЖЕ, ЧТО У «ЛИДОВ», и второй копии не заводится: она переехала в
// общий слой (`Shell/vendor/xlsx.full.min.js`) подготовкой части 7. Грузится по
// требованию — 900 КБ не должны ехать при каждом открытии раздела ради кнопки,
// которую нажимают раз в день.
//
// В ФАЙЛ УХОДЯТ ВСЕ ЧЕТЫРНАДЦАТЬ ЛОГИЧЕСКИХ КОЛОНОК И ВСЯ ВЫБОРКА (ответ
// куратора И176), а не двенадцать видимых и не показанные тридцать. Настройка
// «Колонки» — про экран, где место кончается; файл уносят, чтобы иметь всё.
// Порция догрузки — свойство прокрутки, а не данных.
//
// ВНУТРЕННИЕ ЗВОНКИ В ФАЙЛ НЕ ПОПАДАЮТ (ответ куратора И159) — как и в
// счётчики. В списке они остаются: внутренний звонок это факт работы, скрывать
// его нельзя; портить им статистику дозвона — тоже.

const XLSX_URL = '/vendor/xlsx.full.min.js';

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

const OUTCOME_LABEL = {
    answered: 'ответили',
    busy: 'занято',
    no_answer: 'не ответили',
    cancelled: 'отменён',
    congestion: 'ошибка',
    unavailable: 'нет регистрации',
    lost: 'связь потеряна'
};

/**
 * Собирает и отдаёт файл.
 *
 * ТОСТА ОБ УСПЕХЕ НЕТ. Успех виден браузером — файл появляется в загрузках;
 * тост остаётся за отказом действия, которое человек запросил сам.
 */
export async function buildWorkbook(rows, filters) {
    await loadXlsx();

    const data = rows
        .filter((r) => !r.isInternal)
        .map((r) => ({
            'Когда': dateTime(r.startedAt),
            'Телефон лида': r.clientPhone || '',
            'Попытка': r.attemptNo === null || r.attemptNo === undefined ? '' : r.attemptNo,
            'Направление': r.direction === 'in' ? 'входящий' : 'исходящий',
            'Линия': r.lineType || '',
            'Оператор': r.operator || '',
            'Добавочный': r.operatorExtension || '',
            'Наш номер': r.ourNumber || '',
            'Исход по АТС': OUTCOME_LABEL[r.outcome] || r.outcome || '',
            // Сырая строка станции едет в файл отдельной колонкой: спор «чья
            // ошибка» решается ею, а на экране она была бы шумом.
            'Исход, строка АТС': r.outcomeRaw || '',
            'Был перевод': r.transferred ? 'да' : 'нет',
            // Пустая ячейка, а не «0:00»: разговора не было вовсе, и ноль здесь
            // означал бы «говорили ноль секунд».
            'Ожидание, с': numberOrBlank(r.waitSeconds),
            'Разговор, с': numberOrBlank(r.talkSeconds),
            'Статус воронки': r.funnelStatus || '',
            'Комментарий': r.notes || ''
        }));

    const sheet = XLSX.utils.json_to_sheet(data);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Звонки');
    XLSX.writeFile(book, fileName(filters));
}

// Имя файла НАЗЫВАЕТ ПЕРИОД. Три файла с именем «Звонки.xlsx» в папке загрузок
// неразличимы, а разбираются они обычно не в тот же день.
function fileName(filters) {
    const from = filters && filters.from ? filters.from : '';
    const to = filters && filters.to ? filters.to : '';
    const period = from && to && from !== to ? `${from}—${to}` : (from || to || '');
    return period ? `Звонки ${period}.xlsx` : 'Звонки.xlsx';
}

function numberOrBlank(value) {
    return value === null || value === undefined ? '' : value;
}

function dateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
