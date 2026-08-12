// --- services/leadDistribution.js: автораспределение лидов операторам
// "на линии" (report_2026-08-01.md, 13.08.2026). Не роут — переиспользуется
// и из routes/leadsAdmin.js (POST /bulk-import), и из routes/employees.js
// (PUT /:id/on-line). Принимает db (pool или client уже открытой
// транзакции) первым параметром, чтобы вызов из bulk-import мог работать
// в той же транзакции, что и вставка строк.

async function findNewFunnelStatusId(db) {
    const result = await db.query("SELECT id FROM lead_funnel_statuses WHERE stage_number = 0 LIMIT 1");
    return result.rows[0] ? result.rows[0].id : null;
}

// Дольше всех свободен — первый в очереди (ORDER BY on_line_since ASC).
async function findAvailableEmployee(db) {
    const result = await db.query(
        `SELECT id FROM employees WHERE status = 'active' AND on_line = true ORDER BY on_line_since ASC LIMIT 1`
    );
    return result.rows[0] ? result.rows[0].id : null;
}

// Разбирает ВСЕ зависшие лиды (employee_id IS NULL, статус "Новый") по
// свободным операторам, по одному, в порядке очереди. После каждого
// назначения on_line_since оператора сбрасывается на NOW() — простая
// ротация: если он единственный на линии, следующий лид снова достанется
// ему же (он всё ещё единственный кандидат), а не зависнет специально ради
// "справедливости" между операторами, которых сейчас нет.
async function distributePendingLeads(db) {
    const newStatusId = await findNewFunnelStatusId(db);
    if (newStatusId === null) return { distributed: 0 };

    const pending = await db.query(
        'SELECT id FROM leads WHERE employee_id IS NULL AND funnel_status_id = $1 ORDER BY created_at ASC',
        [newStatusId]
    );

    let distributed = 0;
    for (const row of pending.rows) {
        const employeeId = await findAvailableEmployee(db);
        if (employeeId === null) break; // операторов на линии больше нет — остальное остаётся в очереди
        await db.query('UPDATE leads SET employee_id = $1, updated_at = NOW() WHERE id = $2', [employeeId, row.id]);
        await db.query('UPDATE employees SET on_line_since = NOW() WHERE id = $1', [employeeId]);
        distributed++;
    }
    return { distributed };
}

module.exports = { distributePendingLeads, findAvailableEmployee, findNewFunnelStatusId };
