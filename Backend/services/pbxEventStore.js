// --- services/pbxEventStore.js: приём событий станции (этап Е1) --------------
//
// ЧТО ЗДЕСЬ ПРОИСХОДИТ. Станция шлёт на каждый звонок до полутора десятков
// сообщений: набрали, пошёл гудок, ответили, положили трубку. Здесь они
// СОХРАНЯЮТСЯ КАК ПРИШЛИ и разбираются в две наши таблицы — звонок и участки.
//
// ⚠⚠ ДВЕ ТАБЛИЦЫ, А НЕ ТРИ, И НЕ ТЕ, ЧТО НАЗЫВАЕТ НАРЯД. И наряд, и план говорят
// «разбор в `calls` и `call_events`». `call_events` — НЕ события звонков: это
// таблица НАСТРОЕК из трёх строк, которые правит руководитель (`auto_recall`,
// `transfer`, `wrapup`). Предупреждение об этой ловушке стоит в самой схеме,
// рядом с таблицей, написанное заранее. Разбор идёт в `calls` + `call_segments`,
// ровно как требует раздел 4.1 плана: звонок — это разговор с клиентом, участок
// — кто из операторов сколько в нём говорил.
//
// ⚠⚠ СЫРОЕ ХРАНИТСЯ ВСЕГДА И ПЕРВЫМ, ДАЖЕ ЕСЛИ РАЗБОР НЕ УДАЛСЯ. Когда цифра в
// журнале не сойдётся, сырое сообщение — единственный способ доказать, чья
// ошибка, наша или станции (план 7.5). Разбор можно переписать и прогнать
// заново; несохранённое сообщение не восстанавливается ничем.
//
// ⚠ ЕДИНИЦЫ БЕРУТСЯ ГОТОВЫМИ — `services/pbxTime.js`. Своего преобразования
// здесь нет ни одного: микросекунды и UTC-строки приводятся В ОДНОМ МЕСТЕ, иначе
// расхождение на три часа ищут по всему разбору.

const pbxTime = require('./pbxTime');

// ---------------------------------------------------------------- поля события
//
// ⚠ ИМЕНА ВЗЯТЫ ИЗ ПАСПОРТА ДОСЛОВНО, а не придуманы по смыслу. Станция шлёт
// `application/x-www-form-urlencoded` — и при GET, и при POST, — поэтому поля
// приходят строками, и «0» от отсутствия отличается только явной проверкой.
//
// ⚠ ЧИТАЕМ БЕЗ ОГЛЯДКИ НА РЕГИСТР. Документация называет `EventType`, но регистр
// в подобных полях — первое, что расходится между версиями станции; а цена
// ошибки здесь не «поле пусто», а «звонок не записан вовсе». Сырое сообщение при
// этом лежит целиком, так что даже полный промах разбора обратим.
function reader(body) {
    const byLower = new Map();
    for (const [key, value] of Object.entries(body || {})) {
        byLower.set(String(key).toLowerCase(), value);
    }
    return (name) => {
        const raw = byLower.get(String(name).toLowerCase());
        if (raw === undefined || raw === null) return null;
        const text = String(raw).trim();
        return text === '' ? null : text;
    };
}

// Станция отвечает «yes»/«no». Всё, что не «yes», считаем «нет»: признак
// утвердительный, и придумывать за станцию третье значение не нам.
const isYes = (value) => String(value || '').trim().toLowerCase() === 'yes';

// ---------------------------------------------------------------- исход
//
// ПЕРЕЧЕНЬ ЗАКРЫТ ОГРАНИЧЕНИЕМ В СХЕМЕ, и соответствие берётся из паспорта
// (раздел «Статусы завершения вызова»). ⚠ Седьмой наш исход — `lost` — станцией
// не присылается вовсе: его ставит сторож зависших, и здесь ему взяться неоткуда.
const OUTCOME_BY_STATUS = {
    ANSWER: 'answered',
    BUSY: 'busy',
    NOANSWER: 'no_answer',
    CANCEL: 'cancelled',
    CONGESTION: 'congestion',
    CHANUNAVAIL: 'unavailable'
};

// ⚠ НЕИЗВЕСТНЫЙ СТАТУС НЕ ПОДГОНЯЕТСЯ ПОД ЗНАКОМЫЙ. Станция может завести
// седьмое слово; записать его как «не ответили» значит соврать в отчёте. Наш
// перечень остаётся пустым, а `outcome_raw` хранит сказанное станцией дословно —
// ради этого он и заведён (ответ куратора И161).
function mapOutcome(status) {
    if (!status) return null;
    return OUTCOME_BY_STATUS[String(status).trim().toUpperCase()] || null;
}

// ---------------------------------------------------------------- разбор
//
// ⚠ ВНУТРЕННИЙ ЗВОНОК ЗАПИСЫВАЕТСЯ, А НЕ ОТБРАСЫВАЕТСЯ, И ЭТО РАСХОЖДЕНИЕ С
// ПАСПОРТОМ, НАЗВАННОЕ ВСЛУХ. Паспорт Телфина велит «локальные звонки
// отбрасывать»; решение владельца 33 говорит обратное: «внутренний звонок
// записывается, но не считается» — это факт работы, и скрывать его нельзя, а
// портить им процент дозвона нельзя тоже. Слово владельца сильнее документации
// поставщика; признак `is_internal` для того и заведён.
function parse(body) {
    const get = reader(body);

    const eventType = get('EventType');
    const callId = get('CallID');
    const subCallId = get('SubCallID');

    // ⚠ ВРЕМЯ СОБЫТИЯ — В МИКРОСЕКУНДАХ. Прочитанное как миллисекунды даёт
    // 58 271 год; приведение — единственное, в `services/pbxTime.js`.
    const eventAt = pbxTime.fromMicros(get('EventTime'));

    const callerExt = get('CallerExtension');
    const calledExt = get('CalledExtension');
    const remote = get('RemoteNumber');

    // Оба конца внутренние и внешнего номера нет — это разговор оператора с
    // оператором. Исключение паспорта: при наличии `RemoteNumber` вызов берётся
    // в обработку, и номером клиента считается он.
    const isInternal = Boolean(callerExt && calledExt && !remote);

    const flow = String(get('CallFlow') || '').trim().toLowerCase();
    const direction = flow === 'in' ? 'in' : 'out';

    // НОМЕР КЛИЕНТА И НАШ НОМЕР ЗАВИСЯТ ОТ НАПРАВЛЕНИЯ. У входящего клиент —
    // тот, кто звонил; у исходящего — тот, кому звонили. `RemoteNumber`, если он
    // есть, старше обоих: паспорт называет его номером клиента прямо.
    const clientPhone = remote || (direction === 'in' ? get('CallerIDNum') : get('CalledNumber'));
    const ourNumber = get('CalledDID') || (direction === 'in' ? get('CalledNumber') : get('CallerIDNum'));

    const status = get('CallStatus');

    return {
        eventType,
        callId,
        subCallId,
        eventAt,
        isInternal,
        direction,
        clientPhone,
        ourNumber,
        status,
        outcome: mapOutcome(status),
        // Добавочный оператора — тот конец, который внутренний.
        operatorExtension: direction === 'in' ? calledExt : callerExt,
        operatorExtensionId: direction === 'in' ? get('CalledExtensionID') : get('CallerExtensionID'),
        apiId: get('CallAPIID'),
        callbackId: get('CallBackID'),
        recordId: get('RecID'),
        bridged: isYes(get('Bridged')),
        transferred: isYes(get('Transfered')),
        durationSeconds: pbxTime.durationSeconds(get('Duration')),
        talkSeconds: pbxTime.durationSeconds(get('BridgedDuration')),
        tag: get('Tag')
    };
}

// ---------------------------------------------------------------- сырое
//
// ⚠ `event_at` У ТАБЛИЦЫ NOT NULL, А У СОБЫТИЯ ВРЕМЯ МОЖЕТ НЕ ПРИЙТИ. Тогда
// берётся время приёма — и это названо здесь, потому что молча подставленное
// время выглядит как время станции. Отличить одно от другого можно: у такого
// события `event_at` совпадает с `received_at` до миллисекунды.
async function storeRaw(db, body, parsed) {
    const at = parsed.eventAt || new Date();
    const saved = await db.query(
        `INSERT INTO pbx_events (event_at, event_type, pbx_call_id, pbx_sub_call_id, payload)
         VALUES ($1::timestamptz, $2, $3, $4, $5::jsonb)
         RETURNING id`,
        [at, parsed.eventType, parsed.callId, parsed.subCallId, JSON.stringify(body || {})]
    );
    return saved.rows[0].id;
}

// ---------------------------------------------------------------- звонок
//
// РЕГИСТРАЦИЯ ИДЁТ ПО `hangup`, И ЭТО НЕ ВЫБОР УДОБСТВА. Документация диктует
// порядок разбора прямо: «регистрировать вызовы по `hangup` + `SubCallID`, а не
// по `CallID`» — один `CallID` содержит несколько плеч, и считать плечо звонком
// значит превратить один разговор в три.
//
// ⚠ СКЛЕЙКА ПО КОРНЮ ВЫЗОВА. Звонок ищется по `pbx_call_id`: у перевода два
// плеча и один корень, и второе плечо обязано лечь участком к тому же звонку, а
// не завести второй.
async function upsertCall(db, parsed) {
    const found = await db.query(
        'SELECT id, answered, transferred FROM calls WHERE pbx_call_id = $1 LIMIT 1',
        [parsed.callId]
    );

    const answered = parsed.outcome === 'answered' || (parsed.talkSeconds || 0) > 0;

    if (found.rows.length === 0) {
        const created = await db.query(
            `INSERT INTO calls
                (pbx_call_id, pbx_api_id, pbx_callback_id, direction,
                 our_number, client_phone, operator_extension,
                 outcome, outcome_raw, answered, transferred, is_internal,
                 started_at, ended_at, wait_seconds, talk_seconds, record_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     $13::timestamptz, $14::timestamptz, $15, $16, $17)
             RETURNING id`,
            [parsed.callId, parsed.apiId, parsed.callbackId, parsed.direction,
                parsed.ourNumber, parsed.clientPhone, parsed.operatorExtension,
                parsed.outcome, parsed.status, answered, parsed.transferred, parsed.isInternal,
                // Начало считается назад от конца: станция присылает общую
                // длительность вызова, а отдельного времени начала в событии
                // `hangup` нет. Нет длительности — нет и начала, врать нечем.
                startedAt(parsed), parsed.eventAt,
                waitSeconds(parsed), parsed.talkSeconds, parsed.recordId]
        );
        return { id: created.rows[0].id, created: true };
    }

    const row = found.rows[0];
    // ⚠ ВТОРОЕ ПЛЕЧО НЕ ПЕРЕПИСЫВАЕТ ЗВОНОК ЦЕЛИКОМ. Оно может добавить факт
    // (разговор состоялся, был перевод, появилась запись) и обязано продлить
    // конец, но не имеет права стереть уже известное: `COALESCE` держит первое
    // непустое, а признаки складываются по «или».
    await db.query(
        `UPDATE calls SET
            pbx_api_id = COALESCE(pbx_api_id, $2),
            pbx_callback_id = COALESCE(pbx_callback_id, $3),
            our_number = COALESCE(our_number, $4),
            client_phone = COALESCE(client_phone, $5),
            outcome = COALESCE(outcome, $6),
            outcome_raw = COALESCE(outcome_raw, $7),
            answered = answered OR $8,
            transferred = transferred OR $9,
            ended_at = GREATEST(COALESCE(ended_at, $10::timestamptz), $10::timestamptz),
            talk_seconds = COALESCE(talk_seconds, 0) + COALESCE($11, 0),
            record_id = COALESCE(record_id, $12),
            updated_at = NOW()
          WHERE id = $1`,
        [row.id, parsed.apiId, parsed.callbackId, parsed.ourNumber, parsed.clientPhone,
            parsed.outcome, parsed.status, answered, parsed.transferred,
            parsed.eventAt, parsed.talkSeconds, parsed.recordId]
    );
    return { id: row.id, created: false };
}

// Начало вызова: конец минус общая длительность. Ни того, ни другого нет —
// возвращаем пусто, а не «сейчас»: выдуманное время хуже отсутствующего.
function startedAt(parsed) {
    if (!parsed.eventAt || parsed.durationSeconds === null) return null;
    return new Date(parsed.eventAt.getTime() - parsed.durationSeconds * 1000);
}

// Ожидание — это то, что не было разговором. Отрицательного не бывает: если
// станция прислала разговор длиннее вызова, верить надо ей, а не арифметике.
function waitSeconds(parsed) {
    if (parsed.durationSeconds === null) return null;
    const talk = parsed.talkSeconds || 0;
    return Math.max(0, parsed.durationSeconds - talk);
}

// ---------------------------------------------------------------- участок
//
// ⚠ УЧАСТОК — ЭТО ПЛЕЧО, И ЕГО МЕСТО В ЦЕПОЧКЕ СЧИТАЕТСЯ, А НЕ УГАДЫВАЕТСЯ.
// Уникальный индекс `(call_id, position)` не даст двум участкам встать под одним
// номером; порядковый берётся счётом уже записанных.
//
// ⚠ ПОВТОР ТОГО ЖЕ ПЛЕЧА НЕ ЗАВОДИТ ВТОРОЙ УЧАСТОК. Защиты от повторов у сырых
// сообщений в этом заходе нет (Г11, отдельная строка реестра) — но здесь она
// даётся даром: плечо у станции уникально, и достаточно спросить.
async function upsertSegment(db, callId, parsed) {
    if (!parsed.subCallId) return false;

    const exists = await db.query(
        'SELECT id FROM call_segments WHERE call_id = $1 AND pbx_sub_call_id = $2 LIMIT 1',
        [callId, parsed.subCallId]
    );
    if (exists.rows.length) return false;

    // Сотрудник ищется по добавочному — по тому же полю, которое проставляет
    // сверка при старте. Не нашёлся — участок всё равно пишется: «кто-то говорил
    // столько-то» полезнее, чем пустота, а привязать можно и позже.
    const employee = parsed.operatorExtension
        ? await db.query(
            'SELECT id FROM employees WHERE pbx_extension = $1 ORDER BY id LIMIT 1',
            [parsed.operatorExtension])
        : { rows: [] };

    const count = await db.query(
        'SELECT COUNT(*)::int AS n FROM call_segments WHERE call_id = $1', [callId]);

    await db.query(
        `INSERT INTO call_segments
            (call_id, position, pbx_sub_call_id, employee_id, operator_extension,
             started_at, ended_at, talk_seconds)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8)`,
        [callId, count.rows[0].n + 1, parsed.subCallId,
            employee.rows.length ? employee.rows[0].id : null,
            parsed.operatorExtension, startedAt(parsed), parsed.eventAt, parsed.talkSeconds]
    );
    return true;
}

// ---------------------------------------------------------------- вход
//
// ⚠⚠ ПОРЯДОК ЗДЕСЬ — ЧАСТЬ ЗАМЫСЛА, А НЕ ПОСЛЕДОВАТЕЛЬНОСТЬ СТРОК. Сырое
// сохраняется ПЕРВЫМ и вне транзакции разбора: упавший разбор не имеет права
// унести с собой сообщение, ради которого весь приём и делается.
//
// ⚠ РАЗБОР ИДЁТ ТОЛЬКО ПО `hangup`. Остальные события (`dial-in`, `dial-out`,
// `answer`) сохраняются сырыми и в `calls` не идут: живая картина разговоров —
// это Е3, и строить её сейчас значило бы заводить незаконченное состояние,
// которое некому закрыть.
async function accept(db, body) {
    const parsed = parse(body);
    const rawId = await storeRaw(db, body, parsed);

    const isHangup = String(parsed.eventType || '').trim().toLowerCase() === 'hangup';
    if (!isHangup || !parsed.callId) {
        return { rawId, parsedFields: Object.keys(body || {}).length, registered: false };
    }

    const call = await upsertCall(db, parsed);
    const segment = await upsertSegment(db, call.id, parsed);
    return {
        rawId,
        parsedFields: Object.keys(body || {}).length,
        registered: true,
        callCreated: call.created,
        segmentCreated: segment
    };
}

module.exports = { accept, parse, mapOutcome };
