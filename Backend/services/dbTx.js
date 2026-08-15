// --- services/dbTx.js: единый способ выполнить кусок работы в транзакции ---
//
// Сервисы этой задачи (раздача, очередь, состояния оператора) вызываются двумя
// способами: из роута, где есть только пул, и из уже открытой транзакции
// (POST /api/leads-admin/bulk-import передаёт свой client). Транзакция здесь
// обязательна, а не желательна: выборка лида идёт с FOR UPDATE SKIP LOCKED, и
// вне транзакции блокировка снимается сразу после SELECT — двое операторов
// получили бы одну карточку и позвонили клиенту дважды подряд (dialog.md D1).
//
// Признак «это уже клиент, а не пул» — наличие release(): у pg.Pool его нет, у
// клиента из пула есть. Вложенных BEGIN не делаем: чужой транзакцией распоряжается
// её владелец, наше дело — не открыть вторую.

async function withTransaction(db, fn) {
    if (typeof db.release === 'function') {
        return fn(db);
    }
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { withTransaction };
