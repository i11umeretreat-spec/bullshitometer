// Счётчики метрики. Идентификаторов людей и результатов нет,
// только число событий по дням.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, SITE } from './helpers.mjs';

function ev(type, opts) {
    opts = opts || {};
    const headers = { 'content-type': 'application/json', origin: opts.origin || SITE };
    if (opts.ip) headers['x-nf-client-connection-ip'] = opts.ip;
    return new Request(SITE + '/api/event', { method: 'POST', headers: headers, body: JSON.stringify({ type: type }) });
}

test('открытие цитаты, адвоката и отправка карточки растят счётчики дня', async () => {
    const h = makeHarness();
    for (const t of ['analysis', 'quote_open', 'advocate_open', 'card_share', 'quote_open']) {
        const res = await h.app.event(ev(t));
        assert.equal(res.status, 204);
    }
    const c = h.stores.counters.dump();
    assert.equal(c['events:2026-09-25:quote_open'], 2);
    assert.equal(c['events:2026-09-25:advocate_open'], 1);
    assert.equal(c['events:2026-09-25:card_share'], 1);
    assert.equal(c['events:2026-09-25:analysis'], 1);
});

test('незнакомое событие: 400, чужой Origin: 403, GET: 405', async () => {
    const h = makeHarness();
    assert.equal((await h.app.event(ev('whoami'))).status, 400);
    assert.equal((await h.app.event(ev('quote_open', { origin: 'https://evil.example' }))).status, 403);
    assert.equal((await h.app.event(new Request(SITE + '/api/event', { method: 'GET' }))).status, 405);
});

test('121-е событие за час с одного адреса: 429', async () => {
    const h = makeHarness();
    for (let i = 0; i < 120; i++) assert.equal((await h.app.event(ev('quote_open', { ip: '203.0.113.5' }))).status, 204);
    assert.equal((await h.app.event(ev('quote_open', { ip: '203.0.113.5' }))).status, 429);
});

test('без IP_SALT событие не считается: 500, счётчики пустые', async () => {
    const h = makeHarness({ env: { IP_SALT: '' } });
    const res = await h.app.event(ev('quote_open'));
    assert.equal(res.status, 500);
    assert.deepEqual(h.stores.counters.dump(), {});
    assert.deepEqual(h.stores.ratelimit.dump(), {});
});
