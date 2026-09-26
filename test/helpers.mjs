// Общий стенд для тестов. Хранилища в памяти вместо Netlify Blobs,
// модель подменена функцией, часы и паузы управляются тестом.
// Ничего не ходит в сеть: если код полезет наружу мимо подмены,
// тест упадёт, а не повиснет.

import { createApp } from '../engine/app.mjs';
import { memoryStore } from '../engine/store.mjs';

export const SITE = 'https://bullshitometer.example';

// Достаёт тексты из запроса к модели: они приходят в тегах <text>.
export function textsFromModelRequest(body) {
    const content = body.messages[0].content;
    const out = [];
    const re = /<text id="([^"]+)" genre="([^"]+)">\n?([\s\S]*?)\n?<\/text>/g;
    let m;
    while ((m = re.exec(content)) !== null) out.push({ id: m[1], genre: m[2], text: m[3] });
    return out;
}

// Ответ модели в форме Messages API: один блок tool_use.
export function toolReply(input) {
    return {
        status: 200,
        body: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_findings', input: input }],
        },
    };
}

// Модель по умолчанию: в каждом тексте берёт первое предложение
// и честно помечает его как дедлайн. Цитата дословная.
export function defaultModel(body) {
    const texts = textsFromModelRequest(body);
    return toolReply({
        findings: texts.map(function (t) {
            const first = t.text.split(/(?<=[.!?])\s/)[0].slice(0, 180);
            return {
                text_id: t.id, quote: first, signal: 'urgency', strength: 2,
                modifiers: [], context_note: 'начало текста', alt_explanation: 'может быть реальным сроком',
            };
        }),
        texts_meta: texts.map(function (t) { return { text_id: t.id, template_like: false }; }),
    });
}

export function makeHarness(opts) {
    opts = opts || {};
    const stores = {
        extractions: memoryStore(),
        ratelimit: memoryStore(),
        counters: memoryStore(),
        jobs: memoryStore(),
    };
    const modelCalls = [];
    const logs = [];
    let clock = opts.now || Date.UTC(2026, 8, 25, 10, 0, 0);

    const env = Object.assign({
        URL: SITE,
        ANTHROPIC_API_KEY: 'sk-test-XYZ',
        IP_SALT: 'salt-for-tests',
        DAILY_CAP: '500',
        HOURLY_PER_IP: '10',
    }, opts.env || {});

    const model = opts.model || defaultModel;

    const fakeFetch = async function (url, init) {
        if (String(url).indexOf('api.anthropic.com') === -1) {
            throw new Error('тест пошёл в сеть мимо подмены: ' + url);
        }
        const body = JSON.parse(init.body);
        modelCalls.push({ url: String(url), headers: init.headers, body: body });
        const reply = model(body, modelCalls.length);
        if (reply instanceof Error) throw reply;
        return new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { 'content-type': 'application/json' },
        });
    };

    const app = createApp({
        stores: stores,
        fetch: fakeFetch,
        env: env,
        now: function () { return clock; },
        sleep: async function () {},
        log: function (line) { logs.push(line); },
        uuid: (function () { let n = 0; return function () { n += 1; return 'job-' + n; }; })(),
        // Фоновая функция в тестах выполняется сразу, в том же процессе:
        // так путь «запуск, разметка, опрос» проверяется целиком.
        invokeBackground: async function (payload, token) {
            const req = new Request(SITE + '/.netlify/functions/analyze-background', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-bg-token': token },
                body: JSON.stringify(payload),
            });
            const res = await app.background(req);
            if (res.status >= 400 && res.status !== 202) {
                // фоновая функция отвечает не человеку, её ответ никто не видит
            }
        },
    });

    return {
        app, stores, env, logs, modelCalls,
        tick: function (ms) { clock += ms; },
        setNow: function (ms) { clock = ms; },
    };
}

export function analyzeRequest(body, opts) {
    opts = opts || {};
    const headers = { 'content-type': 'application/json', origin: opts.origin || SITE };
    if (opts.ip) headers['x-nf-client-connection-ip'] = opts.ip;
    return new Request(SITE + '/api/analyze', {
        method: opts.method || 'POST',
        headers: headers,
        body: (opts.method && opts.method !== 'POST') ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
}

export function statusRequest(job, opts) {
    opts = opts || {};
    const headers = {};
    if (opts.ip) headers['x-nf-client-connection-ip'] = opts.ip;
    return new Request(SITE + '/api/analyze?job=' + encodeURIComponent(job), { method: 'GET', headers: headers });
}

// Полный путь одного разбора: запуск, фоновая разметка, опрос.
export async function runAnalysis(h, body, opts) {
    const first = await h.app.analyze(analyzeRequest(body, opts));
    if (first.status !== 202) return first;
    const started = await first.json();
    return h.app.status(statusRequest(started.job, opts));
}

// Тексты для тестов. Синтетические, никаких реальных авторов.
export const TEXT_SALE = 'Запись закрывается сегодня в полночь. Осталось всего три места в группе. ' +
    'Программа идёт шесть недель, занятия два раза в неделю по вечерам. ' +
    'Внутри разбор ваших случаев и домашние задания с обратной связью.';

export const TEXT_POST = 'Сегодня расскажу, как я разбираю сложные случаи на консультациях. ' +
    'Сначала выясняю, что человек уже пробовал и что из этого не сработало. ' +
    'Потом мы вместе ищем, где именно застревает изменение, и договариваемся о маленьком шаге.';

export const TEXT_LECTURE = 'В этой лекции разберём, почему привычки держатся так крепко. ' +
    'Мозг экономит силы и повторяет то, что уже однажды сработало. ' +
    'Поэтому менять привычку в лоб тяжело, а через окружение и подсказки проще.';

export function body3(scenario) {
    return {
        scenario: scenario || 'course',
        texts: [
            { id: 't1', genre: 'sale', text: TEXT_SALE },
            { id: 't2', genre: 'post', text: TEXT_POST },
            { id: 't3', genre: 'lecture', text: TEXT_LECTURE },
        ],
    };
}

// Модель по ключевым словам: детерминированная, но разнообразная.
// Нужна снимкам движка: у модели по умолчанию каждый текст даёт один
// дедлайн, и снимки 14 фикстур вышли бы почти одинаковыми. Здесь в
// каждом тексте ищется первая фраза с ключом сигнала, одна находка на
// сигнал. Таблица ключей — часть стенда: не менять, иначе снимки в
// test/golden придётся переписывать.
const KEYWORDS = [
    ['urgency', ['сегодня', 'до пятницы', 'закрывается', 'дедлайн']],
    ['scarcity', ['осталось', 'мест']],
    ['fear_loss', ['упустит', 'ещё год', 'мимо']],
    ['shame_doubt', ['сомнева', 'не готов']],
    ['outcome_promise', ['результат', 'доход', 'зарабатыва']],
    ['miracle_claim', ['навсегда', 'гарант', 'исцел']],
    ['only_me', ['только я', 'никто', 'единствен']],
    ['secret_knowledge', ['скрыва', 'тайн', 'посвящ']],
    ['forbid_others', ['не ходите', 'психолог']],
    ['enemy_frame', ['врачи', 'система', 'корпорац']],
    ['dependency', ['без меня не', 'сами не', 'проводник']],
    ['price_ladder', ['ступен', 'уровень', 'поток']],
    ['upsell', ['клуб', 'наставничеств', 'следующий курс']],
    ['hidden_terms', ['в личк', 'условия расскажу']],
    ['vague_social_proof', ['тысяч', 'сотни']],
    ['named_source', ['книга', 'руководств', 'опубликова']],
    ['checkable_claim', ['засеките', 'замерьте', 'проверьте']],
    ['vague_source', ['исследовани', 'учёные']],
    ['unfalsifiable', ['не сработало', 'не переписалась', 'значит, вы']],
    ['pseudo_science', ['частот', 'вибрац', 'квант']],
    ['limitation_stated', ['не подходит', 'противопоказ', 'сначала к врачу']],
    ['conditions_stated', ['если заниматься', 'при выполнении', 'раз в неделю']],
    ['self_correction', ['ошибал', 'свою ошибку']],
    ['negative_case', ['не помогла', 'прогресса почти не было', 'не сработал']],
    ['handles_objection', ['это дорого', 'зачем тогда платить']],
    ['referral', ['к врачу', 'коллегу', 'советую']],
    ['verification_invite', ['не верьте мне', 'посмотрите']],
    ['open_method', ['упражнение', 'бесплатный план', 'делайте']],
    ['exit_ok', ['без меня', 'заканчивается', 'сами']],
];

export function keywordModel(body) {
    const texts = textsFromModelRequest(body);
    const findings = [];
    for (const t of texts) {
        const sentences = t.text.split(/(?<=[.!?…])\s+/);
        for (const [signal, keys] of KEYWORDS) {
            const s = sentences.find(function (x) {
                const low = x.toLowerCase();
                return keys.some(function (k) { return low.indexOf(k) !== -1; });
            });
            if (!s) continue;
            findings.push({
                text_id: t.id, quote: s.slice(0, 200), signal: signal, strength: 2, modifiers: [],
                context_note: 'фраза ' + (sentences.indexOf(s) + 1), alt_explanation: 'может быть честным описанием',
            });
        }
    }
    return toolReply({
        findings: findings,
        texts_meta: texts.map(function (t) { return { text_id: t.id, template_like: false }; }),
    });
}
