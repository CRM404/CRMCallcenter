// --- routes/geoSuggest.js: подсказки адреса (регион/город/район/нас. пункт)
// через DaData Suggestions API — прокси на сервере, чтобы API-ключ не
// светился в браузере (DaData сама допускает вызов с фронтенда, но ключ
// храним по тому же принципу, что DATABASE_URL — только в .env/переменных
// окружения, не в коде). Секретный ключ DaData тут не нужен вообще — для
// подсказок используется только сам API-ключ (Authorization: Token ...).

const express = require('express');

const router = express.Router();

const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';

// Уровни адреса, которыми можно ограничить поиск (report_2026-08-01.md,
// 09.08.2026) — проверено живыми запросами к DaData, оба bound одним
// значением дают поиск строго внутри этого уровня, без утечек соседних.
const GEO_BOUNDS = ['region', 'area', 'city', 'settlement'];

// GET /api/geo-suggest?q=Химки&bound=city&regionFiasId=... — возвращает
// подсказки DaData как есть (массив value/data), фронт сам решает, что
// показывать. bound/regionFiasId необязательны — без них ищет как раньше,
// по всей стране и всем уровням сразу.
router.get('/', async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) {
        return res.json({ suggestions: [] });
    }
    const apiKey = process.env.DADATA_API_KEY;
    if (!apiKey) {
        console.error('DADATA_API_KEY не задан в переменных окружения');
        return res.status(500).json({ error: 'Подсказки адреса временно недоступны' });
    }
    const bound = GEO_BOUNDS.includes(req.query.bound) ? req.query.bound : undefined;
    const regionFiasId = req.query.regionFiasId;
    const body = { query, count: 10 };
    if (bound) {
        body.from_bound = { value: bound };
        body.to_bound = { value: bound };
    }
    if (regionFiasId) {
        body.locations = [{ region_fias_id: regionFiasId }];
    }
    try {
        const dadataRes = await fetch(DADATA_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Token ${apiKey}`
            },
            body: JSON.stringify(body)
        });
        if (!dadataRes.ok) {
            console.error('DaData вернула ошибку:', dadataRes.status, await dadataRes.text());
            return res.status(502).json({ error: 'Не удалось получить подсказки адреса' });
        }
        const data = await dadataRes.json();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Не удалось получить подсказки адреса' });
    }
});

module.exports = router;
