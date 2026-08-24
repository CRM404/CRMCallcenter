// --- services/phoneMigration.js: разовое приведение номеров (часть 4, Б1.2) ---
//
// ПОЧЕМУ НЕ В schema.sql, ГДЕ ЛЕЖАТ ВСЕ ОСТАЛЬНЫЕ РАЗОВЫЕ ПРАВКИ. Правила
// приведения обязаны быть в проекте ОДНИ (Б1.1). Написав их вторым разом на
// plpgsql, мы получили бы две реализации одного правила: они совпадают в день
// написания и расходятся в первый же день правки, а расхождение это —
// «миграция привела иначе, чем приводит форма», то есть номера, которые никто
// не сможет объяснить. Поэтому правила живут только в services/phoneFormat.js,
// а миграция ходит по строкам из приложения.
//
// Место вызова — там же, где проверка флагов статусов: сразу после
// runMigrations() в server.js. Прецедент проекта, шаг «после схемы» уже есть.
//
// ЗАМОК ТОТ ЖЕ, ЧТО У SQL-ПРАВОК: applied_migrations. Но одного замка мало, и
// вот почему (ответ куратора И67): перезапустить правку номеров мы можем
// захотеть сами, а к тому моменту человек уже вынесет вердикты на экране
// разбора. Поэтому правило жёстче замка: МИГРАЦИЯ ТРОГАЕТ ТОЛЬКО ТЕ СТРОКИ, ПО
// КОТОРЫМ ЧЕЛОВЕК ЕЩЁ НЕ ВЫСКАЗАЛСЯ. Вердикты «проверен», «безнадёжен» и
// «исправлен» не трогаются никогда, даже если приведение теперь дало бы
// результат.
//
// МИГРАЦИЯ НИЧЕГО НЕ ЧИНИТ И НЕ ВЫНОСИТ ВЕРДИКТОВ (ответ куратора И68).
// Строка «8 (916) 123-45-67 доб. 102» уходит в разбор с причиной «есть буквы» и
// ждёт человека. Пометить её «Проверено» может только он.

const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('./phoneFormat');

const MIGRATION_ID = '2026-08-24-phone-normalize';
const BATCH_TITLE = 'Приведение номеров к единому формату';

// Уникальность номера — среди ЖИВЫХ лидов, а не среди всех строк таблицы.
//
// Это не смягчение Б1.5, а единственная возможная его форма после решения И58.
// Слитый лид остаётся в базе с указателем на старшего, и номер у него тот же
// самый — он и был причиной слияния. Полный UNIQUE(phone) запретил бы само
// слияние, ради которого затевался: первая же пара дублей не сохранилась бы.
// «Один человек — один лид» выполняется там, где лид участвует в работе.
const UNIQUE_INDEX_SQL =
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_phone_unique ON leads (phone) WHERE merged_into_id IS NULL';

// Коммит, на котором работает приложение. Нужен заголовку выгрузки: файл,
// найденный через месяц, должен сам говорить, откуда он (ответ куратора И71).
// Читается из .git, потому что выкладка на бою — это git-перемотка
// (/usr/local/bin/crm-deploy.sh). Не вышло — так и пишем, а не выдумываем.
function currentCommit() {
    try {
        const gitDir = path.join(__dirname, '..', '..', '.git');
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref:')) return head.slice(0, 7);
        const ref = head.slice(4).trim();
        return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 7);
    } catch (err) {
        return 'неизвестен';
    }
}

async function reasonIdByCode(db) {
    const result = await db.query('SELECT id, code FROM phone_fix_reasons');
    const map = new Map();
    for (const row of result.rows) map.set(row.code, row.id);
    return map;
}

// Дубли по приведённому номеру среди живых лидов. Считаются ПОСЛЕ приведения:
// до него их не видно вовсе — ровно в этом и был смысл части (план 5.1).
async function findPhoneDuplicates(db) {
    const result = await db.query(
        `SELECT phone, count(*)::int AS n, array_agg(id ORDER BY created_at, id) AS ids
           FROM leads
          WHERE merged_into_id IS NULL
          GROUP BY phone
         HAVING count(*) > 1
          ORDER BY count(*) DESC, phone`
    );
    return result.rows;
}

// Уникальный индекс ставится ТОЛЬКО когда дублей не осталось, и это не
// осторожность, а единственный возможный порядок (ответ куратора И52):
// CREATE UNIQUE INDEX на существующих дублях просто не выполнится. Попытка
// повторяется при каждом старте — значит в день, когда человек разберёт
// последнюю пару, индекс встанет сам, без отдельной выкатки.
async function ensurePhoneUniqueIndex(pool) {
    const duplicates = await findPhoneDuplicates(pool);
    if (duplicates.length > 0) {
        const pairs = duplicates.slice(0, 5)
            .map((d) => d.phone + ' (лиды ' + d.ids.join(', ') + ')')
            .join('; ');
        console.error(
            '[телефон] Уникальность номера НЕ включена: повторяющихся номеров ' + duplicates.length +
            '. Разберите их слиянием — индекс встанет сам при следующем старте. Например: ' + pairs
        );
        return { created: false, duplicates: duplicates.length };
    }
    await pool.query(UNIQUE_INDEX_SQL);
    return { created: true, duplicates: 0 };
}

// Проход по лидам. ОДНОЙ ТРАНЗАКЦИЕЙ И ОДНОЙ ПАРТИЕЙ: пять тысяч правок — это
// одно действие, и в журнале оно обязано читаться как одно (Б2.10). Партия
// заводится здесь же, а не через services/auditContext.js, потому что автор у
// миграции не «кто назвался браузером», а служебный: у старта сервера нет
// запроса и некому называться.
async function normalizeAllLeads(client) {
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

        const reasons = await reasonIdByCode(client);
        // Только те, по которым человек ещё не высказался, — см. шапку.
        const rows = await client.query(
            `SELECT id, phone FROM leads
              WHERE phone_normalized = false
                AND (phone_fix_verdict IS NULL OR phone_fix_verdict = 'pending')
              ORDER BY id`
        );

        let changed = 0;
        let already = 0;
        let unresolved = 0;

        for (const row of rows.rows) {
            const result = normalizePhone(row.phone);
            if (result.reason === null) {
                // Исходная строка сохраняется ТОЛЬКО когда приведение её
                // изменило: у номера, который и так лежал в формате, «исходной
                // строки» не существует, и копия ничего не объясняет.
                await client.query(
                    `UPDATE leads
                        SET phone = $1,
                            phone_raw = CASE WHEN $2::boolean THEN $3 ELSE phone_raw END,
                            phone_normalized = true,
                            phone_fix_reason_id = NULL,
                            phone_fix_verdict = NULL,
                            updated_at = NOW()
                      WHERE id = $4`,
                    [result.phone, result.changed, row.phone, row.id]
                );
                if (result.changed) changed++; else already++;
            } else {
                await client.query(
                    `UPDATE leads
                        SET phone_raw = COALESCE(phone_raw, phone),
                            phone_normalized = false,
                            phone_fix_reason_id = $1,
                            phone_fix_verdict = 'pending',
                            updated_at = NOW()
                      WHERE id = $2`,
                    [reasons.get(result.reason) || null, row.id]
                );
                unresolved++;
            }
        }

        await client.query('COMMIT');
        return { seen: rows.rows.length, changed, already, unresolved, commit: currentCommit() };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    }
}

// Сам прогон. Возвращает числа «до / после» — они идут в отчёт и в заголовок
// выгрузки.
async function runPhoneNormalization(pool) {
    const client = await pool.connect();
    let stats = null;
    try {
        const done = await client.query('SELECT 1 FROM applied_migrations WHERE id = $1', [MIGRATION_ID]);
        if (done.rows.length === 0) {
            stats = await normalizeAllLeads(client);
            await client.query('INSERT INTO applied_migrations (id) VALUES ($1)', [MIGRATION_ID]);
        }
    } finally {
        client.release();
    }

    const index = await ensurePhoneUniqueIndex(pool);
    if (stats) {
        console.log(
            '[телефон] Приведение номеров: просмотрено ' + stats.seen + ', приведено ' + stats.changed +
            ', уже в формате ' + stats.already + ', ушло в разбор ' + stats.unresolved + '. ' +
            (index.created ? 'Уникальность номера включена.' : 'Уникальность номера ждёт разбора дублей.')
        );
    }
    return Object.assign({}, stats || {}, { index });
}

module.exports = {
    runPhoneNormalization,
    ensurePhoneUniqueIndex,
    findPhoneDuplicates,
    currentCommit,
    MIGRATION_ID,
    UNIQUE_INDEX_SQL
};
