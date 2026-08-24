// --- services/tunnelKeys.js: ключи туннеля и одноразовые ссылки на выдачу ---
//
// ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: закрытый ключ не сохраняется НИГДЕ — ни в базе,
// ни в файле, ни в журнале. Он рождается в момент открытия одноразовой ссылки,
// уходит в тело единственного ответа и исчезает вместе с ним.
//
// ИЗ ЭТОГО СЛЕДУЕТ, ПОЧЕМУ ПАРА РОЖДАЕТСЯ ПРИ ОТКРЫТИИ, А НЕ ПРИ ВЫДАЧЕ.
// Между выдачей ссылки и её открытием проходят часы: генерируя пару сразу, её
// закрытую половину пришлось бы все эти часы где-то держать — то есть
// сохранить. Зашифрованное хранение — тоже хранение. Поэтому при выдаче
// назначается только АДРЕС и заводится ссылка, а пара считается в момент
// показа. Следствие честное: пока ссылку не открыли, открытого ключа у
// сотрудника ещё нет и вносить в список допущенных нечего.
//
// ЧЕМ ОХРАНЯЕТСЯ СЕТЬ. Не этим файлом. Ключ сам по себе не пропуск: пока
// открытый ключ не внесён руками в [Peer] на сервере туннеля, пара — это
// бесполезные байты. Автоматического впуска здесь нет и быть не должно, пока
// в проекте нет входа: сегодня открытый API позволяет читать CRM — это плохо,
// но это чтение, а автоматический впуск раздавал бы пропуска ВНУТРЬ сети, где
// стоят и сервер, и телефония (правило 3 брифа, часть 1Б).

const crypto = require('crypto');

// Ключи WireGuard — сырые 32 байта Curve25519 в base64. Node умеет их сам,
// новых зависимостей не нужно. Проверено сравнением с `wg pubkey` (WireGuard
// 1.1 на машине разработки): открытый ключ, выведенный отсюда из закрытого,
// совпадает с тем, что считает сам WireGuard, знак в знак.
const PKCS8_PREFIX = 16;  // 48 байт DER = 16 служебных + 32 ключа
const SPKI_PREFIX = 12;   // 44 байта DER = 12 служебных + 32 ключа

function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX).toString('base64'),
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX).toString('base64')
    };
}

// Токен ссылки — 32 байта в base64url (решение куратора, zakaz_maketov.md,
// ответ 9 по Р1Б). base64url, а не hex: те же 32 байта шестнадцатеричными дают
// 64 знака против 43, а ссылку передают мессенджером, где длинный адрес рвётся
// переносом. Знаки base64url («-» и «_») в адресе безопасны и не требуют
// экранирования — в отличие от обычного base64 с «+» и «/».
function generateToken() {
    return crypto.randomBytes(32).toString('base64url');
}

// В базе лежит ХЕШ, а не токен. Утечка таблицы ссылок тогда не даёт ни одной
// рабочей ссылки: восстановить токен из sha256 нельзя, а сам токен живёт
// только в ссылке, которую руководитель отдал сотруднику.
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// --------------------------------------------------------------- настройки

// Параметры туннеля живут в переменных окружения, а не в коде: ключ сервера,
// его адрес и подсеть — свойства КОНКРЕТНОГО сервера, и в репозитории им
// делать нечего. Когда появится таблица настроек (часть 6), они переедут туда
// вместе с остальными; форма значения при этом не меняется.
const DEFAULTS = {
    mtu: '1280',
    // Оператор сидит за домашним роутером. Без периодического пакета NAT
    // забывает соответствие, и входящий звонок до него не доходит.
    keepalive: '25',
    allowedIps: '0.0.0.0/0',
    ttlHours: '24'
};

function readSettings(env = process.env) {
    const required = {
        TUNNEL_SERVER_PUBLIC_KEY: env.TUNNEL_SERVER_PUBLIC_KEY,
        TUNNEL_ENDPOINT: env.TUNNEL_ENDPOINT,
        TUNNEL_DNS: env.TUNNEL_DNS,
        TUNNEL_SUBNET: env.TUNNEL_SUBNET
    };
    const missing = Object.entries(required)
        .filter(([, value]) => !value || !String(value).trim())
        .map(([key]) => key);
    if (missing.length) {
        return { error: `Параметры туннеля не заданы: ${missing.join(', ')}` };
    }
    const ttlHours = Number(env.TUNNEL_LINK_TTL_HOURS || DEFAULTS.ttlHours);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
        return { error: 'TUNNEL_LINK_TTL_HOURS должен быть положительным числом часов' };
    }
    return {
        settings: {
            serverPublicKey: String(required.TUNNEL_SERVER_PUBLIC_KEY).trim(),
            endpoint: String(required.TUNNEL_ENDPOINT).trim(),
            dns: String(required.TUNNEL_DNS).trim(),
            subnet: String(required.TUNNEL_SUBNET).trim(),
            mtu: String(env.TUNNEL_MTU || DEFAULTS.mtu).trim(),
            keepalive: String(env.TUNNEL_KEEPALIVE || DEFAULTS.keepalive).trim(),
            allowedIps: String(env.TUNNEL_ALLOWED_IPS || DEFAULTS.allowedIps).trim(),
            ttlHours
        }
    };
}

// --------------------------------------------------------------- адреса

function ipToInt(ip) {
    const parts = String(ip).trim().split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const byte = Number(part);
        if (byte > 255) return null;
        value = value * 256 + byte;
    }
    return value;
}

function intToIp(value) {
    return [
        Math.floor(value / 16777216) % 256,
        Math.floor(value / 65536) % 256,
        Math.floor(value / 256) % 256,
        value % 256
    ].join('.');
}

/**
 * Свободный адрес подсети. Занятыми считаются уже выданные и не отозванные,
 * плюс служебные края подсети и сам сервер.
 *
 * Это только ВЫБОР КАНДИДАТА. Проверка «свободен ли» и запись идут разными
 * запросами, и между ними успевает вклиниться вторая выдача — настоящая
 * защита от совпадения одна: уникальный индекс в базе.
 */
function pickFreeAddress(subnet, takenList) {
    const [network, bitsRaw] = String(subnet).split('/');
    const base = ipToInt(network);
    const bits = Number(bitsRaw);
    if (base === null || !Number.isInteger(bits) || bits < 8 || bits > 30) {
        return { error: `Подсеть туннеля задана непонятно: ${subnet}` };
    }
    const size = 2 ** (32 - bits);
    const start = base - (base % size);
    const taken = new Set(takenList.filter(Boolean).map((a) => ipToInt(String(a).split('/')[0])));
    // Первый адрес подсети — сама сеть, второй занят сервером туннеля,
    // последний широковещательный. Людям раздаём начиная с третьего.
    for (let offset = 2; offset < size - 1; offset++) {
        const candidate = start + offset;
        if (!taken.has(candidate)) return { address: intToIp(candidate) };
    }
    return { error: 'В подсети туннеля не осталось свободных адресов' };
}

// --------------------------------------------------------------- имя файла

// Имя файла становится ИМЕНЕМ ТУННЕЛЯ в списке у оператора, поэтому латиница:
// кириллицу в имени туннеля на живом операторе не проверяли, а проверять на
// нём не надо (правило Ж6, план 18.9 п. 5).
const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

function transliterate(value) {
    return String(value || '')
        .toLowerCase()
        .split('')
        .map((ch) => (Object.prototype.hasOwnProperty.call(TRANSLIT, ch) ? TRANSLIT[ch] : ch))
        .join('')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Имя файла настройки: фамилия и добавочный латиницей, расширение .conf.
 *
 * Расширение обязано быть .conf: окно импорта WireGuard отбирает файлы по
 * расширению и .txt в списке не покажет — человек упрётся на ровном месте.
 *
 * СОТРУДНИК БЕЗ ДОБАВОЧНОГО. Паспорт Р1Б честно пишет, что решения по этому
 * случаю нет. Отказывать в выдаче нельзя: первыми туннель понадобился нашим
 * разработчикам в Кыргызстане, а добавочного у них нет вовсе. Поэтому имя
 * собирается из того, что есть, — «ivanov.conf». Если и фамилия не даёт ни
 * одной латинской буквы, остаётся «tunnel-<id>.conf»: файл без имени
 * бесполезен, а имя туннеля видно оператору и должно на что-то указывать.
 */
function configFileName(employee) {
    const name = transliterate(employee.last_name);
    const extension = String(employee.pbx_extension || '').trim();
    const parts = [name, extension].filter(Boolean);
    const base = parts.length ? parts.join('-') : `tunnel-${employee.id}`;
    return `${base}.conf`;
}

// --------------------------------------------------------------- настройка

/**
 * Текст настройки — ровно то, что WireGuard принимает импортом файла или
 * вставкой в пустой туннель. Одиннадцать строк; самая длинная — строка
 * закрытого ключа, 57 знаков, и под неё подобрана ширина листа страницы
 * (--ui-solo-w 520).
 */
function buildConfig({ privateKey, address, settings }) {
    return [
        '[Interface]',
        `PrivateKey = ${privateKey}`,
        `Address = ${address}/32`,
        `DNS = ${settings.dns}`,
        `MTU = ${settings.mtu}`,
        '',
        '[Peer]',
        `PublicKey = ${settings.serverPublicKey}`,
        `AllowedIPs = ${settings.allowedIps}`,
        `Endpoint = ${settings.endpoint}`,
        `PersistentKeepalive = ${settings.keepalive}`
    ].join('\n');
}

// --------------------------------------------------------------- время

const MOSCOW = 'Europe/Moscow';

/**
 * «25 августа, 12:40». Пояс называется рядом словом, а не подразумевается:
 * оператор сидит в другом поясе (Ташкент +2, Бишкек +3 к Москве), и «до 12:40»
 * без пояса он прочитает по-своему.
 *
 * Считается через Intl с явным поясом, а не по времени процесса: сервер может
 * работать в UTC, и тогда «по Москве» оказалось бы неправдой на два часа.
 */
function formatMoscow(date) {
    const value = date instanceof Date ? date : new Date(date);
    const day = new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, day: 'numeric', month: 'long' }).format(value);
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone: MOSCOW, hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
    return { day, time, full: `${day}, ${time}` };
}

/** «24.08.2026» — как в пилюле карточки. */
function formatDate(date) {
    const value = date instanceof Date ? date : new Date(date);
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: MOSCOW, day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(value);
}

module.exports = {
    generateKeyPair,
    generateToken,
    hashToken,
    readSettings,
    pickFreeAddress,
    transliterate,
    configFileName,
    buildConfig,
    formatMoscow,
    formatDate,
    MOSCOW
};
