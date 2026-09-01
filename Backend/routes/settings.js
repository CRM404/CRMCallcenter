// --- routes/settings.js: экран настроек (Б9.2) ------------------------------
//
// Два маршрута: список и правка одной строки. Кнопки «Сохранить всё» на экране
// нет намеренно (паспорт Р8), поэтому и маршрута «сохранить пачку» здесь нет:
// одна правка — одна строка журнала с понятным смыслом, а «сохранено 11
// настроек» в разборе «почему всё сломалось в четверг» не значит ничего.
//
// ЭКРАН ПРОВЕРЯЕТ ФОРМУ, СЕРВЕР ПРОВЕРЯЕТ СМЫСЛ. Это не разделение труда, а
// защита: настройку правит человек, а ломает она планировщик, который никого не
// спрашивает. «Порог сторожа 0 часов» проходит по форме и закрывает живые
// разговоры; отбить его обязан сервер, потому что до сервера можно дойти и мимо
// экрана — обычным запросом.
//
// СПИСОК НАСТРОЕК ЗДЕСЬ НЕ ЗАШИТ, И ЭТО ПРАВИЛО ПАСПОРТА. Имя, описание, тип,
// единица, группа и порядок — данные (`app_settings`), а не разметка: состав
// экрана меняется строкой в таблице, без выкатки. Зашиты только ПРЕДЕЛЫ — их
// паспорт прямо отдаёт серверу, и они разные у разных ключей.

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// ПРЕДЕЛЫ — ПО КЛЮЧУ, А НЕ ПО ТИПУ. Соблазн написать «все часы 1..24» есть, но
// он ложный: следующая настройка в часах может оказаться сроком хранения, где
// верхняя граница другая. Ключ здесь — это обещание, данное конкретной
// настройке, а не свойство её типа (наряд куратора, «Пределы значений»).
//
// Границы включительные с обеих сторон (ответ куратора 34).
const LIMITS = {
    held_lead_release_hours: { min: 1, max: 24 },
    max_open_interval_hours: { min: 1, max: 24 },
    // Нижняя граница здесь не formality: порог меньше часа закроет живые
    // разговоры, которые просто идут долго.
    stale_call_hours: { min: 1, max: 24 }
};

// Доля — свойство ТИПА, а не ключа: процент от нуля до ста — это и есть процент.
const PERCENT = { min: 0, max: 100 };

/**
 * Разбор значения по типу настройки.
 *
 * Возвращает `{ value }` или `{ error }`. Текст отказа обязан называть предел
 * ЧИСЛОМ (ответ куратора 36): «значение недопустимо» не говорит человеку, что
 * набрать вместо набранного, и он пробует ещё раз наугад.
 */
function parseValue(row, raw) {
    const text = raw === null || raw === undefined ? '' : String(raw);

    switch (row.value_type) {
        case 'switch':
            // Написание одно на весь проект: 'true' / 'false' и никак иначе
            // (`schema.sql`, колонка value_type). Одно написание в базе, в
            // ответе API и в журнале изменений вместо трёх.
            if (text !== 'true' && text !== 'false') {
                return { error: 'Выключатель принимает только true или false' };
            }
            return { value: text };

        case 'number': {
            if (!/^\d+$/.test(text)) return { error: 'Нужно целое число' };
            const limit = LIMITS[row.key];
            const n = Number(text);
            if (limit && (n < limit.min || n > limit.max)) {
                return { error: `Число должно быть от ${limit.min} до ${limit.max}` };
            }
            return { value: String(n) };
        }

        case 'percent': {
            if (!/^\d+$/.test(text)) return { error: 'Нужно целое число' };
            const n = Number(text);
            if (n < PERCENT.min || n > PERCENT.max) {
                return { error: `Доля задаётся числом от ${PERCENT.min} до ${PERCENT.max}` };
            }
            return { value: String(n) };
        }

        case 'time_range': {
            // Окно времени — одна настройка из двух половин, и хранится оно
            // одной строкой «ЧЧ:ММ—ЧЧ:ММ». Читателя у такой настройки сегодня
            // нет ни одного (рабочее окно живёт в `call_events`), но тип
            // объявлен схемой, и оставить его без разбора значит однажды
            // записать в базу что угодно.
            const m = /^(\d{2}):(\d{2})—(\d{2}):(\d{2})$/.exec(text);
            if (!m) return { error: 'Окно задаётся как ЧЧ:ММ—ЧЧ:ММ' };
            const from = Number(m[1]) * 60 + Number(m[2]);
            const to = Number(m[3]) * 60 + Number(m[4]);
            if (Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59) {
                return { error: 'Окно задаётся как ЧЧ:ММ—ЧЧ:ММ' };
            }
            if (to <= from) return { error: 'Конец окна должен быть позже начала' };
            return { value: text };
        }

        case 'text':
            if (text.trim() === '') return { error: 'Значение не может быть пустым' };
            return { value: text.trim() };

        case 'date':
            // Дат, которые правит человек, на этом экране нет: единственная
            // стоит только на чтение. Строка оставлена не для полноты, а
            // потому что молчаливое «прошло» у неизвестного типа опаснее
            // отказа.
            return { error: 'Дату этой настройки менять нельзя' };

        default:
            return { error: `Неизвестный тип значения: ${row.value_type}` };
    }
}

function serialize(row, changed) {
    return {
        key: row.key,
        title: row.title,
        description: row.description,
        valueType: row.value_type,
        unit: row.unit,
        groupKey: row.group_key,
        groupOrder: row.group_order,
        isReadonly: row.is_readonly,
        isDangerous: row.is_dangerous,
        defaultValue: row.default_value,
        value: row.value,
        // Подпись «Изменено …» ставится ТОЛЬКО у настройки, которую правил
        // человек (паспорт Р8). `updated_at` для этого не годится: у засеянной
        // строки он тоже есть, и одиннадцать одинаковых подписей сказали бы,
        // что кто-то одиннадцать раз что-то менял. Отличает их журнал: правка
        // значения — это запись с `op = 'update'` и полем `value`, а засев —
        // запись с `op = 'insert'`.
        changed: changed || null
    };
}

/**
 * Кто и когда менял ЗНАЧЕНИЕ каждой настройки — одним запросом на весь список,
 * а не по запросу на строку.
 *
 * Отбор по `changes @> [{"field":"value"}]` намеренно узкий: правка описания
 * из файла тоже приходит сюда записью `update`, но человек её не делал, и
 * подпись «Изменено» под ней означала бы неправду.
 */
async function lastValueEdits() {
    const found = await pool.query(
        `SELECT DISTINCT ON (record_id)
                record_id, changed_at, actor_kind, actor_name
           FROM audit_log
          WHERE table_name = 'app_settings'
            AND op = 'update'
            AND changes @> '[{"field": "value"}]'::jsonb
          ORDER BY record_id, changed_at DESC`
    );
    const byKey = new Map();
    found.rows.forEach((r) => {
        byKey.set(r.record_id, {
            at: r.changed_at,
            actorKind: r.actor_kind,
            actorName: r.actor_name
        });
    });
    return byKey;
}

// Список настроек. Порядок — из данных: `group_order` задаёт место строки в
// СПЛОШНОМ списке, поэтому порядок групп выходит сам, без второй колонки.
router.get('/', async (req, res) => {
    try {
        const [rows, edits] = await Promise.all([
            pool.query(
                `SELECT key, value, title, description, value_type, unit,
                        group_key, group_order, is_readonly, is_dangerous, default_value
                   FROM app_settings
                  ORDER BY group_order, key`
            ),
            lastValueEdits()
        ]);
        res.json(rows.rows.map((r) => serialize(r, edits.get(r.key))));
    } catch (err) {
        console.error('Ошибка получения настроек:', err);
        res.status(500).json({ error: 'Не удалось получить настройки' });
    }
});

// Правка ОДНОЙ настройки. Пачки нет — см. шапку файла.
router.put('/:key', async (req, res) => {
    const key = String(req.params.key);
    try {
        const found = await pool.query(
            `SELECT key, value, value_type, is_readonly FROM app_settings WHERE key = $1`,
            [key]
        );

        // НЕИЗВЕСТНЫЙ КЛЮЧ — ОТКАЗ, А НЕ ЗАВЕДЕНИЕ СТРОКИ. Экран настроек не
        // заводит настроек сам (паспорт Р8): список приходит с сервера, а
        // настройка без описания и типа не нарисуется вовсе. Тихая вставка
        // дала бы мёртвую строку, которую никто не читает.
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Настройки с таким ключом нет' });
        }
        const row = found.rows[0];

        // ТОЛЬКО ЧТЕНИЕ ОТБИВАЕТСЯ ЗДЕСЬ, А НЕ ТОЛЬКО НА ЭКРАНЕ (ответ
        // куратора 35). Дата начала журнала — то единственное, на чём
        // держится честность пустой вкладки истории: она отличает «не
        // меняли» от «ещё не записывали». Правка запросом мимо экрана
        // сделала бы эту разницу недоказуемой.
        if (row.is_readonly) {
            return res.status(409).json({ error: 'Эту настройку править нельзя: она только для чтения' });
        }

        const parsed = parseValue(row, req.body && req.body.value);
        if (parsed.error) return res.status(400).json({ error: parsed.error });

        // `updated_at` ставится явно: колонка объявлена с DEFAULT NOW(), а
        // умолчание работает только на вставке.
        const saved = await pool.query(
            `UPDATE app_settings SET value = $2, updated_at = NOW()
              WHERE key = $1
          RETURNING key, value, title, description, value_type, unit,
                    group_key, group_order, is_readonly, is_dangerous, default_value`,
            [key, parsed.value]
        );

        const edits = await lastValueEdits();
        res.json(serialize(saved.rows[0], edits.get(key)));
    } catch (err) {
        console.error('Ошибка сохранения настройки:', err);
        res.status(500).json({ error: 'Не удалось сохранить настройку' });
    }
});

module.exports = router;
