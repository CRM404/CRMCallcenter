// --- services/leadComments.js: лента комментариев лида (Б4.1–Б4.4) ---------
//
// Комментарий перестал быть полем. Раньше это была одна строка `leads.notes`,
// которая правится целиком: на втором звонке оператор видел старый текст и либо
// дописывал, либо стирал и писал заново — и сказанное в первый раз исчезало
// навсегда. Теперь каждая запись своя, со своим временем, автором и звонком.
//
// ЛЕНТА ТОЛЬКО РАСТЁТ. Ни правки, ни удаления записи здесь нет и не будет:
// правка задним числом — то же стирание, только медленнее, и след разговора
// перестал бы быть следом (паспорт Р3).
//
// СВОЕГО МАРШРУТА «ДОБАВИТЬ» У ЛЕНТЫ НЕТ. Запись уезжает вместе с карточкой,
// одной кнопкой «Сохранить»: вторая кнопка сохранения в той же карточке
// означала бы два разных «сохранить» рядом, и человек, нажавший не ту, потерял
// бы остальное заполненное.

const { shortName } = require('./employeeArchive');

/**
 * Лента одного лида целиком.
 *
 * ПОРЯДОК — СВЕЖИЕ СВЕРХУ, И ПЕРЕНЕСЁННАЯ ВСЕГДА ПОСЛЕДНЯЯ. Второе даётся
 * `NULLS LAST` даром: у перенесённой записи времени НЕТ вовсе, а не «время
 * переноса». Поставь мы туда момент переноса — она оказалась бы самой свежей и
 * встала бы первой, то есть ровно наоборот тому, что требует паспорт.
 *
 * ОТДАЁТСЯ ЦЕЛИКОМ, БЕЗ ПОРЦИЙ. Три видимые записи — правило ПОКАЗА, а не
 * порция запроса: кнопка «Показать все N» обязана назвать полное число, а
 * раскрытие происходит на месте, без второго обращения к серверу. Лента коротка
 * по устройству — это след разговоров с одним человеком, а не журнал.
 */
async function fetchForLead(db, leadId) {
    const found = await db.query(
        `SELECT c.id, c.body, c.created_at, c.is_migrated,
                c.author_employee_id,
                e.last_name, e.first_name, e.middle_name,
                call.id AS call_id, call.started_at AS call_started_at,
                call.talk_seconds, call.answered
           FROM lead_comments c
           LEFT JOIN employees e ON e.id = c.author_employee_id
           LEFT JOIN calls call ON call.id = c.call_id
          WHERE c.lead_id = $1
          ORDER BY c.created_at DESC NULLS LAST, c.id DESC`,
        [leadId]
    );
    return found.rows.map(toComment);
}

function toComment(r) {
    return {
        id: r.id,
        body: r.body,
        createdAt: r.created_at,
        isMigrated: r.is_migrated,
        // Автор — фамилия и инициалы, тем же форматированием, что у отказа по
        // занятому добавочному: две копии одного формата расходятся в первый же
        // день правки. Пусто — законный случай: правку из админки делать
        // некому, входа в проекте нет.
        author: r.author_employee_id === null ? null : {
            id: r.author_employee_id,
            name: shortName({
                last_name: r.last_name, first_name: r.first_name, middle_name: r.middle_name
            })
        },
        // Звонок — то, из чего экран собирает подпись «к звонку 16:04 · 4:12»
        // или «к звонку 10:15 · недозвон». Собирает ЭКРАН, а не сервер:
        // в карточке оператора это подпись, в карточке лида у руководителя
        // станет ссылкой, и готовая фраза с сервера мешала бы второму.
        call: r.call_id === null ? null : {
            id: r.call_id,
            startedAt: r.call_started_at,
            talkSeconds: r.talk_seconds,
            answered: r.answered
        }
    };
}

/**
 * Добавить запись. Зовётся ИЗ ТРАНЗАКЦИИ сохранения карточки — своей у ленты
 * нет: комментарий, записанный отдельно от карточки, пережил бы её откат.
 *
 * ПУСТУЮ ЗАПИСЬ НЕ ЗАВОДИМ, И МОЛЧА. Нажать «Сохранить» с пустым полем — это
 * обычное дело, а не попытка добавить пустой комментарий; отказ здесь был бы
 * придиркой к человеку, который просто ничего не написал.
 *
 * Возвращает `true`, если запись действительно завелась.
 */
async function add(db, { leadId, body, authorEmployeeId = null, callId = null }) {
    const text = body === null || body === undefined ? '' : String(body).trim();
    if (text === '') return false;
    await db.query(
        `INSERT INTO lead_comments (lead_id, body, author_employee_id, call_id)
         VALUES ($1, $2, $3, $4)`,
        [leadId, text, authorEmployeeId, callId]
    );
    return true;
}

module.exports = { fetchForLead, add };
