// --- services/recallMigration.js: пересчёт назначенных перезвонов (заход 7) ---
//
// ЛОВУШКА 7 НАРЯДА ЧАСТИ 9: смена настройки задевает лидов в полёте. До части 9
// интервал перезвона был константой в коде — час; теперь его задаёт руководитель
// строкой события, и у лидов, которым перезвон уже назначен, время осталось от
// старой константы. Разовая правка выравнивает их по сегодняшней настройке.
//
// ПОЧЕМУ НЕ В `schema.sql`, ГДЕ ЛЕЖАТ ОСТАЛЬНЫЕ РАЗОВЫЕ ПРАВКИ. Правило времени
// в проекте одно, и живёт оно в `services/appTime.js`: `nextAutoRecallAt` берёт
// интервал, сдвигает в рабочее окно и умеет окно через полночь. Написав его
// вторым разом на plpgsql, мы получили бы две реализации одного правила — они
// совпадают в день написания и расходятся в первый же день правки. Тот же
// довод, по которому в проекте уже живёт `services/phoneMigration.js`.
//
// ТРОГАЕТ ТОЛЬКО НАЗНАЧЕННЫЕ АВТОМАТОМ. `leads.next_call_source` завёл заход 1
// ровно ради этого различения:
//
//   'auto'   — назначила система, пересчитываем;
//   'manual' — время назвал клиент оператору, и наша настройка менять его не
//              вправе. Это не осторожность, а обещание, данное человеку;
//   NULL     — перезвона нет вовсе, пересчитывать нечего.
//
// СЧИТАЕТСЯ ОТ ПОСЛЕДНЕГО ЗВОНКА, А НЕ ОТ «СЕЙЧАС». Перезвон — это «через
// столько-то после попытки»; отсчитав от момента выкатки, мы отодвинули бы в
// будущее и того, кому звонить через пять минут, и сделали бы это молча.
//
// ⚠ ЧТО ДЕЛАЕТ МИГРАЦИЯ, КОГДА СЧИТАТЬ НЕ ПО ЧЕМУ. Событие выключено, окна нет,
// строки на этот статус нет, у лида нет времени последнего звонка — во всех
// четырёх случаях строка ПРОПУСКАЕТСЯ, а не выравнивается по умолчанию.
// Подставить сюда «час» значило бы вернуть ту самую константу, которую часть 9
// и убирала. Замок при этом НЕ СТАВИТСЯ, если событие не годно к работе вовсе:
// выкатка могла обогнать настройку, и пересчёт должен дождаться её, а не
// отметиться выполненным над пустотой.

// ⚠ К240. ПОЛОВИНА ПЕРВАЯ ЭТОГО ФАЙЛА — ЗАСЕВ ПРИЗНАКА, И БЕЗ НЕЁ ОСТАЛЬНОЕ НА
// БОЮ НЕ ДЕЛАЕТ НИЧЕГО. Колонку `next_call_source` заводит ЭТА ЖЕ выкатка и
// приезжает она пустой у всех до единого: пересчёт, который ищет `= 'auto'`,
// находил на боевой базе ноль строк — и ставил замок, то есть второго раза не
// было бы никогда. Поймано куратором на стенде, собранном как бой: вчерашняя
// схема с `main`, а не с моей ветки. Разница стенда и боя решила всё.
//
// РАЗЛИЧИТЬ СТАРЫХ МОЖНО, И НЕ ГАДАНИЕМ. До части 9 время перезвона писали ровно
// два пути, и оба видны по статусу, на котором лид стоит
// (`services/leadCallRules.js` на `main`):
//
//   `auto_recall`        — «через час» назначила система: наше время, наше и
//                          право пересчитать;
//   `requires_call_time` — время назвал клиент оператору: обещание человеку,
//                          настройка его менять не вправе.
//
// ⚠ ДА, `auto_recall` СЕГОДНЯ НЕ РЕШАЕТ НИЧЕГО — решает строка события (заход 2).
// Читается он здесь именно поэтому: разметить надо ПРОШЛОЕ, а в прошлом решал
// он. Спросить сегодняшнюю настройку значило бы разметить вчерашние времена
// сегодняшним правилом — и ошибиться ровно у тех статусов, которым настройку с
// тех пор поменяли.
//
// ПОРЯДОК ПРОВЕРКИ ФЛАГОВ ПОВТОРЯЕТ ПРЕЖНИЙ КОД ДОСЛОВНО: сначала `auto_recall`,
// потом `requires_call_time`. Так ветвился `resolveCallStatusEffects` на `main`,
// и статус с обоими флагами писал время автоматом. Выбрать здесь другой порядок
// значило бы разметить прошлое не тем правилом, по которому оно случилось.
//
// ОСТАЛЬНЫМ УМОЛЧАНИЕ НЕ ПОДСТАВЛЯЕТСЯ. Лид с назначенным перезвоном, чей статус
// не несёт ни одного из флагов (например, время досталось ему слиянием), после
// засева остаётся без признака — и ЧИСЛО ТАКИХ НАЗЫВАЕТСЯ В ОТЧЁТЕ. Сплошное
// «всем auto» стёрло бы разницу между «мы знаем» и «мы предположили», а цена
// ошибки здесь — переставленное обещание клиенту.

const { fetchAutoRecallRules, fetchRecallWindow } = require('./callEvents');
const { nextAutoRecallAt } = require('./appTime');

const SEED_ID = '2026-08-28-recall-source-seed';
const SEED_TITLE = 'Засев признака назначенного перезвона';

// ⚠ ЗАМОК ПЕРЕСЧЁТА ПЕРЕИМЕНОВАН, И ЭТО НЕ КОСМЕТИКА. Прежний
// (`2026-08-28-recall-recalc`) мог успеть встать там, где пересчёт шёл по пустой
// колонке — то есть отметить выполненным прогон, который никого не тронул.
// Держать по такой отметке настоящий прогон нельзя: замок обязан сторожить
// сделанную работу, а не попытку. Там, где прежний прогон был настоящим, второй
// проход безвреден — счёт идёт от времени последнего звонка, и совпавшие строки
// он так и называет совпавшими.
const MIGRATION_ID = '2026-08-28-recall-recalc-seeded';
const BATCH_TITLE = 'Пересчёт назначенных перезвонов';

/**
 * Три числа «до»: сколько лидов в каждом состоянии признака.
 *
 * ВСЕ ТРИ ИДУТ В ОТЧЁТ, а не только затронутые. «Ручных ноль» — это тоже
 * результат: он говорит, что правило «руками назначенное не трогаем» на бою не
 * проверено ни разу, и знать это надо до выкатки, а не после.
 */
async function countBySource(db) {
    const result = await db.query(
        `SELECT COALESCE(next_call_source, 'none') AS source, count(*)::int AS n
           FROM leads
          WHERE next_call_at IS NOT NULL OR next_call_source IS NOT NULL
          GROUP BY 1`
    );
    const counts = { auto: 0, manual: 0, none: 0 };
    result.rows.forEach((r) => { counts[r.source] = r.n; });
    return counts;
}

/**
 * Зачин у обеих правок один: своя партия в журнале и служебный автор. Вынесен,
 * чтобы вторая не завела вторую редакцию того же — разошлись бы они не в день
 * написания, а в первый же день правки, и в журнале это выглядело бы как две
 * разные по природе миграции.
 *
 * Автор служебный: у старта сервера нет запроса и некому называться. Без него
 * журнал показал бы «не указан», то есть правку из админки, которой никто не
 * делал (решение владельца 98).
 */
async function openMigrationBatch(client, title) {
    const batch = await client.query(
        `INSERT INTO audit_batches (id, kind, title, actor_kind, actor_name)
         VALUES (gen_random_uuid(), 'migration', $1, 'service', 'Миграция')
         RETURNING id`,
        [title]
    );
    await client.query(
        `SELECT set_config('crm.audit_batch', $1, false),
                set_config('crm.audit_actor_kind', 'service', false),
                set_config('crm.audit_actor_name', 'Миграция', false),
                set_config('crm.audit_actor_id', '', false),
                set_config('crm.audit_page', '', false)`,
        [batch.rows[0].id]
    );
    return batch.rows[0].id;
}

/**
 * Засев признака (К240). Первый из двух проходов, и порядок обязателен: пересчёт
 * читает то, что записал засев.
 *
 * ЗАМОК КЛАДЁТСЯ ВНУТРЬ ТРАНЗАКЦИИ, а не рядом: работа и отметка о ней обязаны
 * быть одним действием. Разорвав их, мы получили бы отметку без работы при
 * падении между ними — а это ровно та беда, из-за которой К240 и появился.
 *
 * ЧИСЛА СЧИТАЮТСЯ ПО ФАКТУ ЗАПИСИ, А НЕ ПО ЗАМЫСЛУ: `RETURNING` отдаёт то, что
 * в строку легло. Посчитать заранее «сколько подходит под условие» значило бы
 * назвать в отчёте число из другого запроса, чем тот, который правил базу.
 */
async function seedRecallSource(client) {
    const done = await client.query('SELECT 1 FROM applied_migrations WHERE id = $1', [SEED_ID]);
    if (done.rows.length > 0) return { skipped: 'уже выполнен' };

    await client.query('BEGIN');
    try {
        await openMigrationBatch(client, SEED_TITLE);

        const marked = await client.query(
            `WITH marked AS (
                 UPDATE leads l
                    SET next_call_source = CASE WHEN s.auto_recall THEN 'auto' ELSE 'manual' END,
                        updated_at = NOW()
                   FROM lead_funnel_statuses s
                  WHERE s.id = l.funnel_status_id
                    AND l.next_call_at IS NOT NULL
                    AND l.next_call_source IS NULL
                    AND (s.auto_recall OR s.requires_call_time)
                RETURNING l.next_call_source AS source
             )
             SELECT source, count(*)::int AS n FROM marked GROUP BY 1`
        );
        const stats = { auto: 0, manual: 0, left: 0 };
        marked.rows.forEach((r) => { stats[r.source] = r.n; });

        // Остаток считается ПОСЛЕ правки и по всей таблице: это и есть ответ на
        // вопрос «кого мы не смогли разметить», а не «кого не тронули сейчас».
        const left = await client.query(
            `SELECT count(*)::int AS n FROM leads
              WHERE next_call_at IS NOT NULL AND next_call_source IS NULL`
        );
        stats.left = left.rows[0].n;

        await client.query('INSERT INTO applied_migrations (id) VALUES ($1)', [SEED_ID]);
        await client.query('COMMIT');
        return stats;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
}

/**
 * Сам проход. Одной транзакцией и одной партией: правка сотни лидов — это одно
 * действие, и в журнале оно обязано читаться как одно.
 */
async function recalcAll(client, rules, window) {
    const byStatus = new Map(rules.map((r) => [r.funnelStatusId, r]));

    await client.query('BEGIN');
    try {
        await openMigrationBatch(client, BATCH_TITLE);

        const rows = await client.query(
            `SELECT id, funnel_status_id, last_call_at, next_call_at
               FROM leads
              WHERE next_call_source = 'auto' AND next_call_at IS NOT NULL
              ORDER BY id`
        );

        const stats = { seen: rows.rows.length, moved: 0, same: 0, noRule: 0, noLastCall: 0 };
        for (const row of rows.rows) {
            const rule = byStatus.get(row.funnel_status_id);
            if (!rule) { stats.noRule++; continue; }
            if (!row.last_call_at) { stats.noLastCall++; continue; }

            const when = nextAutoRecallAt(new Date(row.last_call_at), rule.intervalMinutes, window);
            // Сравнение по миллисекундам, а не по строкам: одна и та же секунда
            // приезжает из базы и из расчёта в разных представлениях.
            if (new Date(row.next_call_at).getTime() === when.getTime()) { stats.same++; continue; }
            // eslint-disable-next-line no-await-in-loop
            await client.query('UPDATE leads SET next_call_at = $1, updated_at = NOW() WHERE id = $2',
                [when, row.id]);
            stats.moved++;
        }

        await client.query('COMMIT');
        return stats;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
}

/**
 * Разовый прогон, теперь из двух проходов. Зовётся после накатки схемы, рядом с
 * приведением номеров.
 *
 * Возвращает то, что пойдёт в отчёт: три числа «до», итог засева признака и что
 * стало с каждым автоматическим перезвоном.
 */
async function runRecallRecalc(pool) {
    const client = await pool.connect();
    try {
        // ТРИ ЧИСЛА «ДО» СНИМАЮТСЯ ПЕРВЫМИ — до засева, иначе они описывали бы
        // не бой, а результат собственной правки.
        const before = await countBySource(client);

        // ЗАСЕВ ИДЁТ ДО ПРОВЕРКИ ЗАМКА ПЕРЕСЧЁТА и не зависит от неё: у него
        // свой замок и своя причина существовать. Пересчёт может быть отложен
        // (событие не настроено) — разметка от этого не перестаёт быть верной.
        const seed = await seedRecallSource(client);
        if (!seed.skipped) {
            console.log('[перезвоны] Признак назначенного перезвона засеян: '
                + `автоматических ${seed.auto}, назначенных руками ${seed.manual}. `
                + `Осталось с назначенным перезвоном и без признака: ${seed.left}`
                + (seed.left > 0
                    ? ' — у их статуса нет ни строки автоперезвона, ни признака «нужно время»; '
                      + 'пересчёт их не тронет, и умолчание им не подставлено.'
                    : '.'));
        }

        const done = await client.query('SELECT 1 FROM applied_migrations WHERE id = $1', [MIGRATION_ID]);
        if (done.rows.length > 0) return { before, seed, skipped: 'уже выполнена' };

        const window = await fetchRecallWindow(client);
        const rules = await fetchAutoRecallRules(client);
        if (!window || rules.length === 0) {
            // ЗАМОК НЕ СТАВИМ. Настройка ещё не заведена — пересчитывать не по
            // чему, и отметиться выполненным значило бы пропустить пересчёт
            // навсегда.
            console.warn('[перезвоны] Пересчёт отложен: событие «Автоперезвон» не годно к работе '
                + '(выключено, без окна или без строк). Замок не поставлен, попробуем на следующем старте.');
            return { before, seed, skipped: 'событие не настроено' };
        }

        const stats = await recalcAll(client, rules, window);
        await client.query('INSERT INTO applied_migrations (id) VALUES ($1)', [MIGRATION_ID]);
        console.log(`[перезвоны] Пересчёт: было auto ${before.auto}, manual ${before.manual}, `
            + `без признака ${before.none}. Пересчитано ${stats.moved}, совпало ${stats.same}, `
            + `без правила ${stats.noRule}, без времени последнего звонка ${stats.noLastCall}.`);
        return { before, seed, ...stats };
    } finally {
        client.release();
    }
}

module.exports = {
    runRecallRecalc, countBySource, seedRecallSource,
    MIGRATION_ID, BATCH_TITLE, SEED_ID, SEED_TITLE
};
