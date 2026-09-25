// Путь одного разбора целиком: запуск, разметка, проверка цитат,
// кэш, опрос. Модель подменена.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    makeHarness, analyzeRequest, statusRequest, runAnalysis, body3,
    textsFromModelRequest, toolReply,
} from './helpers.mjs';

test('первый запуск: 202 и номер задания, опрос отдаёт результат', async () => {
    const h = makeHarness();
    const started = await h.app.analyze(analyzeRequest(body3()));
    assert.equal(started.status, 202);
    const { job } = await started.json();
    assert.ok(job);

    const res = await h.app.status(statusRequest(job));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'MISS');
    const result = await res.json();
    assert.ok(result.type && result.type.title);
    assert.equal(result.axes.length, 7);
});

test('тот же запрос дважды: ровно один вызов модели, второй ответ из кэша', async () => {
    const h = makeHarness();
    const first = await runAnalysis(h, body3());
    assert.equal(first.status, 200);

    const second = await h.app.analyze(analyzeRequest(body3()));
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal(h.modelCalls.length, 1);

    const a = await first.json();
    const b = await second.json();
    assert.deepEqual(a, b, 'тот же результат');
});

test('ключ кэша не зависит от сценария: другой сценарий пересчитывается без модели', async () => {
    const h = makeHarness();
    await runAnalysis(h, body3('course'));
    const res = await h.app.analyze(analyzeRequest(body3('ad')));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'HIT');
    assert.equal(h.modelCalls.length, 1);
});

test('в кэше нет текстов целиком', async () => {
    const h = makeHarness();
    await runAnalysis(h, body3());
    const dump = JSON.stringify(h.stores.extractions.dump());
    // Второе предложение текста в находки не попало, значит и в кэше его нет.
    assert.ok(dump.indexOf('Программа идёт шесть недель') === -1, 'полного текста в кэше нет');
});

test('ключ sk-test-XYZ не встречается в ответах и логах, в том числе при ошибке', async () => {
    const h = makeHarness({
        model: function () {
            return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-test-XYZ' } } };
        },
    });
    const started = await h.app.analyze(analyzeRequest(body3()));
    const startedText = await started.text();
    const { job } = JSON.parse(startedText);
    const res = await h.app.status(statusRequest(job));
    const text = await res.text();

    assert.ok(startedText.indexOf('sk-test-XYZ') === -1);
    assert.ok(text.indexOf('sk-test-XYZ') === -1, text);
    assert.ok(h.logs.join('\n').indexOf('sk-test-XYZ') === -1, h.logs.join('\n'));
    assert.ok(JSON.stringify(h.stores.jobs.dump()).indexOf('sk-test-XYZ') === -1);

    // ключ ушёл в модель заголовком, и только туда
    assert.equal(h.modelCalls[0].headers['x-api-key'], 'sk-test-XYZ');
});

test('модель дважды падает: один повтор, потом 502, бюджет вырос на 2', async () => {
    const h = makeHarness({
        model: function () { return { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }; },
    });
    const started = await h.app.analyze(analyzeRequest(body3()));
    const { job } = await started.json();
    const res = await h.app.status(statusRequest(job));

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.message, /Модель занята/);
    assert.equal(h.modelCalls.length, 2, 'ровно один повтор');

    const counters = h.stores.counters.dump();
    const calls = Object.keys(counters).filter(function (k) { return k.indexOf('calls:') === 0; });
    assert.equal(counters[calls[0]], 2, 'оба вызова оплачены и посчитаны');
});

test('400 от модели не повторяется', async () => {
    const h = makeHarness({
        model: function () { return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }; },
    });
    const started = await h.app.analyze(analyzeRequest(body3()));
    const { job } = await started.json();
    const res = await h.app.status(statusRequest(job));
    assert.equal(res.status, 502);
    assert.equal(h.modelCalls.length, 1);
});

test('модель вернула выдуманную цитату: находка отброшена, dropped_quotes = 1', async () => {
    const h = makeHarness({
        model: function (body) {
            const texts = textsFromModelRequest(body);
            return toolReply({
                findings: [
                    { text_id: texts[0].id, quote: 'Осталось всего три места в группе.', signal: 'scarcity', strength: 2, modifiers: [], context_note: '', alt_explanation: 'реальный размер группы' },
                    { text_id: texts[0].id, quote: 'Гарантирую результат навсегда.', signal: 'miracle_claim', strength: 3, modifiers: [], context_note: '', alt_explanation: '' },
                ],
                texts_meta: texts.map(function (t) { return { text_id: t.id, template_like: false }; }),
            });
        },
    });
    const res = await runAnalysis(h, body3());
    const result = await res.json();
    assert.equal(result.stats.dropped_quotes, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].signal, 'scarcity');
});

test('цитата с другими кавычками, ё и лишними пробелами находится', async () => {
    const h = makeHarness({
        model: function (body) {
            const texts = textsFromModelRequest(body);
            return toolReply({
                findings: [{ text_id: 't1', quote: '  осталось   всего три места  ', signal: 'scarcity', strength: 2, modifiers: [], context_note: '', alt_explanation: 'x' }],
                texts_meta: texts.map(function (t) { return { text_id: t.id, template_like: false }; }),
            });
        },
    });
    const res = await runAnalysis(h, body3());
    const result = await res.json();
    assert.equal(result.stats.dropped_quotes, 0);
});

test('находки с чужим text_id, неизвестным сигналом и силой вне 1-3 отбрасываются', async () => {
    const h = makeHarness({
        model: function (body) {
            const texts = textsFromModelRequest(body);
            const q = 'Осталось всего три места в группе.';
            return toolReply({
                findings: [
                    { text_id: 't9', quote: q, signal: 'scarcity', strength: 2, modifiers: [], context_note: '', alt_explanation: 'x' },
                    { text_id: 't1', quote: q, signal: 'mind_control', strength: 2, modifiers: [], context_note: '', alt_explanation: 'x' },
                    { text_id: 't1', quote: q, signal: 'scarcity', strength: 7, modifiers: [], context_note: '', alt_explanation: 'x' },
                ],
                texts_meta: texts.map(function (t) { return { text_id: t.id, template_like: false }; }),
            });
        },
    });
    const res = await runAnalysis(h, body3());
    const result = await res.json();
    assert.equal(result.stats.dropped_quotes, 3);
    assert.equal(result.findings.length, 0);
});

test('запрос к модели: инструмент принудительный, строгая схема, тексты в тегах, без temperature', async () => {
    const h = makeHarness();
    await runAnalysis(h, body3());
    const req = h.modelCalls[0].body;

    assert.equal(req.model, 'claude-sonnet-5');
    assert.deepEqual(req.tool_choice, { type: 'tool', name: 'report_findings' });
    assert.equal(req.tools[0].strict, true);
    assert.equal(req.tools[0].input_schema.additionalProperties, false);
    // На claude-sonnet-5 параметры сэмплинга убраны: любой temperature
    // даёт 400. Воспроизводимость держат кэш и подсчёт в коде.
    assert.ok(!('temperature' in req), 'temperature не отправляется');
    assert.match(req.messages[0].content, /<text id="t1" genre="sale">/);
    // Сигналы в промпт приходят из рубрики, а не записаны в нём руками.
    const systemText = req.system.map(function (b) { return b.text; }).join('\n');
    assert.ok(systemText.indexOf('shame_doubt') > -1);
    assert.ok(systemText.indexOf('{{SIGNALS}}') === -1);
    const signalEnum = req.tools[0].input_schema.properties.findings.items.properties.signal.enum;
    assert.equal(signalEnum.length, 29);
});

test('длинный набор делится на пачки по целым текстам, находки склеиваются', async () => {
    const h = makeHarness();
    const long = 'Запись закрывается сегодня. ' + 'Очень длинный рассказ про метод. '.repeat(280);
    const body = { scenario: 'course', texts: [
        { id: 't1', genre: 'post', text: long },
        { id: 't2', genre: 'post', text: long.replace('Запись', 'Регистрация') },
        { id: 't3', genre: 'post', text: 'Запись закрывается завтра. ' + 'Другой рассказ целиком. '.repeat(300) },
    ] };
    const res = await runAnalysis(h, body);
    assert.equal(res.status, 200);
    assert.ok(h.modelCalls.length >= 2, 'больше одного вызова: ' + h.modelCalls.length);
    for (const call of h.modelCalls) {
        assert.ok(call.body.messages[0].content.length < 14000, 'пачка не больше 12 000 знаков текста');
    }
    const result = await res.json();
    const ids = new Set(result.findings.map(function (f) { return f.text_id; }));
    assert.equal(ids.size, 3, 'находки из всех пачек на месте');
});

test('ответ без tool_use: ошибка, а не пустой разбор', async () => {
    const h = makeHarness({
        model: function () { return { status: 200, body: { content: [{ type: 'text', text: 'не буду' }], stop_reason: 'end_turn' } }; },
    });
    const started = await h.app.analyze(analyzeRequest(body3()));
    const { job } = await started.json();
    const res = await h.app.status(statusRequest(job));
    assert.equal(res.status, 502);
});

test('лог: одна строка на запрос, без текстов, IP и ответов модели', async () => {
    const h = makeHarness();
    await runAnalysis(h, body3(), { ip: '203.0.113.7' });
    await h.app.analyze(analyzeRequest(body3(), { ip: '203.0.113.7' }));
    const all = h.logs.join('\n');
    assert.ok(all.indexOf('203.0.113.7') === -1);
    assert.ok(all.indexOf('Запись закрывается') === -1);
    assert.ok(/HIT/.test(all) && /MISS/.test(all));
});

test('опрос чужого или несуществующего задания: 404', async () => {
    const h = makeHarness();
    const res = await h.app.status(statusRequest('nope'));
    assert.equal(res.status, 404);
});

test('нет ANTHROPIC_API_KEY или IP_SALT: 500 до модели, без соли «undefined»', async () => {
    for (const missing of ['ANTHROPIC_API_KEY', 'IP_SALT']) {
        const env = {};
        env[missing] = '';
        const h = makeHarness({ env: env });
        const res = await h.app.analyze(analyzeRequest(body3()));
        assert.equal(res.status, 500, missing);
        assert.equal(h.modelCalls.length, 0, missing);
        assert.deepEqual(h.stores.ratelimit.dump(), {}, missing);
        assert.ok(h.logs.some(function (l) { return l.indexOf('misconfigured') !== -1; }), missing);
    }
});

test('фоновая функция без IP_SALT не принимает подпись от соли «undefined»', async () => {
    const { signJob } = await import('../engine/limits.mjs');
    const h = makeHarness({ env: { IP_SALT: '' } });
    const res = await h.app.background(new Request('https://x/.netlify/functions/analyze-background', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bg-token': signJob(undefined, 'job-1') },
        body: JSON.stringify({ job: 'job-1', texts: [] }),
    }));
    assert.equal(res.status, 500);
});

test('опрос без IP_SALT: 500, частота не считается', async () => {
    const h = makeHarness({ env: { IP_SALT: '' } });
    const res = await h.app.status(statusRequest('job-1'));
    assert.equal(res.status, 500);
    assert.deepEqual(h.stores.ratelimit.dump(), {});
});
