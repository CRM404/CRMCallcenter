// --- services/leadMerge.js: слияние дублей лида (часть 4, Б1.4, план 5.4) ---
//
// ОПЕРАЦИЯ, А НЕ ШАГ МИГРАЦИИ. Требование паспорта Р10: кнопка «Объединить
// лидов» зовёт ровно эту логику, и ручная правка, попавшая в существующий
// номер, — тот же случай, что найденный миграцией дубль, просто приехавший
// позже. Поэтому правила живут здесь, а не внутри разового прогона.
//
// ШЕСТЬ ПРАВИЛ ПЛАНА 5.4 И ЧЕТЫРЕ УТОЧНЕНИЯ, полученные до старта (И58–И65):
//
// 1. Остаётся более старый лид — его идентификатор. На него уже ссылаются
//    история, распределение и (позже) звонки; менять идентификатор нельзя.
// 2. Свежие данные побеждают — НО ТОЛЬКО ДАННЫЕ О ЧЕЛОВЕКЕ. Формулировка
//    куратора: «свежие побеждают — про то, что человек о себе сообщил, а не про
//    то, как он к нам попал и как обслуживается». Отсюда два исключения:
//    source_id остаётся старшего (решение владельца 67: источник — факт о том,
//    как человек пришёл ВПЕРВЫЕ, и по нему считаются деньги на рекламу), и
//    line_type остаётся старшего (И62: служебное поле маршрутизации, подмена
//    перебрасывает лида в другую очередь по причине, которой человек не увидит).
//    Пустое значение свежего ничего не перезаписывает: пустота — не данные.
// 3. Статус воронки: меняем, только если старший на нулевом этапе (решение
//    владельца 56, строгое чтение — ответ куратора И37). Решение защищает
//    продвинутый статус ОТ СБРОСА, но не запрещает продвижение: старший на
//    нулевом и младший на третьем — это один человек, с которым уже дошли до
//    третьего, и оставить нулевой значит позвонить как впервые (И65).
// 4. Комментарии сливаются. Ленты (Б4) ещё нет, есть одно поле notes — значит
//    склейка с пометкой, откуда и от какого числа приехало продолжение (И59).
//    Когда придёт лента, склеенный текст переедет в неё одной записью, как уже
//    накопленные комментарии по решению владельца 57.
// 5. Счётчик попыток — БОЛЬШИЙ, не сумма: это «сколько раз пытались дозвониться
//    до человека», а не «сколько записей было в базе».
// 6. Аудит получает партию «слияние лидов»: без неё исчезновение лида из списка
//    выглядит как необъяснимая пропажа.
//
// Младший НЕ УДАЛЯЕТСЯ (И58): получает указатель на старшего и выпадает из
// списков, раздачи и подбора, но существует — и на вопрос «куда делся лид 1287»
// ответ есть навсегда.

const { withTransaction } = require('./dbTx');
const auditContext = require('./auditContext');
const { normalizePhone } = require('./phoneFormat');

// Что человек сообщил о себе. Всё остальное — как он к нам попал (source_id) и
// как обслуживается (line_type, скрипты, оператор, даты работы, счётчики).
const PERSON_COLUMNS = [
    'last_name', 'first_name', 'middle_name',
    'decision_maker', 'client_type', 'other_borrower', 'category',
    'property_type', 'property_class', 'room_count', 'finish',
    'price_from', 'price_to', 'area_from', 'area_to', 'delivery_deadline',
    'region', 'city', 'district', 'locality',
    'client_region', 'client_city', 'client_district', 'client_locality',
    'purchase_method', 'mortgage_type', 'down_payment_percent', 'purchase_timeframe'
];

function isEmpty(value) {
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

// Дата слияния в тексте пометки — по Москве, как всё, что видит человек
// (решение владельца 47). Приложение считает Москвой через services/appTime.js,
// здесь достаточно того же пояса в подписи.
function moscowDate(date) {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(date);
}

function mergeNotes(elder, junior, mergedAt) {
    const juniorText = (junior.notes || '').trim();
    if (juniorText === '') return elder.notes;
    const elderText = (elder.notes || '').trim();
    const mark = `— перенесено из лида №${junior.id} от ${moscowDate(junior.created_at)}, слито ${moscowDate(mergedAt)} —`;
    return elderText === '' ? `${mark}\n${juniorText}` : `${elderText}\n\n${mark}\n${juniorText}`;
}

// Слияние двух лидов. Возвращает { elderId, juniorId } либо бросает ошибку с
// полем .reason — её текст уходит человеку как есть.
async function mergeLeads(db, idA, idB) {
    return auditContext.runAsBatch(db, {
        kind: 'merge',
        title: `Слияние лидов №${idA} и №${idB}`,
        actorName: 'Слияние'
    }, () => withTransaction(db, async (client) => {
        // FOR UPDATE: пока идёт слияние, обе карточки заперты — иначе оператор
        // успеет сохранить младшего между чтением и записью, и его правка
        // потеряется молча.
        const rows = await client.query(
            'SELECT * FROM leads WHERE id = ANY($1::int[]) ORDER BY created_at, id FOR UPDATE',
            [[Number(idA), Number(idB)]]
        );
        if (rows.rows.length !== 2) {
            const err = new Error('Один из лидов не найден');
            err.reason = 'not-found';
            throw err;
        }
        const [elder, junior] = rows.rows;
        if (elder.merged_into_id !== null || junior.merged_into_id !== null) {
            const err = new Error('Один из лидов уже влит в другого — сливать нечего');
            err.reason = 'already-merged';
            throw err;
        }

        // Сливаем только тех, кого свёл ОДИН И ТОТ ЖЕ номер. Два разных номера
        // одного человека остаются двумя лидами — это прямо сказано планом
        // (5.6) и автоматикой не лечится. Исключение — лид, чей номер ещё в
        // разборе: он и попал сюда потому, что человек правит его в номер,
        // который уже занят.
        const elderPhone = normalizePhone(elder.phone).phone;
        const juniorPhone = normalizePhone(junior.phone).phone;
        const oneIsUnresolved = elder.phone_normalized === false || junior.phone_normalized === false;
        if (elderPhone !== juniorPhone && !oneIsUnresolved) {
            const err = new Error(
                `У лидов разные номера (${elderPhone} и ${juniorPhone}) — объединять можно только дубли по номеру`);
            err.reason = 'different-phones';
            throw err;
        }

        const mergedAt = new Date();
        const set = {};

        // Правило 2 — данные о человеке от свежего, пустое ничего не стирает.
        for (const column of PERSON_COLUMNS) {
            if (!isEmpty(junior[column])) set[column] = junior[column];
        }

        // РАБОЧИЙ НОМЕР ПОБЕЖДАЕТ НОМЕР В РАЗБОРЕ (К175, приёмка части 4).
        //
        // Слияние обязано ВЫБИРАТЬ номер, а не наследовать молча. Наследование
        // выживающего номера верно почти всегда — у дублей номера одинаковы, —
        // но не в том случае, ради которого слияние и вызывается: человек
        // правит номер из разбора, попадает в занятый, PUT отбивает 409 и
        // предлагает объединить. Правка при этом НЕ СОХРАНИЛАСЬ, и слияние про
        // неё не знает: старший остаётся со сломанным номером, младший со своим
        // рабочим исчезает, а на экране операция выглядит успешной.
        //
        // Оба рабочих — они и так одинаковы, это условие слияния. Оба в разборе
        // — остаётся старший. Меняется ровно сломанный случай.
        //
        // Вердикт выжившего — «исправлен»: номер действительно исправлен, просто
        // исправило его слияние, а не рука. phone_raw при этом остаётся
        // СТАРШЕГО: это его исходная строка, она хранится бессрочно, и подменять
        // её нельзя — иначе пропадёт то, что пришло на самом деле.
        if (elder.phone_normalized === false && junior.phone_normalized === true) {
            set.phone = junior.phone;
            set.phone_normalized = true;
            set.phone_fix_reason_id = null;
            set.phone_fix_verdict = 'fixed';
        }

        // Правило 3 — статус только с нулевого этапа.
        const elderStage = await client.query(
            'SELECT stage_number FROM lead_funnel_statuses WHERE id = $1', [elder.funnel_status_id]);
        const elderStageNumber = elderStage.rows[0] ? elderStage.rows[0].stage_number : null;
        if (elderStageNumber === 0 && junior.funnel_status_id !== null) {
            set.funnel_status_id = junior.funnel_status_id;
        }

        // Правило 4 — комментарии лентой по времени. Ленты нет, склеиваем текст.
        set.notes = mergeNotes(elder, junior, mergedAt);

        // Правило 5 — счётчик попыток больший, а не сумма.
        set.call_attempts = Math.max(elder.call_attempts || 0, junior.call_attempts || 0);

        // И61 — оператор переезжает, только если старший ничей: работа уже идёт,
        // и сбросить назначение значит позвонить второй раз тому, кому только
        // что звонили.
        if (elder.employee_id === null && junior.employee_id !== null) {
            set.employee_id = junior.employee_id;
        }

        // И63 — каждая дата по своему смыслу, а не общим правилом.
        const nextCalls = [elder.next_call_at, junior.next_call_at].filter(Boolean);
        // Ближайший перезвон: назначенное время — обещание человеку, и более
        // раннее обещание терять нельзя.
        set.next_call_at = nextCalls.length ? new Date(Math.min(...nextCalls.map((d) => d.getTime()))) : null;
        const lastCalls = [elder.last_call_at, junior.last_call_at].filter(Boolean);
        // Последний звонок — факт: когда с человеком в последний раз говорили.
        set.last_call_at = lastCalls.length ? new Date(Math.max(...lastCalls.map((d) => d.getTime()))) : null;
        // Открытая карточка после слияния не открыта ни у кого.
        set.opened_at = null;

        // МЛАДШИЙ ВЫБЫВАЕТ ПЕРВЫМ, и порядок здесь не стилистический. Уникальный
        // индекс номера считает живыми обоих, пока у младшего не проставлен
        // указатель, — и старший, забирающий его рабочий номер (К175), падал бы
        // на 23505 внутри собственного слияния. Пометка снимает младшего с учёта,
        // после чего номер свободен. Всё в одной транзакции: не состоится
        // слияние — не состоится и пометка.
        await client.query(
            `UPDATE leads SET merged_into_id = $1, merged_at = $2, opened_at = NULL, updated_at = NOW()
              WHERE id = $3`,
            [elder.id, mergedAt, junior.id]);

        const columns = Object.keys(set);
        const values = columns.map((c) => set[c]);
        values.push(elder.id);
        await client.query(
            `UPDATE leads SET ${columns.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
              WHERE id = $${values.length}`,
            values
        );

        // Связки — по одной, а не общим правилом (И60).
        // Офферы: чем человек интересовался, интересовался он, а не запись.
        await client.query(
            `INSERT INTO lead_offers (lead_id, offer_id)
             SELECT $1, offer_id FROM lead_offers WHERE lead_id = $2
             ON CONFLICT DO NOTHING`, [elder.id, junior.id]);
        // Статусы показа скрипта: прохождение старшего — это разговор, который
        // уже был; совпавшие остаются его.
        await client.query(
            `INSERT INTO lead_script_statuses (lead_id, funnel_status_id)
             SELECT $1, funnel_status_id FROM lead_script_statuses WHERE lead_id = $2
             ON CONFLICT DO NOTHING`, [elder.id, junior.id]);
        // Пул раздачи НЕ объединяется: это не данные о человеке, а ограничение
        // «кому можно отдать». У старшего пула нет, у младшего есть — объединение
        // СУЗИЛО бы круг операторов у лида, которого никто не сужал.

        return { elderId: elder.id, juniorId: junior.id };
    }));
}

module.exports = { mergeLeads, PERSON_COLUMNS };
