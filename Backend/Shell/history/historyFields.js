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
        down_payment_percent: 'Первый взнос, %',
        locality: 'Населённый пункт',
        client_region: 'Область клиента',
        client_city: 'Город клиента',
        client_district: 'Район клиента',
        client_locality: 'Населённый пункт клиента',
        purchase_method: 'Способ покупки',
        purchase_timeframe: 'Срок покупки',
        decision_maker: 'ЛПР',
        other_borrower: 'Иной заёмщик',
        category: 'Категория',
        last_call_at: 'Последний звонок',
        phone_fix_at: 'Разобран',
        phone_fix_actor_name: 'Разобрал',
        phone_fix_actor_kind: 'Разобрал, вид автора',
        phone_fix_actor_id: 'Разобрал, номер автора',
        merged_at: 'Слит',
        archived_actor_id: 'В архив отправил, номер автора'
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
        tunnel_issued_by: 'Ключ выдал',
        termination_date: 'Уволен',
        work_schedule: 'Дни',
        released_lead_notice: 'Лид вернулся в очередь',
        frozen_at: 'Заморожен с',
        tunnel_key_at: 'Ключ получен',
        tunnel_revoked_at: 'Ключ туннеля отозван'
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
        attempt_no: 'Номер попытки',
        pbx_api_id: 'Управление вызовом на АТС',
        pbx_callback_id: 'Наша инициация на АТС',
        partially_filled: 'Заполнена частично'
    },
    organizations: {
        name: 'Название',
        inn: 'ИНН',
        kpp: 'КПП',
        ogrn: 'ОГРН',
        legal_address: 'Юридический адрес',
        actual_address: 'Фактический адрес',
        letterhead_header: 'Шапка бланка',
        letterhead_signature: 'Подпись бланка',
        legal_form: 'ОПФ',
        general_director: 'Генеральный директор',
        registration_country: 'Страна регистрации',
        registration_date: 'Дата регистрации',
        okved: 'ОКВЭД',
        authorized_capital: 'Уставный капитал'
    },
    sources: {
        lead_source: 'Источник лидов',
        root_source: 'Корневой источник',
        city_region: 'Город и регион',
        platform_id: 'Площадка'
    },
    cpa_networks: { name: 'Название', organization_id: 'Организация', connected_at: 'Подключена', payout_currency: 'Валюта выплат', commission_percent: 'Комиссия, %' },
    ad_platforms: { name: 'Название' },
    scripts: { title: 'Название', offer_id: 'Оффер' },
    script_nodes: { label: 'Подпись', node_type: 'Вид куска', parent_id: 'Внутри', script_id: 'Скрипт', content: 'Текст' },
    real_estate_offers: {
        name: 'Название',
        network_id: 'CPA-сеть',
        category: 'Категория',
        date_start: 'Действует с',
        date_end: 'Действует по',
        action_type: 'Тип действия',
        rate: 'Ставка, ₽',
        hold_days: 'Hold, дней',
        lead_check: 'Наличие проверки лидов',
        target_criteria: 'Критерии целевого лида',
        non_target_criteria: 'Критерии нецелевого лида',
        obj_types: 'Тип объекта',
        finishes: 'Отделка',
        developer: 'Застройщик',
        deadline: 'Срок сдачи',
        client_types: 'Тип клиента',
        other_borrower: 'Иной заёмщик',
        purchase_term: 'Срок покупки',
        down_payment_percent: 'Первоначальный взнос, %',
        priority: 'Приоритет',
        lead_limit: 'Лимит лидов'
    },
    lead_funnel_statuses: {
        stage_number: 'Номер этапа',
        stage_name: 'Этап',
        status_name: 'Статус',
        auto_recall: 'Автоперезвон',
        requires_call_time: 'Спросит время перезвона',
        releases_lead: 'Освобождает лида',
        mark: 'Пометка',
        is_system: 'Системный',
        awaits_manager: 'Ждёт решения руководителя'
    },
    lead_script_statuses: { lead_id: 'Лид', script_id: 'Скрипт', funnel_status_id: 'Статус показа' },
    lead_offers: { lead_id: 'Лид', offer_id: 'Оффер' },
    // Текст комментария журнал не хранит — уровень `fact`. Подпись всё равно
    // нужна: без неё поле встало бы в журнале машинным именем.
    lead_comments: {
        lead_id: 'Лид',
        call_id: 'Звонок',
        author_employee_id: 'Автор',
        body: 'Текст комментария',
        created_at: 'Когда написан',
        is_migrated: 'Перенесён из старого поля'
    },
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
    employee_schedule_days: { employee_id: 'Сотрудник', day: 'День', state: 'Состояние дня', shift_start: 'Смена с', shift_end: 'Смена до', is_extra: 'Сверх графика' },
    employee_state_intervals: { employee_id: 'Сотрудник', state: 'Состояние', started_at: 'Начало', ended_at: 'Конец' },
    employee_documents: { employee_id: 'Сотрудник', document_type: 'Вид документа', file_name: 'Имя файла', file_data: 'Файл', uploaded_at: 'Загружен' },
    tunnel_key_tokens: { employee_id: 'Сотрудник', token_hash: 'Отпечаток ссылки', used_at: 'Открыта', expires_at: 'Годна до', revoked_at: 'Погашена', created_by: 'Выдал' },

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
        transfer_network_name: 'Оффер перевода, сеть',
        pbx_sub_call_id: 'Плечо на АТС',
        started_at: 'Начало',
        answered_at: 'Ответ',
        ended_at: 'Конец'
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
        wait_seconds: 'Ждать соединения, сек',
        wrapup_status_id: 'Статус после пост-обработки'
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
    },
    // ===== Таблицы, которых словарь не знал вовсе (К258) =====================
    //
    // Шестнадцать таблиц под журналом не имели ни одной подписи: их правки
    // читались техническими именами целиком. Подписи взяты с экранов, где поле
    // уже подписано человеку, и из комментариев схемы там, где экрана нет.

    departments: { organization_id: 'Организация', name: 'Название' },
    offers: { name: 'Название' },
    param_lists: { list_key: 'Список', value: 'Значение' },
    source_cpa_networks: { source_id: 'Источник', cpa_network_id: 'CPA-сеть' },
    lead_distribution_pool: { lead_id: 'Лид', employee_id: 'Сотрудник' },
    lead_funnel_stages: { stage_number: 'Номер этапа', description: 'Описание этапа' },
    employee_column_settings: { employee_id: 'Сотрудник', hidden_columns: 'Скрытые колонки' },

    // Счета и налоги организации — подписи с экрана «Реквизиты».
    organization_bank_accounts: {
        organization_id: 'Организация',
        bank_name: 'Название банка',
        bik: 'БИК',
        checking_account: 'Расчётный счёт',
        correspondent_account: 'Корреспондентский счёт',
        currency: 'Валюта',
        opened_at: 'Дата открытия'
    },
    organization_taxes: {
        organization_id: 'Организация',
        tax_type: 'Вид налога',
        rate: 'Ставка',
        periodicity: 'Периодичность'
    },

    // База знаний.
    knowledge_articles: {
        title: 'Заголовок',
        content: 'Текст',
        is_restricted: 'Ограничен доступ',
        author_employee_id: 'Автор'
    },
    knowledge_article_attachments: {
        article_id: 'Статья',
        file_name: 'Имя файла',
        file_data: 'Файл',
        uploaded_at: 'Загружен'
    },
    knowledge_article_visibility: { article_id: 'Статья', employee_id: 'Сотрудник' },

    // Оффер: сегменты, география и два множественных выбора. Слово `value` в
    // двух последних значит РАЗНОЕ, и подписи у них поэтому разные — иначе
    // строка журнала не сказала бы, что именно меняли.
    real_estate_offer_segments: {
        offer_id: 'Оффер',
        label: 'Подпись сегмента',
        object_class: 'Класс объекта',
        price_min: 'Цена от',
        price_max: 'Цена до',
        area_min: 'Площадь от',
        area_max: 'Площадь до',
        room_count: 'Комнатность'
    },
    real_estate_offer_geo: {
        offer_id: 'Оффер',
        kind: 'Чья география',
        region: 'Область',
        city: 'Город',
        district: 'Район',
        locality: 'Населённый пункт'
    },
    real_estate_offer_payment_methods: { offer_id: 'Оффер', value: 'Способ покупки' },
    real_estate_offer_mortgage_types: { offer_id: 'Оффер', value: 'Вид ипотеки' },
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
