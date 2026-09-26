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

// Пустой баланс не должен выглядеть как занятая модель: иначе по
// странице и логу не понять, что дело в деньгах.
for (const c of [
    { name: '402 billing_error', status: 402, error: { type: 'billing_error', message: 'Billing issue' } },
    { name: '400 про низкий баланс', status: 400, error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
]) {
    test('ошибка оплаты (' + c.name + '): без повтора, 503 своей фразой, в логе error=billing', async () => {
        const h = makeHarness({ model: function () { return { status: c.status, body: { type: 'error', error: c.error } }; } });
        const started = await h.app.analyze(analyzeRequest(body3()));
        const { job } = await started.json();
        const res = await h.app.status(statusRequest(job));

        assert.equal(res.status, 503);
        const body = await res.json();
        assert.match(body.message, /баланс/);
        assert.doesNotMatch(body.message, /Модель занята|Перерыв на кофе/);
        assert.equal(h.modelCalls.length, 1, 'оплату повтором не починить');
        assert.ok(h.logs.some(function (l) { return /background .*error=billing/.test(l); }), h.logs.join('\n'));
    });
}

test('неверный ключ API: 500 «сломалось у нас», в логе error=auth, без повтора', async () => {
    const h = makeHarness({ model: function () { return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }; } });
    const started = await h.app.analyze(analyzeRequest(body3()));
    const { job } = await started.json();
    const res = await h.app.status(statusRequest(job));
    assert.equal(res.status, 500);
    assert.equal(h.modelCalls.length, 1);
    assert.ok(h.logs.some(function (l) { return /background .*error=auth/.test(l); }));
});

// ── Вопросы до оплаты ──────────────────────────────────────────────

test('результат содержит семь ответов, вопросы продавцу и «в пользу»; ссылки ведут на findings', async () => {
    const h = makeHarness();
    const res = await runAnalysis(h, Object.assign(body3(), { questions: ['q_cost', 'q_now'] }));
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.answers.length, 7);
    assert.ok(r.seller_questions.length >= 3 && r.seller_questions.length <= 5);
    assert.ok(Array.isArray(r.in_favor));
    for (const a of r.answers) {
        for (const id of a.evidence) assert.ok(r.findings[Number(id.slice(1))], a.id + ' ' + id);
    }
    // Модель по умолчанию в стенде метит всё дедлайном: давление есть.
    const now = r.answers.find(function (a) { return a.id === 'q_now'; });
    assert.equal(now.count, 3);
});

test('выбор вопросов не входит в ключ кэша: другой выбор пересчитывается без модели', async () => {
    const h = makeHarness();
    const a = await (await runAnalysis(h, Object.assign(body3(), { questions: ['q_now'] }))).json();
    const res = await h.app.analyze(analyzeRequest(Object.assign(body3(), { questions: ['q_fail', 'q_now'] })));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cache'), 'HIT');
    const b = await res.json();
    assert.equal(h.modelCalls.length, 1);
    assert.deepEqual(a.answers, b.answers, 'ответы от выбора не зависят');
});

test('незнакомый, повторный или пустой выбор вопросов: 400 до частоты и модели', async () => {
    for (const q of [['q_zzz'], ['q_now', 'q_now'], [], 'q_now']) {
        const h = makeHarness();
        const res = await h.app.analyze(analyzeRequest(Object.assign(body3(), { questions: q })));
        assert.equal(res.status, 400, JSON.stringify(q));
        assert.equal(h.modelCalls.length, 0);
        assert.deepEqual(h.stores.ratelimit.dump(), {});
    }
});

test('без поля questions: вопросы по умолчанию, ответ как раньше плюс новые поля', async () => {
    const h = makeHarness();
    const r = await (await runAnalysis(h, body3())).json();
    assert.equal(r.answers.length, 7);
    assert.ok(r.type && r.axes && r.findings, 'старые поля на месте');
});
