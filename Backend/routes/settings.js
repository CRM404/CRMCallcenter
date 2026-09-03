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


// ⚠⚠ КЛЮЧИ ТЕЛЕФОНИИ ОТДАЮТСЯ БЕЗ ЗНАЧЕНИЯ, И ЭТО НЕ УКРАШЕНИЕ ЭКРАНА.
// Правило слоя записано в каталоге дословно: «„Скрыто навсегда" — это про
// сервер, а не про вид. Прятать значение интерфейсом нельзя — оно осталось бы
// в исходном коде страницы» (`Shell/ui-catalog.html`). Поэтому строки `value`
// в ответе НЕТ ВОВСЕ: не пустая строка, не точки — поля нет. Вместо него
// признак `isSet`, по которому экран рисует приглашение.
//
// ⚠ Лежат они в своей таблице `pbx_credentials`, исключённой из журнала:
// правила аудита задаются парой «таблица + колонка», и общий `app_settings.value`
// пришлось бы либо писать целиком, либо лишить значений все семь настроек.
// Довод целиком — в `schema.sql`, рядом с самой таблицей.
//
// Форма строки — та же, что у обычной настройки: экран не должен различать
// породы, он смотрит на `valueType`.
function serializeSecret(row) {
    return {
        key: row.key,
        title: row.title,
        description: row.description,
        valueType: 'secret',
        unit: null,
        groupKey: row.group_key,
        groupOrder: row.group_order,
        isReadonly: false,
        isDangerous: true,
        defaultValue: null,
        // ⚠ Значения нет. `isSet` — единственное, что уходит на экран.
        isSet: Boolean(row.value && String(row.value).length),
        // Подпись «Изменено …» этой строке не положена: журнала у таблицы нет
        // намеренно, и обещать след, которого не существует, нельзя.
        changed: null
    };
}

// Список настроек. Порядок — из данных: `group_order` задаёт место строки в
// СПЛОШНОМ списке, поэтому порядок групп выходит сам, без второй колонки.
router.get('/', async (req, res) => {
    try {
        const [rows, secrets, edits] = await Promise.all([
            pool.query(
                `SELECT key, value, title, description, value_type, unit,
                        group_key, group_order, is_readonly, is_dangerous, default_value
                   FROM app_settings
                  ORDER BY group_order, key`
            ),
            // ⚠ `value` берётся, но на экран НЕ уходит: он нужен только чтобы
            // ответить «задано или нет». Дальше `serializeSecret` его теряет.
            pool.query(
                `SELECT key, value, title, description, group_key, group_order
                   FROM pbx_credentials
                  ORDER BY group_order, key`
            ),
            lastValueEdits()
        ]);

        // Две породы строк сходятся в ОДИН список и сортируются вместе: место
        // строки задаёт `group_order`, а не то, из какой она таблицы.
        const list = rows.rows.map((r) => serialize(r, edits.get(r.key)))
            .concat(secrets.rows.map(serializeSecret))
            .sort((a, b) => (a.groupOrder - b.groupOrder) || a.key.localeCompare(b.key));
        res.json(list);
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


// Правка ключа телефонии. ⚠ ОТДЕЛЬНЫЙ МАРШРУТ, А НЕ ВЕТКА В ОБЩЕМ: у общего
// первым делом стоит `SELECT ... FROM app_settings`, и ключа он там не найдёт —
// значит либо второй запрос в каждом сохранении настройки, либо отдельная
// дверь. Дверь честнее: она сразу говорит, что за ней другое хранилище и
// другие правила.
//
// ⚠ ОТВЕТ НЕ ВОЗВРАЩАЕТ ЗНАЧЕНИЯ — ни того, что сохранили, ни прежнего.
// Вернуть только что присланное было бы безобидно на вид и вредно по сути:
// значение легло бы в ответ, а ответ — в журнал браузера и в отладчик.
router.put('/secret/:key', async (req, res) => {
    const key = String(req.params.key);
    try {
        const found = await pool.query('SELECT key FROM pbx_credentials WHERE key = $1', [key]);
        if (found.rows.length === 0) {
            return res.status(404).json({ error: 'Ключа с таким именем нет' });
        }

        // ПУСТОЕ ЗНАЧЕНИЕ — ОЧИСТКА, А НЕ ОТКАЗ (ответ куратора 13). Стереть
        // ключ надо уметь: скомпрометированный ключ снимают немедленно, а
        // ждать замены в этот момент некогда.
        const raw = req.body && req.body.value;
        const value = raw === null || raw === undefined ? '' : String(raw).trim();

        const saved = await pool.query(
            `UPDATE pbx_credentials SET value = $2, updated_at = NOW()
              WHERE key = $1
          RETURNING key, value, title, description, group_key, group_order`,
            [key, value.length ? value : null]
        );
        res.json(serializeSecret(saved.rows[0]));
    } catch (err) {
        // ⚠ В журнал сервера идёт ТОЛЬКО имя ключа. `err` печатать нельзя:
        // драйвер базы кладёт в текст ошибки параметры запроса, а второй
        // параметр здесь — сам ключ.
        console.error('Ошибка сохранения ключа телефонии:', key, err && err.code);
        res.status(500).json({ error: 'Не удалось сохранить ключ' });
    }
});

module.exports = router;
