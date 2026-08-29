// --- Shell/history/historyFields.js: человеческие имена полей журнала ------
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЛОВАРЬ, А НЕ ТАБЛИЦА В БАЗЕ. В базе уже лежат две таблицы
// правил: `audit_rules` говорит, ЧТО писать, `audit_ref_map` — как расшифровать
// ЗНАЧЕНИЕ («статус 3 → 7» в «Новый → Перезвон»). Имя поля — не значение и не
// правило записи: это подпись на экране, и меняется она вместе с экраном, а не
// с данными. Класть подписи в базу значило бы править базу ради слова.
//
// ЧЕГО ЗДЕСЬ НЕТ — ТО И ЗАДУМАНО. Паспорт Р5 прямо описывает случай, когда
// расшифровки нет: «колонка, для которой расшифровки нет (переименованная в
// прошлом), показывается техническим именем моноширинным `.hi-raw` — показ не
// ломается, а честно говорит, что имени не знает». Значит словарь не обязан
// быть полным, и полным он не будет никогда: колонки заводят и снимают, а
// журнал хранит и те, которых уже нет.
//
// ПОРЯДОК ПОЛЕЙ ВНУТРИ ЗАПИСИ СЛОВАРЬ НЕ ЗАДАЁТ. Он приходит массивом из базы —
// в том порядке, в каком колонки стоят в таблице, то есть в том же, в каком они
// стоят в карточке. Человек ищет поле по знакомому месту.

// Общее для всех таблиц: служебные колонки, которые называются одинаково везде.
const COMMON = {
    id: 'Номер',
    created_at: 'Заведена',
    updated_at: 'Изменена',
    status: 'Статус',
    comment: 'Комментарий',
    notes: 'Комментарий',
    sort_order: 'Порядок'
};

const BY_TABLE = {
    leads: {
        last_name: 'Фамилия',
        first_name: 'Имя',
        middle_name: 'Отчество',
        phone: 'Телефон',
        phone_raw: 'Телефон, как пришёл',
        phone_normalized: 'Номер приведён',
        phone_fix_verdict: 'Разбор номера',
        phone_fix_reason_id: 'Причина разбора',
        merged_into_id: 'Слит с лидом',
        email: 'Почта',
        source_id: 'Источник',
        employee_id: 'Сотрудник',
        funnel_status_id: 'Статус воронки',
        script_id: 'Скрипт',
        repeat_script_id: 'Повторный скрипт',
        line_type: 'Линия',
        offer_id: 'Оффер',
        next_call_at: 'Перезвон',
        call_attempts: 'Попыток дозвона',
        opened_at: 'Взят в работу',
        archived_at: 'В архиве с',
        archived_by: 'В архив отправил',
        archived_actor_kind: 'В архив отправил, вид автора',
        archived_actor_name: 'В архив отправил, имя',
        archive_reason: 'Причина архива',
        missed_at: 'Пропущенный звонок',
        partially_filled: 'Заполнена частично',
        next_call_source: 'Перезвон назначен',
        origin: 'Происхождение',
        property_type: 'Тип объекта',
        property_class: 'Класс объекта',
        room_count: 'Комнатность',
        finish: 'Отделка',
        price_from: 'Цена от',
        price_to: 'Цена до',
        area_from: 'Площадь от',
        area_to: 'Площадь до',
        delivery_deadline: 'Срок сдачи',
        region: 'Область',
        city: 'Город',
        district: 'Район',
        client_type: 'Тип клиента',
        mortgage_type: 'Вид ипотеки',
        down_payment_percent: 'Первый взнос, %'
    },
    employees: {
        last_name: 'Фамилия',
        first_name: 'Имя',
        middle_name: 'Отчество',
        email: 'Почта',
        phone: 'Телефон',
        whatsapp: 'WhatsApp',
        telegram: 'Telegram',
        position: 'Должность',
        department: 'Отдел',
        manager_id: 'Руководитель',
        hire_date: 'Принят',
        password: 'Пароль',
        pbx_extension: 'Добавочный',
        pbx_password: 'Пароль АТС',
        pbx_extension_id: 'Расширение АТС',
        line_type: 'Линия',
        work_state: 'Состояние',
        on_line: 'На линии',
        on_line_since: 'На линии с',
        shift_start: 'Смена с',
        shift_end: 'Смена до',
        country: 'Страна',
        registration: 'Прописка',
        passport_series: 'Паспорт, серия',
        passport_number: 'Паспорт, номер',
        issued_by: 'Паспорт, кем выдан',
        issue_date: 'Паспорт, когда выдан',
        inn: 'ИНН',
        bank: 'Банк',
        account: 'Счёт',
        archive_kind: 'Вид архива',
        archived_at: 'В архиве с',
        tunnel_address: 'Адрес в туннеле',
        tunnel_public_key: 'Открытый ключ туннеля',
        tunnel_issued_at: 'Ключ выдан',
        tunnel_issued_by: 'Ключ выдал'
    },
    calls: {
        pbx_call_id: 'Вызов на АТС',
        direction: 'Направление',
        our_number: 'Наш номер',
        client_phone: 'Телефон клиента',
        lead_id: 'Лид',
        employee_id: 'Оператор',
        operator_extension: 'Добавочный оператора',
        outcome: 'Исход',
        outcome_raw: 'Исход, строка АТС',
        answered: 'Ответили',
        transferred: 'Был перевод',
        is_internal: 'Внутренний',
        started_at: 'Начало',
        answered_at: 'Ответ',
        ended_at: 'Конец',
        wait_seconds: 'Ожидание, с',
        talk_seconds: 'Разговор, с',
        record_id: 'Запись разговора',
        funnel_status_id: 'Статус воронки',
        funnel_status_name: 'Статус воронки, снимок',
        notes_snapshot: 'Комментарий, снимок',
        attempt_no: 'Номер попытки'
    },
    organizations: {
        name: 'Название',
        inn: 'ИНН',
        kpp: 'КПП',
        ogrn: 'ОГРН',
        legal_address: 'Юридический адрес',
        actual_address: 'Фактический адрес',
        letterhead_header: 'Шапка бланка',
        letterhead_signature: 'Подпись бланка'
    },
    sources: {
        lead_source: 'Источник лидов',
        root_source: 'Корневой источник',
        city_region: 'Город и регион',
        platform_id: 'Площадка'
    },
    cpa_networks: { name: 'Название', organization_id: 'Организация' },
    ad_platforms: { name: 'Название' },
    scripts: { title: 'Название', offer_id: 'Оффер' },
    script_nodes: { label: 'Подпись', node_type: 'Вид куска', parent_id: 'Внутри', script_id: 'Скрипт' },
    real_estate_offers: { name: 'Название', network_id: 'CPA-сеть' },
    lead_funnel_statuses: {
        stage_number: 'Номер этапа',
        stage_name: 'Этап',
        status_name: 'Статус',
        auto_recall: 'Автоперезвон',
        requires_call_time: 'Спросит время перезвона',
        releases_lead: 'Освобождает лида',
        mark: 'Пометка'
    },
    lead_script_statuses: { lead_id: 'Лид', script_id: 'Скрипт', funnel_status_id: 'Статус показа' },
    lead_offers: { lead_id: 'Лид', offer_id: 'Оффер' },
    app_settings: {
        key: 'Ключ',
        value: 'Значение',
        title: 'Название',
        description: 'Описание',
        value_type: 'Тип значения',
        unit: 'Единица',
        group_key: 'Группа',
        group_order: 'Порядок группы',
        is_readonly: 'Только чтение',
        is_dangerous: 'Опасная',
        default_value: 'Значение по умолчанию'
    },
    audit_rules: {
        table_name: 'Таблица',
        column_name: 'Колонка',
        level: 'Уровень записи',
        title_columns: 'Чем назвать запись',
        key_column: 'Колонка ключа',
        card_table: 'Чья карточка',
        card_column: 'Через какую колонку'
    },
    audit_ref_map: {
        table_name: 'Таблица',
        column_name: 'Колонка',
        ref_table: 'Справочник',
        ref_title_columns: 'Колонки имени'
    },
    audit_log: {
        // Строка отметки о выгрузке — единственная в журнале не от триггера.
        rows: 'Строк в файле',
        filters: 'Отбор'
    },
    phone_fix_reasons: { code: 'Код', title: 'Название' },
    employee_schedule_days: { day: 'День', state: 'Состояние дня', shift_start: 'Смена с', shift_end: 'Смена до', is_extra: 'Сверх графика' },
    employee_state_intervals: { state: 'Состояние', started_at: 'Начало', ended_at: 'Конец' },
    employee_documents: { file_name: 'Имя файла', file_data: 'Файл', doc_type: 'Вид документа' },
    tunnel_key_tokens: { employee_id: 'Сотрудник', used_at: 'Открыта', expires_at: 'Годна до', created_by: 'Выдал' },

    // Участок звонка. Своего имени у записи нет — журнал называет её номером;
    // подписи полей нужны всё равно, иначе строка правки покажет технические
    // имена моноширинным.
    call_segments: {
        call_id: 'Звонок',
        position: 'Место в цепочке',
        employee_id: 'Оператор',
        operator_extension: 'Добавочный',
        talk_seconds: 'Разговор, сек',
        transfer_offer_id: 'Оффер перевода',
        transfer_offer_name: 'Оффер перевода, имя',
        transfer_network_name: 'Оффер перевода, сеть'
    },

    // Три события руководителя и строки их перечней (часть 9). Подписи —
    // те же слова, что стоят на вкладке: журнал и экран обязаны называть одно
    // и то же одинаково, иначе искать правку приходится переводом.
    //
    // ⚠ ПОДПИСЬ `wait_seconds` У СОБЫТИЯ ОСТАЁТСЯ, ХОТЯ КОЛОНКИ БОЛЬШЕ НЕТ
    // (решение владельца 109, К259): журнал помнит правки снятой колонки, и без
    // подписи прошлое читалось бы техническим именем. То же правило, что у
    // девяти других снятых колонок словаря.
    call_events: {
        kind: 'Событие',
        enabled: 'Включено',
        window_from: 'Обзвон с',
        window_to: 'Обзвон до',
        wait_seconds: 'Ждать соединения, сек'
    },
    call_recall_rules: {
        funnel_status_id: 'Статус',
        interval_minutes: 'Интервал, мин',
        max_attempts: 'Предел попыток',
        after_limit_status_id: 'Статус после предела'
    },
    call_wrapup_rules: { line_type: 'Линия', script_id: 'Скрипт', duration_seconds: 'Длительность, сек' },
    call_transfer_offers: {
        offer_id: 'Оффер',
        transfer_phone: 'Номер для перевода',
        weekdays: 'Дни недели',
        time_from: 'Разрешён с',
        time_to: 'Разрешён до',
        wait_seconds: 'Ожидание, сек',
        enabled: 'Включена'
    },
    call_transfer_employees: {
        employee_id: 'Сотрудник',
        weekdays: 'Дни недели',
        time_from: 'Разрешён с',
        time_to: 'Разрешён до',
        wait_seconds: 'Ожидание, сек',
        enabled: 'Включена'
    }
};

/**
 * Человеческое имя поля или null, если такого имени мы не знаем.
 *
 * Null здесь — не ошибка и не пропуск: экран покажет техническое имя
 * моноширинным, и это честнее выдуманной подписи.
 */
export function fieldLabel(table, field) {
    const own = BY_TABLE[table];
    if (own && own[field]) return own[field];
    if (COMMON[field]) return COMMON[field];
    return null;
}

/** Сколько таблиц описано — число для отчёта, а не для работы. */
export const KNOWN_TABLES = Object.keys(BY_TABLE).length;
