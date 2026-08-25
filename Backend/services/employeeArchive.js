// --- services/employeeArchive.js: вывод сотрудника из работы и возврат ---
//
// Решения владельца 70, 71 и 72; план 11.2; паспорт Р7 редакции 2.
//
// ГЛАВНОЕ, ЧТО НАДО ЗНАТЬ ПРО ЭТОТ ФАЙЛ: он НЕ трогает employees.status и не
// пытается его заменить. На условии status <> 'inactive' стоят две вещи,
// которые уже работают в бою, — освобождение добавочного (частичный индекс
// idx_employees_pbx_extension) и отзыв ключа туннеля (routes/employees.js). Обе
// сломались бы молча: номер остался бы занят за уволенным, а ключ —
// действующим. Новая колонка archive_kind отвечает ровно на один вопрос: что
// человек читает в карточке, «Уволен» или «Заморожен» (ответ куратора И80).
//
// ОБЕ ПОМЕТКИ ВЕДУТ СЕБЯ ОДИНАКОВО (решение владельца 70): добавочный
// освобождается, ключ отзывается, лиды открепляются. Отличается только слово и
// дата под ним. Заморозка не мягче увольнения — замороженный на полгода,
// который держал бы за собой очередь лидов, это худшее из двух (ответ
// куратора И89).

const auditContext = require('./auditContext');
const { queueCondition, findNewFunnelStatusId } = require('./leadDistribution');

const ARCHIVE_KINDS = ['dismissed', 'frozen'];

/** Фамилия с инициалами. Одна на весь проект — расходиться тут нечему. */
function shortName(row) {
    const initials = [row.first_name, row.middle_name]
        .filter(Boolean)
        .map((part) => `${String(part).trim().charAt(0).toUpperCase()}.`)
        .join(' ');
    return [row.last_name, initials].filter(Boolean).join(' ');
}

/**
 * Вид архива из запроса. Неизвестное значение — не молчаливое 'dismissed', а
 * null: подставить «Уволен» вместо непонятного слова значит уволить человека,
 * которого хотели заморозить, и никак об этом не сказать.
 */
function normalizeArchiveKind(value) {
    if (value === undefined || value === null) return null;
    const kind = String(value).trim();
    return ARCHIVE_KINDS.includes(kind) ? kind : null;
}

/**
 * Что записать в колонки архива при переходе.
 *
 * ВИД ПО УМОЛЧАНИЮ — 'dismissed' (ответ куратора И81). Требовать явного выбора
 * нельзя: массовое действие в таблице «Сотрудники» и старая карточка про новое
 * поле не знают и прислать его не могут, а сломать их в день выкатки — цена
 * несоразмерная. До сих пор это состояние и называлось увольнением.
 *
 * Дата заморозки СВОЯ, а не общая с termination_date: паспорт Р7 прямо говорит,
 * что колонка «Дата увольнения» у замороженного пустая (ответ куратора И79).
 * COALESCE — чтобы повторное сохранение уже архивной карточки не сдвигало дату,
 * она показана человеку.
 */
function archiveColumns(willBeArchived, requestedKind, current) {
    if (!willBeArchived) {
        return { archive_kind: null, frozen_at: null };
    }
    const kind = requestedKind || current.archive_kind || 'dismissed';
    return {
        archive_kind: kind,
        frozen_at: kind === 'frozen' ? (current.frozen_at || new Date()) : null
    };
}

/**
 * Открепление лидов — СРАЗУ (решение владельца 72), а не через полтора суток,
 * как это происходит с лидами ушедшего домой оператора (12 часов до закрытия
 * интервала плюс 2 часа удержания).
 *
 * Сбрасываются ДВЕ колонки и только они (ответ куратора И87): employee_id и
 * opened_at. next_call_at, last_call_at и call_attempts не трогаются — это
 * факты о клиенте, а не о том, кто им занимался. Стереть их значило бы забыть
 * обещание «перезвоню в четверг», данное человеку, которому уже позвонили.
 *
 * ОДНОЙ ПАРТИЕЙ, но БЕЗ employees в ней: сама правка карточки — обычное
 * действие человека и обязана читаться в журнале с его именем (паспорт Р7).
 * Открепление сорока лидов — следствие, которое сделала система; служебный
 * автор здесь честнее фамилии.
 */
async function detachLeads(pool, employeeId) {
    const pending = await pool.query(
        'SELECT id FROM leads WHERE employee_id = $1', [employeeId]);
    if (pending.rows.length === 0) return { detached: 0 };

    const result = await auditContext.runAsBatch(
        pool,
        { kind: 'detach', title: 'Открепление лидов при выводе из работы', actorName: 'Открепление лидов' },
        () => pool.query(
            `UPDATE leads SET employee_id = NULL, opened_at = NULL, updated_at = NOW()
              WHERE employee_id = $1 RETURNING id`, [employeeId]));
    return { detached: result.rows.length };
}

/**
 * Три числа, а не два (ответ куратора И88, правка паспорта Р7-5).
 *
 * Паспорт разводил лидов по флагу lead_funnel_statuses.releases_lead. Флаг
 * описывает, что делать ПОСЛЕ звонка, а не попадёт ли лид в раздачу, и очередь
 * берёт совсем другое условие. Честное деление:
 *
 *   now   — статус «Новый» или наступивший перезвон: попадут в раздачу сразу;
 *   later — перезвон назначен на будущее: придут сами, когда наступит время;
 *   none  — всё остальное: статус окончательный (решение владельца 75).
 *
 * Среднего случая в паспорте не было вовсе, а у работающего оператора он самый
 * частый — «Перезвон на завтра». Свалить его в любую из крайних значит соврать
 * человеку в окне, по которому он принимает решение.
 *
 * Условие очереди берётся из services/leadDistribution.js, а не пишется здесь
 * заново: две копии одного правила совпадают в день написания и расходятся в
 * первый же день правки, а расхождение будет выглядеть как «окно соврало».
 */
async function queueBuckets(db, employeeId) {
    const newStatusId = await findNewFunnelStatusId(db);
    if (newStatusId === null) {
        const all = await db.query(
            'SELECT count(*)::int AS n FROM leads WHERE employee_id = $1', [employeeId]);
        return { total: all.rows[0].n, now: 0, later: 0, none: all.rows[0].n };
    }
    const cond = queueCondition('l', '$2');
    const result = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE ${cond})::int AS now_count,
                count(*) FILTER (WHERE NOT (${cond})
                                   AND l.next_call_at IS NOT NULL AND l.next_call_at > NOW()
                                   AND l.merged_into_id IS NULL
                                   AND l.archived_at IS NULL)::int AS later_count
           FROM leads l WHERE l.employee_id = $1`,
        [employeeId, newStatusId]);
    const row = result.rows[0];
    return {
        total: row.total,
        now: row.now_count,
        later: row.later_count,
        none: row.total - row.now_count - row.later_count
    };
}

/**
 * Когда этот добавочный достался нынешнему владельцу.
 *
 * Отдельной колонки под это НЕТ и заводить её не нужно: журнал части 3 уже
 * хранит каждое изменение pbx_extension вместе с автором и временем. Завести
 * рядом вторую дату значило завести второй источник правды о том же событии —
 * и он разойдётся с журналом в первый же раз, когда номер поменяют мимо
 * карточки.
 *
 * Не нашли — возвращаем null и говорим «неизвестно». Выдумывать дату нельзя:
 * номер могли выдать до включения журнала (audit_started_at).
 */
async function extensionSince(db, employeeId, extension) {
    try {
        const result = await db.query(
            `SELECT changed_at FROM audit_log
              WHERE table_name = 'employees' AND record_id = $1
                AND changes @> $2::jsonb
              ORDER BY changed_at DESC LIMIT 1`,
            [String(employeeId), JSON.stringify([{ field: 'pbx_extension', after: String(extension) }])]);
        return result.rows[0] ? result.rows[0].changed_at : null;
    } catch (err) {
        // Дата — украшение отказа, а не его суть. Не смогли узнать — отказ всё
        // равно называет имя, ради которого он и нужен.
        console.error('Архив: не удалось узнать дату выдачи добавочного', err.message);
        return null;
    }
}

/** Кто держит этот добавочный сейчас. Условие то же, что у частичного индекса. */
async function extensionHolder(db, extension, exceptEmployeeId) {
    const value = String(extension || '').trim();
    if (!value) return null;
    const result = await db.query(
        `SELECT id, last_name, first_name, middle_name FROM employees
          WHERE pbx_extension = $1 AND status <> 'inactive' AND id <> $2 LIMIT 1`,
        [value, exceptEmployeeId || 0]);
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, fio: shortName(row), since: await extensionSince(db, row.id, value) };
}

/**
 * ЗАНЯТЫЕ добавочные, а не свободные (ответ куратора И92).
 *
 * Справочника номеров в базе нет, диапазон нигде не задан, и придумать его
 * нельзя: у разных станций он свой, а выдуманная граница «100–999» окажется
 * чужой в тот день, когда станцию настроят иначе. Поэтому отдаётся список
 * занятых, а подсказка поля говорит «любой номер, кроме этих».
 */
async function takenExtensions(db) {
    const result = await db.query(
        `SELECT pbx_extension, id, last_name, first_name, middle_name FROM employees
          WHERE pbx_extension IS NOT NULL AND btrim(pbx_extension) <> ''
            AND status <> 'inactive'
          ORDER BY pbx_extension`);
    return result.rows.map((r) => ({ extension: r.pbx_extension, employeeId: r.id, fio: shortName(r) }));
}

/**
 * Всё, что окну надо знать ДО действия. Одной точкой, потому что оба окна —
 * «вывести из работы» и «вернуть» — открываются из одной строки таблицы, и
 * второй запрос ради второго окна ничего не экономит.
 */
async function archivePreview(db, employeeId) {
    const found = await db.query(
        `SELECT id, last_name, first_name, middle_name, status, archive_kind,
                frozen_at, termination_date, pbx_extension
           FROM employees WHERE id = $1`, [employeeId]);
    if (found.rows.length === 0) return null;
    const emp = found.rows[0];
    const leads = await queueBuckets(db, employeeId);
    return {
        employeeId: emp.id,
        fio: shortName(emp),
        status: emp.status,
        archiveKind: emp.archive_kind,
        frozenAt: emp.frozen_at,
        terminationDate: emp.termination_date,
        // Сколько лидов открепится и во что они превратятся.
        leads: { detached: leads.total, queue: { now: leads.now, later: leads.later, none: leads.none } },
        // Для окна возврата: чей теперь его прежний добавочный.
        extension: {
            value: emp.pbx_extension,
            heldBy: await extensionHolder(db, emp.pbx_extension, emp.id)
        },
        extensionsTaken: await takenExtensions(db)
    };
}

module.exports = {
    ARCHIVE_KINDS,
    shortName,
    normalizeArchiveKind,
    archiveColumns,
    detachLeads,
    queueBuckets,
    extensionHolder,
    extensionSince,
    takenExtensions,
    archivePreview
};
