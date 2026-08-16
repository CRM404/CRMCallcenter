// --- routes/schedule.js: график работы сотрудников (план, а не факт) ---
//
// План живёт здесь, факт — в employee_state_intervals с прошлой задачи; они
// нигде не сводятся, это отдельная будущая работа (report_2026-08-01.md, п.0).
//
// Единица хранения — день одного сотрудника. Пустая ячейка в сетке = отсутствие
// строки, поэтому «Очистить» это DELETE, а не запись со специальным значением.

const express = require('express');
const { pool } = require('../db');
const { withTransaction } = require('../services/dbTx');
const {
    isValidState,
    isValidDateKey,
    isValidMonthKey,
    monthKeyOf,
    monthBounds,
    daysBetween,
    todayKey,
    parseShiftTimes,
    TIME_FORMAT_ERROR
} = require('../services/scheduleFormat');

const router = express.Router();

// Секунд в интерфейсе нет нигде, поэтому TIME подрезается прямо в SQL: иначе
// подрезка размазалась бы по трём местам фронта (dialog.md, Н1).
const TIME_OUT = (col, alias) => `to_char(${col}, 'HH24:MI') AS ${alias}`;

const EMPLOYEE_COLUMNS = `
    e.id, e.last_name, e.first_name, e.middle_name, e.line_type, e.department,
    e.work_schedule, ${TIME_OUT('e.shift_start', 'shift_start')}, ${TIME_OUT('e.shift_end', 'shift_end')},
    e.hire_date, e.termination_date`;

function rowToScheduleEmployee(row) {
    return {
        id: row.id,
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
        lineType: row.line_type,
        department: row.department,
        workSchedule: row.work_schedule,
        shiftStart: row.shift_start,
        shiftEnd: row.shift_end,
        hireDate: row.hire_date,
        terminationDate: row.termination_date
    };
}

function rowToScheduleDay(row) {
    return {
        employeeId: row.employee_id,
        day: row.day,
        state: row.state,
        shiftStart: row.shift_start,
        shiftEnd: row.shift_end,
        isExtra: row.is_extra
    };
}

// Сотрудник + границы, внутри которых его дни вообще редактируются. Отдельная
// функция, потому что одна и та же проверка нужна и постановке дня, и заполнению.
async function fetchEmployeeForSchedule(db, employeeId) {
    const result = await db.query(
        `SELECT id, status, hire_date, termination_date,
                ${TIME_OUT('shift_start', 'shift_start')}, ${TIME_OUT('shift_end', 'shift_end')}
         FROM employees WHERE id = $1`,
        [employeeId]
    );
    return result.rows[0] || null;
}

// Дни до приёма на работу и после увольнения не редактируются и заполнением
// пропускаются — симметрия обязательна, иначе эндпоинт принимает то, чего экран
// показать не может, и расхождение потом не объяснить (dialog.md, Б4).
function outOfEmploymentReason(employee, dayKey) {
    if (employee.hire_date && dayKey < employee.hire_date) {
        return 'День раньше даты приёма сотрудника на работу';
    }
    if (employee.termination_date && dayKey > employee.termination_date) {
        return 'День позже даты увольнения сотрудника';
    }
    return null;
}

function parseEmployeeId(raw) {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /api/schedule?month=YYYY-MM — всё, что нужно экрану, одним запросом.
// today отдаётся сервером в поясе приложения: «сегодня» на этом экране — это
// подсветка колонки, четыре счётчика и дата по умолчанию в модалке, и
// расхождение с сервером выглядело бы не как сбитые часы, а как неверные данные.
router.get('/', async (req, res) => {
    try {
        const today = todayKey();
        const month = req.query.month === undefined || req.query.month === ''
            ? today.slice(0, 7)
            : String(req.query.month);
        if (!isValidMonthKey(month)) {
            return res.status(400).json({ error: 'Месяц должен быть в формате YYYY-MM' });
        }
        const { first, last } = monthBounds(month);

        const employeesResult = await pool.query(
            `SELECT ${EMPLOYEE_COLUMNS} FROM employees e WHERE e.status = 'active' ORDER BY e.id`
        );
        // Дни неактивных сотрудников не отдаём: их нет в сетке, и висящие
        // employeeId, которым не соответствует ни одна строка, только мешают.
        const daysResult = await pool.query(
            `SELECT d.employee_id, d.day, d.state,
                    ${TIME_OUT('d.shift_start', 'shift_start')}, ${TIME_OUT('d.shift_end', 'shift_end')},
                    d.is_extra
             FROM employee_schedule_days d
             JOIN employees e ON e.id = d.employee_id AND e.status = 'active'
             WHERE d.day >= $1 AND d.day <= $2
             ORDER BY d.employee_id, d.day`,
            [first, last]
        );

        res.json({
            month,
            today,
            employees: employeesResult.rows.map(rowToScheduleEmployee),
            days: daysResult.rows.map(rowToScheduleDay)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить график' });
    }
});

// PUT /api/schedule/day — одно состояние в один день (все пункты меню, кроме
// «Очистить»). INSERT ... ON CONFLICT одним запросом: проверка «есть ли уже
// строка» отдельным SELECT — это гонка.
router.put('/day', async (req, res) => {
    try {
        const { employeeId, day, state, shiftStart, shiftEnd, isExtra } = req.body || {};

        const id = parseEmployeeId(employeeId);
        if (!id) {
            return res.status(400).json({ error: 'Не передан сотрудник' });
        }
        if (!isValidDateKey(day)) {
            return res.status(400).json({ error: 'День должен быть в формате YYYY-MM-DD' });
        }
        if (!isValidState(state)) {
            return res.status(400).json({ error: 'Недопустимое состояние дня' });
        }

        // Время принимаем только у смены; у остальных состояний принудительно
        // NULL — клиенту тут не доверяем, эндпоинт доступен и в обход формы.
        let start = null;
        let end = null;
        if (state === 'shift') {
            const times = parseShiftTimes(shiftStart, shiftEnd);
            if (times.error) {
                return res.status(400).json({ error: times.error });
            }
            if (!times.start) {
                return res.status(400).json({ error: TIME_FORMAT_ERROR });
            }
            start = times.start;
            end = times.end;
        }

        const employee = await fetchEmployeeForSchedule(pool, id);
        if (!employee) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        if (employee.status !== 'active') {
            return res.status(400).json({ error: 'Сотрудник неактивен' });
        }
        const outOfRange = outOfEmploymentReason(employee, day);
        if (outOfRange) {
            return res.status(400).json({ error: outOfRange });
        }

        const extra = state === 'shift' ? isExtra === true : false;

        const result = await pool.query(
            `INSERT INTO employee_schedule_days (employee_id, day, state, shift_start, shift_end, is_extra)
             VALUES ($1, $2::date, $3, $4::time, $5::time, $6)
             ON CONFLICT (employee_id, day) DO UPDATE
             SET state = EXCLUDED.state,
                 shift_start = EXCLUDED.shift_start,
                 shift_end = EXCLUDED.shift_end,
                 is_extra = EXCLUDED.is_extra
             RETURNING employee_id, day, state,
                       ${TIME_OUT('shift_start', 'shift_start')}, ${TIME_OUT('shift_end', 'shift_end')},
                       is_extra`,
            [id, day, state, start, end, extra]
        );
        res.json(rowToScheduleDay(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось сохранить день графика' });
    }
});

// DELETE /api/schedule/day?employeeId=&day= — пункт «Очистить». Отсутствие
// строки ошибкой не считается: результат один и тот же — день пуст.
router.delete('/day', async (req, res) => {
    try {
        const id = parseEmployeeId(req.query.employeeId);
        if (!id) {
            return res.status(400).json({ error: 'Не передан сотрудник' });
        }
        if (!isValidDateKey(req.query.day)) {
            return res.status(400).json({ error: 'День должен быть в формате YYYY-MM-DD' });
        }
        await pool.query(
            'DELETE FROM employee_schedule_days WHERE employee_id = $1 AND day = $2::date',
            [id, req.query.day]
        );
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось очистить день графика' });
    }
});

// POST /api/schedule/fill — заполнение месяца, главная операция экрана.
//
// Диапазон считает СЕРВЕР: от fromDate до последнего дня того же месяца. Взять
// границы от клиента значило бы однажды получить запрос на год.
// Отмеченный день → выходной, любой другой → смена с временем из карточки.
// Дырок не остаётся, всё прежнее в этих днях затирается, включая отпуск и
// больничный (решение владельца; единственная защита — считаемое предупреждение
// в предпросмотре, и оно ничего не блокирует).
router.post('/fill', async (req, res) => {
    try {
        const { employeeId, fromDate, dayOffDates } = req.body || {};

        const id = parseEmployeeId(employeeId);
        if (!id) {
            return res.status(400).json({ error: 'Не передан сотрудник' });
        }
        if (!isValidDateKey(fromDate)) {
            return res.status(400).json({ error: 'Дата начала должна быть в формате YYYY-MM-DD' });
        }

        const monthKey = monthKeyOf(fromDate);
        const { last } = monthBounds(monthKey);

        const dayOffList = dayOffDates === undefined || dayOffDates === null ? [] : dayOffDates;
        if (!Array.isArray(dayOffList)) {
            return res.status(400).json({ error: 'Список выходных должен быть массивом дат' });
        }
        for (const dayOff of dayOffList) {
            if (!isValidDateKey(dayOff) || dayOff < fromDate || dayOff > last) {
                return res.status(400).json({ error: 'Отмеченные выходные должны лежать внутри заполняемого диапазона' });
            }
        }
        const dayOffSet = new Set(dayOffList);

        const employee = await fetchEmployeeForSchedule(pool, id);
        if (!employee) {
            return res.status(404).json({ error: 'Сотрудник не найден' });
        }
        if (employee.status !== 'active') {
            return res.status(400).json({ error: 'Сотрудник неактивен' });
        }
        // Условие ровно одно — время смены. Пустое поле «Дни» заполнению не
        // мешает: автоматика его не читает, выходные называет человек.
        if (!employee.shift_start || !employee.shift_end) {
            return res.status(400).json({
                error: 'У сотрудника не указано время смены — заполните его в карточке сотрудника, тогда месяц можно будет проставить разом'
            });
        }

        // Дни вне периода работы пропускаются молча — отдельная ошибка на тот
        // же случай противоречила бы правилу «дни до найма пропускаются».
        const targetDays = daysBetween(fromDate, last)
            .filter((dayKey) => !outOfEmploymentReason(employee, dayKey));

        if (targetDays.length === 0) {
            return res.json({ shifts: 0, daysOff: 0, overwritten: { vacation: 0, sick: 0 } });
        }

        const result = await withTransaction(pool, async (client) => {
            // Что именно попадёт под нож — считаем ДО записи и только по тем
            // дням, которые реально будем трогать.
            const existing = await client.query(
                `SELECT state, COUNT(*)::int AS count
                 FROM employee_schedule_days
                 WHERE employee_id = $1 AND day = ANY($2::date[]) AND state IN ('vacation', 'sick')
                 GROUP BY state`,
                [id, targetDays]
            );
            const overwritten = { vacation: 0, sick: 0 };
            existing.rows.forEach((row) => { overwritten[row.state] = row.count; });

            // Одним мульти-VALUES, а не циклом с отдельными запросами.
            //
            // Время смены кладётся В КАЖДУЮ строку смены, а не отдельными $2/$3
            // на весь запрос: если администратор отметил выходными ВСЕ дни
            // диапазона, общие параметры не попали бы ни в один кортеж, и
            // Postgres не смог бы вывести их тип — запрос падал бы с 42P18
            // (поймано тестом C10). Лишние параметры здесь ничего не стоят.
            const values = [id];
            const tuples = targetDays.map((dayKey) => {
                values.push(dayKey);
                const dayIdx = values.length;
                if (dayOffSet.has(dayKey)) {
                    return `($1, $${dayIdx}::date, 'day_off', NULL, NULL, false)`;
                }
                values.push(employee.shift_start, employee.shift_end);
                return `($1, $${dayIdx}::date, 'shift', $${dayIdx + 1}::time, $${dayIdx + 2}::time, false)`;
            });

            await client.query(
                `INSERT INTO employee_schedule_days (employee_id, day, state, shift_start, shift_end, is_extra)
                 VALUES ${tuples.join(', ')}
                 ON CONFLICT (employee_id, day) DO UPDATE
                 SET state = EXCLUDED.state,
                     shift_start = EXCLUDED.shift_start,
                     shift_end = EXCLUDED.shift_end,
                     is_extra = EXCLUDED.is_extra`,
                values
            );

            const daysOff = targetDays.filter((dayKey) => dayOffSet.has(dayKey)).length;
            return { shifts: targetDays.length - daysOff, daysOff, overwritten };
        });

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось заполнить график' });
    }
});

module.exports = router;
