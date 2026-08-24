// --- services/phoneFormat.js: единый формат телефона (часть 4, Б1.1) ---
//
// ОДНА ФУНКЦИЯ ПРИВЕДЕНИЯ НА ВЕСЬ ПРОЕКТ. До неё поиск лида по номеру был
// сравнением строки со строкой (routes/leadsAdmin.js, GET /check-phone и
// массовая загрузка), и «+7 916 123-45-67», «8 916 1234567», «9161234567» были
// тремя разными людьми для базы. Пока звонят только наружу — это грязь; с
// приходом входящих становится блокирующим: АТС присылает номер в своём виде, и
// лида, к которому он относится, мы не найдём никогда (план 5.1).
//
// ФОРМАТ: +7XXXXXXXXXX — плюс, семёрка, десять цифр, одиннадцать знаков, без
// пробелов, скобок и дефисов (план 5.2). Хранится в этом виде.
//
// ЧТО НЕ РАЗОБРАЛОСЬ — НЕ ЧИНИМ МОЛЧА. Функция никогда не «догадывается»:
// непонятная строка возвращается нетронутой с названной причиной. Молча
// исправленный номер означает звонок не тому человеку (план 5.3).
//
// ПОРЯДОК НАЗНАЧЕНИЯ ПРИЧИНЫ ОБЯЗАТЕЛЕН: пусто → буквы → длина (паспорт Р10,
// решение куратора). Строка «8 (916) 123-45-67 доб. 102» подходит сразу под две
// причины — «есть буквы» и «цифр больше одиннадцати». Без названного порядка
// она получала бы разную причину в зависимости от того, какая проверка
// сработала первой, а счётчики на экране разбора посчитали бы её дважды.
// Довод порядка: «пусто» и «буквы» — про саму строку, длина — про то, что от
// неё осталось после вычистки.
//
// СТРОКА ПОЛУЧАЕТ РОВНО ОДНУ ПРИЧИНУ.

// Коды причин. Латиницей — как kind у аудита; человеческие названия лежат
// справочником в базе (phone_fix_reasons), потому что паспорт Р10 требует
// «значение справочника, а не текст»: по ним отбирают и считают.
const REASON_EMPTY = 'empty';                    // номера нет вовсе
const REASON_LETTERS = 'letters';                // в строке есть буквы
const REASON_DIGITS_LT_10 = 'digits_lt_10';      // цифр меньше десяти
const REASON_TEN_NOT_NINE = 'ten_not_nine';      // десять цифр, голова не девятка
const REASON_ELEVEN_FOREIGN = 'eleven_foreign';  // одиннадцать цифр, голова не 7 и не 8
const REASON_DIGITS_GT_11 = 'digits_gt_11';      // цифр больше одиннадцати

const REASONS = [
    REASON_EMPTY,
    REASON_LETTERS,
    REASON_DIGITS_LT_10,
    REASON_TEN_NOT_NINE,
    REASON_ELEVEN_FOREIGN,
    REASON_DIGITS_GT_11
];

// Буква ЛЮБОГО алфавита, а не только латиница: «доб.» пишут и кириллицей, и
// латиницей («ext»), и вперемешку.
const HAS_LETTER = /\p{L}/u;

// Приведение одной строки.
//
// Возвращает всегда одну и ту же форму, чтобы вызывающему не приходилось
// гадать: { phone, changed, reason, digits }.
//   phone   — приведённый номер (+7XXXXXXXXXX) либо ИСХОДНАЯ строка, если не
//             разобралось. Никогда не null у непустого входа: в базе колонка
//             NOT NULL, и подставлять туда пустоту вместо непонятного номера
//             значило бы потерять то единственное, по чему человека можно найти;
//   changed — приведение реально изменило строку;
//   reason  — код причины, по которой не разобралось, либо null;
//   digits  — сколько в строке цифр. Второй сигнал для экрана разбора и
//             единственный там, где подсвечивать нечего («916123»).
function normalizePhone(raw) {
    const source = raw === null || raw === undefined ? '' : String(raw);
    const trimmed = source.trim();
    const digits = trimmed.replace(/\D/g, '');

    // 1 · Пусто. Считаем пустой и строку без единой цифры («—», «нет»): звонить
    //     по ней некуда ровно так же.
    if (trimmed === '' || digits === '') {
        return { phone: trimmed, changed: false, reason: REASON_EMPTY, digits: 0 };
    }

    // 2 · Буквы. Проверяется ДО длины — см. шапку.
    if (HAS_LETTER.test(trimmed)) {
        return { phone: trimmed, changed: false, reason: REASON_LETTERS, digits: digits.length };
    }

    // 3 · Длина. Три случая приводятся (таблица 5.3 плана), четыре — нет.
    if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) {
        const phone = '+7' + digits.slice(1);
        return { phone, changed: phone !== trimmed, reason: null, digits: 11 };
    }
    if (digits.length === 10 && digits[0] === '9') {
        const phone = '+7' + digits;
        return { phone, changed: phone !== trimmed, reason: null, digits: 10 };
    }

    let reason;
    if (digits.length < 10) reason = REASON_DIGITS_LT_10;
    else if (digits.length === 10) reason = REASON_TEN_NOT_NINE;
    else if (digits.length === 11) reason = REASON_ELEVEN_FOREIGN;
    else reason = REASON_DIGITS_GT_11;

    return { phone: trimmed, changed: false, reason, digits: digits.length };
}

// Разобрался ли номер — то же приведение, но одним булевым ответом.
function isNormalized(value) {
    return normalizePhone(value).reason === null;
}

// Приведение для ПОИСКА, и оно другое.
//
// Человек ищет по куску номера: «916», «123-45-67». Такой кусок под формат не
// подходит и через normalizePhone вернулся бы нетронутым — а искать надо по
// цифрам, потому что в базе номер лежит без скобок и дефисов, а сырые строки
// неприведённых лидов — со всем этим сразу.
//
// Возвращает { exact, digits }: exact — полный номер, если введённое им и
// является (тогда ищем точное совпадение), digits — только цифры для поиска
// вхождением.
function normalizeForSearch(value) {
    const result = normalizePhone(value);
    return {
        exact: result.reason === null ? result.phone : null,
        digits: String(value === null || value === undefined ? '' : value).replace(/\D/g, '')
    };
}

module.exports = {
    normalizePhone,
    isNormalized,
    normalizeForSearch,
    REASONS,
    REASON_EMPTY,
    REASON_LETTERS,
    REASON_DIGITS_LT_10,
    REASON_TEN_NOT_NINE,
    REASON_ELEVEN_FOREIGN,
    REASON_DIGITS_GT_11
};
