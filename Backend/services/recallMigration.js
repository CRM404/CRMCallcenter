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

const { fetchAutoRecallRules, fetchRecallWindow } = require('./callEvents');
const { nextAutoRecallAt } = require('./appTime');

const MIGRATION_ID = '2026-08-28-recall-recalc';
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
 * Сам проход. Одной транзакцией и одной партией: правка сотни лидов — это одно
 * действие, и в журнале оно обязано читаться как одно.
 *
 * Автор — служебный: у старта сервера нет запроса и некому называться. Без него
 * журнал показал бы «не указан», то есть правку из админки, которой никто не
 * делал (решение владельца 98).
 */
async function recalcAll(client, rules, window) {
    const byStatus = new Map(rules.map((r) => [r.funnelStatusId, r]));

    await client.query('BEGIN');
    try {
        const batch = await client.query(
            `INSERT INTO audit_batches (id, kind, title, actor_kind, actor_name)
             VALUES (gen_random_uuid(), 'migration', $1, 'service', 'Миграция')
             RETURNING id`,
            [BATCH_TITLE]
        );
        await client.query(
            `SELECT set_config('crm.audit_batch', $1, false),
                    set_config('crm.audit_actor_kind', 'service', false),
                    set_config('crm.audit_actor_name', 'Миграция', false),
                    set_config('crm.audit_actor_id', '', false),
                    set_config('crm.audit_page', '', false)`,
            [batch.rows[0].id]
        );

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
 * Разовый прогон. Зовётся после накатки схемы, рядом с приведением номеров.
 *
 * Возвращает то, что пойдёт в отчёт: три числа «до» и что стало с каждым
 * автоматическим перезвоном.
 */
async function runRecallRecalc(pool) {
    const client = await pool.connect();
    try {
        const done = await client.query('SELECT 1 FROM applied_migrations WHERE id = $1', [MIGRATION_ID]);
        if (done.rows.length > 0) return { skipped: 'уже выполнена' };

        const before = await countBySource(client);
        const window = await fetchRecallWindow(client);
        const rules = await fetchAutoRecallRules(client);
        if (!window || rules.length === 0) {
            // ЗАМОК НЕ СТАВИМ. Настройка ещё не заведена — пересчитывать не по
            // чему, и отметиться выполненным значило бы пропустить пересчёт
            // навсегда.
            console.warn('[перезвоны] Пересчёт отложен: событие «Автоперезвон» не годно к работе '
                + '(выключено, без окна или без строк). Замок не поставлен, попробуем на следующем старте.');
            return { before, skipped: 'событие не настроено' };
        }

        const stats = await recalcAll(client, rules, window);
        await client.query('INSERT INTO applied_migrations (id) VALUES ($1)', [MIGRATION_ID]);
        console.log(`[перезвоны] Пересчёт: было auto ${before.auto}, manual ${before.manual}, `
            + `без признака ${before.none}. Пересчитано ${stats.moved}, совпало ${stats.same}, `
            + `без правила ${stats.noRule}, без времени последнего звонка ${stats.noLastCall}.`);
        return { before, ...stats };
    } finally {
        client.release();
    }
}

module.exports = { runRecallRecalc, countBySource, MIGRATION_ID, BATCH_TITLE };
