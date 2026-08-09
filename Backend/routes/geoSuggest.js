// --- routes/geoSuggest.js: подсказки адреса (регион/город/район/нас. пункт)
// через DaData Suggestions API — прокси на сервере, чтобы API-ключ не
// светился в браузере (DaData сама допускает вызов с фронтенда, но ключ
// храним по тому же принципу, что DATABASE_URL — только в .env/переменных
// окружения, не в коде). Секретный ключ DaData тут не нужен вообще — для
// подсказок используется только сам API-ключ (Authorization: Token ...).

const express = require('express');

const router = express.Router();

const DADATA_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';

// GET /api/geo-suggest?q=Химки — возвращает подсказки DaData как есть
// (массив value/data), фронт сам решает, что показывать.
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
    try {
        const dadataRes = await fetch(DADATA_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Token ${apiKey}`
            },
            body: JSON.stringify({ query, count: 10 })
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
