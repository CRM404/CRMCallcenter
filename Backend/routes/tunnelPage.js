// --- routes/tunnelPage.js: страница выдачи настройки туннеля по ссылке ---
//
// Единственная страница проекта, которую открывает человек БЕЗ доступа к
// разделам, и открывает он её один раз в жизни ключа. Живёт вне оболочки:
// разделов, стола и панелей у оператора нет и быть не должно.
//
// ЗДЕСЬ РОЖДАЕТСЯ ПАРА КЛЮЧЕЙ. Не при выдаче ссылки, а именно здесь: закрытый
// ключ не сохраняется нигде, а между выдачей и открытием проходят часы —
// держать его эти часы было бы негде, кроме базы (см. services/tunnelKeys.js).
// Значит он существует ровно от строки generateKeyPair() до тела этого ответа.
//
// СТРАНИЦА СОБИРАЕТСЯ НА СЕРВЕРЕ и приезжает к человеку уже со своим
// состоянием: состояния «загрузка» у неё нет (паспорт Р1Б). Всё, что делает
// её скрипт, — кладёт значки, скачивает файл и копирует текст; без скрипта
// остаётся запасной путь, который на листе и так описан.

const express = require('express');
const { pool } = require('../db');
const tunnelKeys = require('../services/tunnelKeys');

const router = express.Router();

// Экранирование — единственная защита текста, попадающего в разметку. Имя
// сотрудника приходит из базы, а туда его вводит человек: незаэкранированное
// имя в innerHTML уже становилось находкой приёмки на прошлой задаче.
function esc(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Заголовки одни на все состояния страницы: её не кэшируют и не индексируют.
// no-store, а не no-cache: no-cache разрешает хранить копию и спрашивать
// сервер, а копия страницы с закрытым ключом на диске — ровно то, чего мы
// избегаем всей затеей с одноразовой ссылкой.
function setPageHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Referrer-Policy', 'no-referrer');
    res.type('html');
}

function page({ title, cardHtml, script = '' }) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>${esc(title)}</title>

    <!-- Порядок подключения — тот же, что у оболочки: токены, базовые,
         составные. Раскладка страницы (блок 5) — ниже, своим блоком: она
         принадлежит этой странице, а не слою. -->
    <link rel="stylesheet" href="/ui/tokens.css">
    <link rel="stylesheet" href="/ui/icons.css">
    <link rel="stylesheet" href="/ui/button.css">
    <link rel="stylesheet" href="/ui/field.css">
    <link rel="stylesheet" href="/ui/note.css">
    <link rel="stylesheet" href="/ui/solo.css">
    <link rel="stylesheet" href="/ui/toast.css">
    <style>
        /* Поля браузера у body: .ui-solo растянут на 100dvh, и восьми
           пикселей умолчания хватает, чтобы страница поехала полосой
           прокрутки на ровном месте. Сброс принадлежит странице: в слое
           ему места нет — оболочка свои поля задаёт сама. */
        html, body { margin: 0; }
    </style>
</head>
<body>
${cardHtml}
<script type="module">
    import { mountIconSprite } from '/ui/icons.js';
    mountIconSprite();
${script}
</script>
</body>
</html>`;
}

// --------------------------------------------------------------- состояния

/** Лист «ссылка жива»: тексты дословно из паспорта Р1Б. */
function aliveCard({ fullName, fileName, config, expiresLabel }) {
    const rows = config.split('\n').length;
    return `<div class="ui-solo">
    <div class="ui-solo__card">
        <div class="ui-solo__brand">CRM · настройка связи</div>
        <h1 class="ui-solo__title">Настройка для ${esc(fullName)}</h1>
        <p class="ui-solo__text">Скачайте файл и внесите его в WireGuard — он поднимет защищённое соединение, без которого звонки из-за границы не проходят.</p>
        <button type="button" class="ui-btn ui-btn--lg ui-btn--block" data-role="download"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-download"></use></svg>Скачать настройку</button>
        <div class="ui-note">
            <svg class="ui-ic ui-ic--sm ui-note__icon" aria-hidden="true"><use href="#ui-ic-doc"></use></svg>
            <div class="ui-note__body">
                <div class="ui-note__text">Файл <b>${esc(fileName)}</b>. Не переименовывайте его: этим именем туннель появится в списке WireGuard, по нему его потом и найдут.</div>
            </div>
        </div>
        <ol class="ui-solo__steps">
            <li>Откройте WireGuard на этом компьютере.</li>
            <li>Нажмите «Импорт туннелей из файла».</li>
            <li>Выберите скачанный файл и включите туннель.</li>
        </ol>
        <div class="ui-solo__meta">Ссылка действует до <b>${esc(expiresLabel)}</b> по Москве</div>
        <div class="ui-note ui-note--warn">
            <svg class="ui-ic ui-ic--sm ui-note__icon" aria-hidden="true"><use href="#ui-ic-warn"></use></svg>
            <div class="ui-note__body">
                <div class="ui-note__text">Страница открывается <b>один раз</b>. Закроете, не скачав, — попросите руководителя выдать ключ заново.</div>
            </div>
        </div>
        <div class="ui-solo__alt">
            <div class="ui-solo__brand">Если импорт файла не подходит</div>
            <div class="ui-field ui-field--mono">
                <label class="ui-field__label" for="tunnelConfig">Тот же текст настройки</label>
                <textarea class="ui-field__control" id="tunnelConfig" rows="${rows}" readonly>${esc(config)}</textarea>
                <span class="ui-field__hint">В WireGuard: «Добавить пустой туннель», вставить текст, сохранить.</span>
            </div>
            <div class="ui-btn-row ui-btn-row--end">
                <button type="button" class="ui-btn ui-btn--secondary" data-role="copy"><svg class="ui-ic ui-ic--sm" aria-hidden="true"><use href="#ui-ic-copy"></use></svg>Скопировать текст</button>
            </div>
        </div>
        <div class="ui-solo__foot">Соединение включится не сразу: сначала руководитель должен впустить ваш ключ. Если через час не заработало — напишите ему.</div>
    </div>
</div>`;
}

/**
 * Мёртвый лист. Два случая различаются НЕ ТОЛЬКО ТЕКСТОМ, и это главное в
 * обоих: «уже открывали» — возможный перехват, человека надо подтолкнуть
 * сказать об этом; «срок истёк» — бытовая ситуация, тревожить никого не нужно.
 * Одна заглушка на оба стёрла бы единственный признак утечки, который у нас
 * есть (паспорт Р1Б).
 */
function deadCard({ title, text, noteKind, noteIcon, noteTitle, noteText }) {
    const titleHtml = noteTitle ? `<div class="ui-note__title">${esc(noteTitle)}</div>` : '';
    return `<div class="ui-solo">
    <div class="ui-solo__card">
        <div class="ui-solo__brand">CRM · настройка связи</div>
        <h1 class="ui-solo__title">${esc(title)}</h1>
        <p class="ui-solo__text">${esc(text)}</p>
        <div class="ui-note${noteKind ? ' ui-note--' + noteKind : ''}">
            <svg class="ui-ic ui-ic--sm ui-note__icon" aria-hidden="true"><use href="#ui-ic-${esc(noteIcon)}"></use></svg>
            <div class="ui-note__body">
                ${titleHtml}
                <div class="ui-note__text">${esc(noteText)}</div>
            </div>
        </div>
        <div class="ui-solo__foot">Что делать: попросите руководителя выдать ключ заново.</div>
    </div>
</div>`;
}

const DEAD = {
    used: () => deadCard({
        title: 'Ссылка уже использована',
        text: 'По этой ссылке настройку уже забирали. Повторно она не выдаётся — так устроено намеренно: ссылка живёт до первого открытия.',
        noteKind: 'danger',
        noteIcon: 'warn',
        noteTitle: 'Если открываете впервые — скажите руководителю',
        noteText: 'Значит ссылку открыл кто-то другой. Ключ нужно отозвать и выдать новый, а старый — закрыть.'
    }),
    // Слово «сутки» приходит из настройки, а не вшито: срок задаётся
    // TUNNEL_LINK_TTL_HOURS, и если его однажды поменяют, текст не должен
    // остаться враньём. Не сутки — называем только сам срок.
    expired: (expiresLabel, ttlHours) => deadCard({
        title: 'Срок ссылки истёк',
        text: ttlHours === 24
            ? `Ссылка была действительна сутки — до ${expiresLabel}. Её никто не открывал, но время вышло.`
            : `Ссылка была действительна до ${expiresLabel}. Её никто не открывал, но время вышло.`,
        noteKind: '',
        noteIcon: 'info',
        noteText: 'Это не значит, что настройка попала в чужие руки: её просто не забрали. Отдельно сообщать никому не нужно.'
    }),
    // ЧЕТВЁРТЫЙ СЛУЧАЙ, КОТОРОГО В ПАСПОРТЕ НЕТ. Ссылку погасил перевыпуск:
    // руководитель выдал ключ заново, и у человека где-то есть ссылка посвежее.
    // Взять сюда текст «срок истёк» было нельзя — он говорит «время вышло», а
    // время не выходило. Лист и плашка те же, спокойные: перехвата здесь нет.
    revoked: () => deadCard({
        title: 'Ссылка больше не действует',
        text: 'Ключ выдали заново, и прежняя ссылка погашена. Работать будет только та, что выдана последней.',
        noteKind: '',
        noteIcon: 'info',
        noteText: 'Настройка в чужие руки не попадала: ссылку закрыли у нас. Если новой ссылки у вас нет — попросите её.'
    }),
    unknown: () => deadCard({
        title: 'Ссылка не найдена',
        text: 'Такой ссылки не существует. Возможно, она скопировалась не целиком: адрес обрывается, если переносить его по частям.',
        noteKind: '',
        noteIcon: 'info',
        noteText: 'Скопируйте ссылку из сообщения целиком и откройте ещё раз. Если не помогло — попросите выдать ключ заново.'
    })
};

// Скрипт живого листа. Скачивание собирается ИЗ ТЕКСТА, который уже лежит на
// странице: отдельного адреса у файла нет и быть не должно — иначе он пережил
// бы сгоревшую ссылку. Имя файла становится именем туннеля, поэтому оно
// задаётся явно и с расширением .conf: окно импорта WireGuard отбирает файлы
// по расширению и .txt в списке не покажет.
function aliveScript(fileName) {
    return `    import { showToast } from '/ui/toast.js';
    const area = document.getElementById('tunnelConfig');
    document.querySelector('[data-role="download"]').addEventListener('click', () => {
        const blob = new Blob([area.value], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = ${JSON.stringify(fileName)};
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Отпускаем ссылку на данные не мгновенно: часть браузеров читает blob
        // уже после клика, и отозванный в ту же миллисекунду адрес даёт пустой
        // файл вместо настройки.
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
    document.querySelector('[data-role="copy"]').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(area.value);
            showToast('Текст настройки скопирован', 'success');
        } catch (e) {
            // Буфер обмена недоступен без защищённого соединения и без
            // разрешения. Молчать нельзя: человек нажал и ждёт результата.
            area.select();
            showToast('Браузер не дал доступ к буферу обмена — текст выделен, скопируйте его сами', 'error');
        }
    });`;
}

// --------------------------------------------------------------- заслон

/**
 * ССЫЛКУ СЖИГАЕТ ЧЕЛОВЕК, А НЕ ПРЕДПРОСМОТР МЕССЕНДЖЕРА.
 *
 * Ссылку руководитель отдаёт сотруднику перепиской — это и есть замысел: в
 * переписке лежит ссылка, а не файл. Но мессенджер, увидев ссылку, идёт по ней
 * САМ, чтобы нарисовать карточку предпросмотра. Без заслона первое же реальное
 * применение выглядело бы так: руководитель отправил ссылку, Telegram её
 * открыл, ключ родился и сгорел, а оператор увидел «ссылка уже использована» и
 * плашку про возможный перехват. Механизм сломался бы на первом же человеке.
 *
 * Отличаем переход человека от захода робота по заголовкам, которые ставит
 * только браузер и только при переходе по адресу: Sec-Fetch-Mode: navigate.
 * Роботы предпросмотра их не шлют. Предзагрузка браузера (Sec-Purpose:
 * prefetch) тоже не считается переходом — человек ещё ничего не открыл.
 *
 * Всё, что не похоже на переход человека, получает заглушку без единого
 * секрета и БЕЗ сжигания ссылки. Браузер, который заголовков не шлёт (старый
 * или редкий), уедет с заглушки сам — скриптом или ссылкой, если скрипта нет.
 */
function looksLikeHumanNavigation(req) {
    if (req.query.open === '1') return true;
    const purpose = String(req.get('sec-purpose') || req.get('purpose') || '').toLowerCase();
    if (purpose.includes('prefetch') || purpose.includes('prerender')) return false;
    return req.get('sec-fetch-mode') === 'navigate';
}

function stubPage(token) {
    const href = `/k/${encodeURIComponent(token)}?open=1`;
    return page({
        title: 'CRM · настройка связи',
        cardHtml: `<div class="ui-solo">
    <div class="ui-solo__card">
        <div class="ui-solo__brand">CRM · настройка связи</div>
        <h1 class="ui-solo__title">Открываем настройку…</h1>
        <p class="ui-solo__text">Если ничего не произошло, нажмите ссылку ниже.</p>
        <p class="ui-solo__text"><a href="${esc(href)}">Открыть настройку</a></p>
    </div>
</div>`,
        script: `    location.replace(${JSON.stringify(href)});`
    });
}

// --------------------------------------------------------------- маршрут

router.get('/:token', async (req, res) => {
    setPageHeaders(res);
    const token = String(req.params.token || '');

    if (!looksLikeHumanNavigation(req)) {
        return res.send(stubPage(token));
    }

    try {
        const hash = tunnelKeys.hashToken(token);

        // СЖИГАНИЕ И ПРОВЕРКА — ОДНИМ ЗАПРОСОМ. Два открытия в одну секунду
        // (человек и его же второй щелчок) иначе оба увидели бы живую ссылку и
        // получили бы РАЗНЫЕ пары ключей: в списке допущенных остался бы один
        // открытый ключ, а на руках два файла, и один из них не работал бы
        // молча. Условие в WHERE — единственное место, где решается, жива ли
        // ссылка.
        const burned = await pool.query(
            `UPDATE tunnel_key_tokens SET used_at = NOW()
              WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
              RETURNING id, employee_id, expires_at`,
            [hash]
        );

        if (burned.rows.length === 0) {
            // Ссылка не сгорела — значит мёртвая. Причину спрашиваем отдельно:
            // от неё зависит не только текст, но и смысл — надо ли человеку
            // бежать к руководителю.
            const found = await pool.query(
                'SELECT used_at, revoked_at, expires_at FROM tunnel_key_tokens WHERE token_hash = $1',
                [hash]
            );
            if (found.rows.length === 0) return res.send(page({ title: 'Ссылка не найдена', cardHtml: DEAD.unknown() }));
            const row = found.rows[0];
            if (row.used_at) return res.send(page({ title: 'Ссылка уже использована', cardHtml: DEAD.used() }));
            if (row.revoked_at) return res.send(page({ title: 'Ссылка больше не действует', cardHtml: DEAD.revoked() }));
            const ttl = tunnelKeys.readSettings();
            return res.send(page({
                title: 'Срок ссылки истёк',
                cardHtml: DEAD.expired(
                    tunnelKeys.formatMoscow(row.expires_at).full,
                    ttl.settings ? ttl.settings.ttlHours : 24
                )
            }));
        }

        const read = tunnelKeys.readSettings();
        const employee = (await pool.query(
            'SELECT id, last_name, first_name, status, pbx_extension, tunnel_address, tunnel_revoked_at FROM employees WHERE id = $1',
            [burned.rows[0].employee_id]
        )).rows[0];

        // Ссылка сгорела, а собрать настройку не из чего: параметров туннеля
        // нет, сотрудника нет, адрес отобрали правкой мимо интерфейса. Случай
        // невозможный при обычной работе, но если он случился — человеку надо
        // сказать правду и позвать руководителя, а не показать пустой лист.
        if (read.error || !employee || !employee.tunnel_address || employee.tunnel_revoked_at) {
            console.error('Настройка туннеля не собрана по живой ссылке:',
                read.error || (employee ? 'у сотрудника нет действующего адреса' : 'сотрудник не найден'));
            return res.send(page({ title: 'Ссылка больше не действует', cardHtml: DEAD.revoked() }));
        }

        // ЗДЕСЬ РОЖДАЕТСЯ ПАРА. Закрытая половина уходит в разметку ответа и
        // больше нигде не появляется: ни в базе, ни в файле, ни в журнале.
        // Сохраняем только открытую — её вносят в список допущенных руками.
        const pair = tunnelKeys.generateKeyPair();
        await pool.query('UPDATE employees SET tunnel_public_key = $1 WHERE id = $2', [pair.publicKey, employee.id]);

        const config = tunnelKeys.buildConfig({
            privateKey: pair.privateKey,
            address: employee.tunnel_address,
            settings: read.settings
        });
        const fileName = tunnelKeys.configFileName(employee);

        res.send(page({
            title: 'Настройка связи',
            cardHtml: aliveCard({
                fullName: `${employee.last_name} ${employee.first_name}`,
                fileName,
                config,
                expiresLabel: tunnelKeys.formatMoscow(burned.rows[0].expires_at).full
            }),
            script: aliveScript(fileName)
        }));
    } catch (err) {
        console.error(err);
        res.status(500).send(page({
            title: 'Настройка недоступна',
            cardHtml: deadCard({
                title: 'Не удалось открыть настройку',
                text: 'Сервер не смог отдать настройку.',
                noteKind: 'danger',
                noteIcon: 'warn',
                // Сгорела ли ссылка, отсюда не видно: отказ мог случиться и до
                // сжигания, и после. Обещать человеку что-то одно нельзя —
                // говорим, что делать в обоих случаях.
                noteText: 'Попробуйте открыть ссылку ещё раз. Если снова не вышло — попросите руководителя выдать ключ заново.'
            })
        }));
    }
});

module.exports = router;
