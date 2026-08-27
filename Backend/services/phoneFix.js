// --- services/phoneFix.js: номер лида при записи и его разбор (часть 4) ---
//
// Один модуль на все точки входа (Б1.6): создание лида, правка в карточке,
// правка из кабинета оператора, массовая загрузка, поиск. Приведение живёт в
// phoneFormat.js, здесь — что из него следует для КОЛОНОК лида: приведён ли
// номер, по какой причине не разобрался, что было в строке до правки и не
// затирает ли запись вердикт, который вынес человек.
//
// Зачем отдельно от phoneFormat.js: там чистое правило, которое можно вызвать
// откуда угодно и проверить без базы. Здесь нужна база — справочник причин.

const { normalizePhone } = require('./phoneFormat');

// Карта «код причины → её номер в справочнике». Ищется один раз и кешируется:
// справочник константный, при жизни процесса не меняется. (Прежде здесь стояла
// ссылка на findNoAnswerStatusId в leadCallRules.js — та функция снята вместе с
// переездом автоперезвона в настройку, часть 9, заход 2.)
let reasonCache = null;

async function reasonIdByCode(db, code) {
    if (reasonCache === null) {
        const result = await db.query('SELECT id, code FROM phone_fix_reasons');
        reasonCache = new Map(result.rows.map((r) => [r.code, r.id]));
    }
    return reasonCache.get(code) || null;
}

// Что записать в колонки лида при сохранении номера.
//
// current — то, что лежит в базе сейчас: { phone, phone_raw, phone_fix_verdict }.
// Для создания лида передаётся null.
//
// ТРИ ПРАВИЛА, И КАЖДОЕ ИЗ НИХ — ОТВЕТ НА КОНКРЕТНЫЙ СЛУЧАЙ:
//
// 1. Исходная строка не перетирается никогда (COALESCE). Она хранится
//    бессрочно (паспорт Р10): человек, глядя на исправленный номер, должен
//    видеть, что пришло на самом деле. Второй раз её пишет только тот, у кого
//    её ещё нет.
// 2. Номер, который человек исправил и который теперь приводится, получает
//    вердикт «исправлен» — и уходит из разбора в состояние «Исправленные».
//    Ставится он ТОЛЬКО если строка в разборе была: у обычной правки телефона
//    вердикта не появляется, разбора не было.
// 3. Номер, который не разобрался, встаёт в разбор с вердиктом «на разборе» —
//    но не сбрасывает вердикт, уже вынесенный человеком, если номер не менялся.
//    Иначе сохранение карточки по любой другой причине стирало бы «Проверено».
async function phoneColumnsFor(db, rawValue, current) {
    const result = normalizePhone(rawValue);
    const previousPhone = current ? current.phone : null;
    const previousVerdict = current ? current.phone_fix_verdict : null;
    const hadRaw = current ? current.phone_raw : null;
    const phoneChangedByHand = previousPhone !== null && previousPhone !== String(rawValue == null ? '' : rawValue).trim();

    if (result.reason === null) {
        // Разобрался. Исходную строку запоминаем, только если приведение её
        // изменило: у номера, который и так лежал в формате, «исходной строки»
        // не существует.
        const verdict = previousVerdict && previousVerdict !== 'fixed' ? 'fixed' : previousVerdict;
        return {
            phone: result.phone,
            phone_raw: hadRaw || (result.changed ? String(rawValue).trim() : null),
            phone_normalized: true,
            phone_fix_reason_id: null,
            phone_fix_verdict: verdict === 'fixed' ? 'fixed' : null,
            fixedNow: verdict === 'fixed'
        };
    }

    const keepVerdict = !phoneChangedByHand && previousVerdict && previousVerdict !== 'pending';
    return {
        phone: result.phone,
        phone_raw: hadRaw || String(rawValue == null ? '' : rawValue).trim(),
        phone_normalized: false,
        phone_fix_reason_id: await reasonIdByCode(db, result.reason),
        phone_fix_verdict: keepVerdict ? previousVerdict : 'pending',
        fixedNow: false
    };
}

// Живой лид с таким же номером. Слитые в поиск не попадают: у них номер тот же,
// что у старшего, и «дубль» с ними означал бы, что человека нельзя завести
// заново после слияния.
async function findLeadByPhone(db, phone, exceptId) {
    const params = [phone];
    let sql = `SELECT id, last_name, first_name, middle_name
                 FROM leads
                WHERE phone = $1 AND merged_into_id IS NULL`;
    if (exceptId !== undefined && exceptId !== null) {
        params.push(exceptId);
        sql += ' AND id <> $2';
    }
    const result = await db.query(sql + ' ORDER BY id LIMIT 1', params);
    return result.rows[0] || null;
}

// Имя найденного лида для сообщения о дубле: «Номер уже у Иванова И.» — искать
// глазами по всем карточкам человек не должен (тот же довод, что у занятого
// внутреннего номера в части 2).
function leadTitle(row) {
    if (!row) return '';
    const parts = [row.last_name, row.first_name, row.middle_name].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'без имени';
}

function resetReasonCache() {
    reasonCache = null;
}

module.exports = {
    phoneColumnsFor,
    findLeadByPhone,
    leadTitle,
    reasonIdByCode,
    resetReasonCache
};
