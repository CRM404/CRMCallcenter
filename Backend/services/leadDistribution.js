// --- services/leadDistribution.js: автораспределение лидов операторам
// "на линии" (report_2026-08-01.md, 13.08.2026). Не роут — переиспользуется
// и из routes/leadsAdmin.js (POST /bulk-import), и из routes/employees.js
// (PUT /:id/on-line). Принимает db (pool или client уже открытой
// транзакции) первым параметром, чтобы вызов из bulk-import мог работать
// в той же транзакции, что и вставка строк.
//
// Правило подбора (задача "скрипты: привязка к лиду, раздача по линии"):
// оператор должен быть активен, "на линии", ТОЙ ЖЕ линии, что у лида, и —
// если у лида заполнен пул раздачи (lead_distribution_pool) — входить в пул.
// Пустой пул означает "всем подходящим по линии", а не "никому".

async function findNewFunnelStatusId(db) {
    const result = await db.query("SELECT id FROM lead_funnel_statuses WHERE stage_number = 0 LIMIT 1");
    return result.rows[0] ? result.rows[0].id : null;
}

// Дольше всех свободен — первый в очереди (ORDER BY on_line_since ASC).
// lead — строка с полями id и line_type: кандидаты у каждого лида свои,
// одного общего "следующего свободного оператора" больше не существует.
async function findAvailableEmployee(db, lead) {
    if (!lead || !lead.line_type) return null;
    const result = await db.query(
        `SELECT e.id
         FROM employees e
         WHERE e.status = 'active'
           AND e.on_line = true
           AND e.line_type = $1
           AND (
                NOT EXISTS (SELECT 1 FROM lead_distribution_pool p WHERE p.lead_id = $2)
                OR EXISTS (SELECT 1 FROM lead_distribution_pool p WHERE p.lead_id = $2 AND p.employee_id = e.id)
           )
         ORDER BY e.on_line_since ASC
         LIMIT 1`,
        [lead.line_type, lead.id]
    );
    return result.rows[0] ? result.rows[0].id : null;
}

// Разбирает ВСЕ зависшие лиды (employee_id IS NULL, статус "Новый", линия
// заполнена) по свободным операторам, по одному, в порядке очереди. После
// каждого назначения on_line_since оператора сбрасывается на NOW() — простая
// ротация: если он единственный подходящий, следующий лид снова достанется
// ему же, а не зависнет ради "справедливости" между операторами, которых
// сейчас нет.
//
// continue, а не break: у лидов разные линии и разные пулы, поэтому "для
// этого лида кандидата нет" не означает "для остальных тоже". Лид, чей пул
// сейчас офлайн, не должен затыкать очередь всем остальным.
async function distributePendingLeads(db) {
    const newStatusId = await findNewFunnelStatusId(db);
    if (newStatusId === null) return { distributed: 0 };

    const pending = await db.query(
        `SELECT id, line_type FROM leads
         WHERE employee_id IS NULL AND funnel_status_id = $1 AND line_type IS NOT NULL
         ORDER BY created_at ASC, id ASC`,
        [newStatusId]
    );

    let distributed = 0;
    for (const lead of pending.rows) {
        const employeeId = await findAvailableEmployee(db, lead);
        if (employeeId === null) continue;
        await db.query('UPDATE leads SET employee_id = $1, updated_at = NOW() WHERE id = $2', [employeeId, lead.id]);
        await db.query('UPDATE employees SET on_line_since = NOW() WHERE id = $1', [employeeId]);
        distributed++;
    }
    return { distributed };
}

module.exports = { distributePendingLeads, findAvailableEmployee, findNewFunnelStatusId };
