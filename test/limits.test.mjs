// Лимиты, бюджет и доступ. Здесь ошибка стоит денег: каждый лишний
// вызов модели оплачивается, поэтому всё проверяется до вызова.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, analyzeRequest, body3, runAnalysis, SITE } from './helpers.mjs';

function longText(n) {
    // Русский текст нужной длины: ровно n символов.
    const chunk = 'Слово за словом складывается длинный текст. ';
    let s = '';
    while (s.length < n) s += chunk;
    return s.slice(0, n);
}

test('GET на запуск разбора: 405', async () => {
    const h = makeHarness();
    const res = await h.app.analyze(analyzeRequest(null, { method: 'PUT' }));
    assert.equal(res.status, 405);
});

test('чужой Origin: 403, модель не вызвана', async () => {
    const h = makeHarness();
    const res = await h.app.analyze(analyzeRequest(body3(), { origin: 'https://evil.example' }));
    assert.equal(res.status, 403);
    assert.equal(h.modelCalls.length, 0);
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
});

test('без Origin: 403', async () => {
    const h = makeHarness();
    const req = new Request(SITE + '/api/analyze', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body3()),
    });
    const res = await h.app.analyze(req);
    assert.equal(res.status, 403);
});

test('40 001 символ всего: 413', async () => {
    const h = makeHarness();
    const body = { scenario: 'course', texts: [
        { id: 't1', genre: 'post', text: longText(20000) },
        { id: 't2', genre: 'post', text: longText(20000) },
        { id: 't3', genre: 'post', text: longText(1) },
    ] };
    const res = await h.app.analyze(analyzeRequest(body));
    assert.equal(res.status, 413);
});

test('40 000 символов кириллицы проходят: тело в UTF-8 больше 60 КБ, и это нормально', async () => {
    // Спека ставила тело до 60 КБ, но 40 000 кириллических знаков в UTF-8
    // это около 80 КБ. Потолок тела поднят, иначе разрешённый объём
    // отбивался бы раньше, чем до него дошла проверка.
    const h = makeHarness();
    const body = { scenario: 'course', texts: [
        { id: 't1', genre: 'post', text: longText(20000) },
        { id: 't2', genre: 'post', text: longText(20000) },
    ] };
    const res = await h.app.analyze(analyzeRequest(body));
    assert.equal(res.status, 202);
});

test('299 символов: 400', async () => {
    const h = makeHarness();
    const res = await h.app.analyze(analyzeRequest({ scenario: 'course', texts: [{ id: 't1', genre: 'post', text: longText(299) }] }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.reason, 'причина названа');
});

test('31 текст: 400', async () => {
    const h = makeHarness();
    const texts = [];
    for (let i = 0; i < 31; i++) texts.push({ id: 't' + i, genre: 'post', text: longText(50) });
    const res = await h.app.analyze(analyzeRequest({ scenario: 'course', texts: texts }));
    assert.equal(res.status, 400);
});

test('неизвестный жанр: 400', async () => {
    const h = makeHarness();
    const body = body3();
    body.texts[0].genre = 'tiktok';
    const res = await h.app.analyze(analyzeRequest(body));
    assert.equal(res.status, 400);
});

test('неизвестный сценарий, повтор id, битый JSON: 400', async () => {
    const h = makeHarness();
    const b1 = body3(); b1.scenario = 'crypto';
    assert.equal((await h.app.analyze(analyzeRequest(b1))).status, 400);

    const b2 = body3(); b2.texts[1].id = 't1';
    assert.equal((await h.app.analyze(analyzeRequest(b2))).status, 400);

    assert.equal((await h.app.analyze(analyzeRequest('{не json'))).status, 400);
});

test('один текст длиннее 20 000: 413', async () => {
    const h = makeHarness();
    const res = await h.app.analyze(analyzeRequest({ scenario: 'course', texts: [{ id: 't1', genre: 'post', text: longText(20001) }] }));
    assert.equal(res.status, 413);
});

test('11-й запрос за час с одного IP: 429', async () => {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) {
        const b = body3();
        b.texts[0].text += ' Вариант ' + i + '.';
        const res = await h.app.analyze(analyzeRequest(b, { ip: '203.0.113.7' }));
        assert.equal(res.status, 202, 'запрос ' + (i + 1) + ' проходит');
    }
    const res = await h.app.analyze(analyzeRequest(body3(), { ip: '203.0.113.7' }));
    assert.equal(res.status, 429);

    const other = await h.app.analyze(analyzeRequest(body3(), { ip: '198.51.100.1' }));
    assert.notEqual(other.status, 429, 'соседний адрес не страдает');
});

test('попадание в кэш тоже считается запросом', async () => {
    const h = makeHarness();
    await runAnalysis(h, body3(), { ip: '203.0.113.9' });
    for (let i = 0; i < 9; i++) {
        const res = await h.app.analyze(analyzeRequest(body3(), { ip: '203.0.113.9' }));
        assert.equal(res.status, 200);
    }
    const res = await h.app.analyze(analyzeRequest(body3(), { ip: '203.0.113.9' }));
    assert.equal(res.status, 429);
});

test('в хранилище лимитов нет IP в открытом виде', async () => {
    const h = makeHarness();
    await h.app.analyze(analyzeRequest(body3(), { ip: '203.0.113.7' }));
    const dump = JSON.stringify(h.stores.ratelimit.dump());
    assert.ok(dump.indexOf('203.0.113.7') === -1, dump);
});

test('бюджет исчерпан, новый текст: 503, модель не вызвана', async () => {
    const h = makeHarness({ env: { DAILY_CAP: '0' } });
    const res = await h.app.analyze(analyzeRequest(body3()));
    assert.equal(res.status, 503);
    assert.equal(h.modelCalls.length, 0);
});

test('бюджет исчерпан, текст из кэша: 200 и X-Cache: HIT', async () => {
    const h = makeHarness({ env: { DAILY_CAP: '1' } });
    const first = await runAnalysis(h, body3());
    assert.equal(first.status, 200);
    assert.equal(h.modelCalls.length, 1);

    const res = await h.app.analyze(analyzeRequest(body3()));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'HIT');
    assert.equal(h.modelCalls.length, 1, 'второго вызова нет');

    const fresh = body3();
    fresh.texts[0].text += ' Новое.';
    const blocked = await h.app.analyze(analyzeRequest(fresh));
    assert.equal(blocked.status, 503);
});

test('фоновая функция без подписи или с чужим заданием: отказ и ни одного вызова модели', async () => {
    const h = makeHarness();
    const noToken = new Request(SITE + '/.netlify/functions/analyze-background', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: 'job-1', scenario: 'course', texts: body3().texts }),
    });
    const res = await h.app.background(noToken);
    assert.equal(res.status, 403);
    assert.equal(h.modelCalls.length, 0);
});
