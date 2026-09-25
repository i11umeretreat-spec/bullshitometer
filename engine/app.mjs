// Обработчики. Порядок проверок в запуске разбора и есть защита денег:
// лимиты до вызова, кэш раньше бюджета, бюджет раньше модели.
//
//   POST /api/analyze          метод → Origin → тело → форма → частота →
//                              кэш (HIT: 200) → бюджет → задание (202)
//   GET  /api/analyze?job=…    опрос задания: 202 пока идёт, потом 200
//   POST фоновая функция        разметка, проверка цитат, запись в кэш
//   POST /api/event            счётчики метрики
//
// Разметка идёт в фоновой функции, а страница опрашивает задание раз
// в две секунды. Синхронная функция Netlify живёт около 10 секунд, а
// модели с размышлением на разметку даже трёх текстов нужно больше.

import { loadRubric, loadPrompt } from './assets.mjs';
import { bump } from './store.mjs';
import { score } from './score.mjs';
import { verifyFindings, buildTextsMeta, splitBatches } from './verify.mjs';
import { MODEL, buildSystem, buildRequest, callModel, effortFrom } from './model.mjs';
import {
    LIMITS, validateAnalyzeBody, originAllowed, clientIp, dayKey, hourKey,
    ipHash, sha256, signJob, tokenMatches, httpError,
} from './limits.mjs';

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
// Фоновая функция Netlify живёт до 15 минут. Задание старше — мёртвое.
const JOB_STALE_MS = 15 * 60 * 1000;
const BATCH_CHARS = 12000;
const POLLS_PER_HOUR = 900;
const EVENTS_PER_HOUR = 120;
const EVENT_TYPES = ['analysis', 'quote_open', 'advocate_open', 'card_share'];

function numberEnv(env, key, fallback) {
    const n = parseInt(env[key], 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function messageFor(status, env, reason) {
    if (status === 413) return 'Это уже не посты, а собрание сочинений. Сократи до 40 000 знаков';
    if (status === 429) {
        const n = numberEnv(env, 'HOURLY_PER_IP', 10);
        return (n === 10 ? 'Десять' : String(n)) + ' разборов за час. Выйди на орбиту, подыши';
    }
    if (status === 503 && reason === 'billing') return 'Разборы на паузе: у сервиса кончился баланс. Загляни позже';
    if (status === 503) return 'Перерыв на кофе: лимит разборов на сегодня кончился. Завтра продолжим';
    if (status === 502) return 'Модель занята, попробуй через минуту';
    if (status === 400) return 'Что-то не так с запросом: ' + (reason || 'проверь тексты');
    if (status === 403) return 'Запрос пришёл не со страницы Булшитометра';
    if (status === 405) return 'Этот адрес принимает только отправку текстов';
    if (status === 404) return 'Такого разбора нет или он уже забыт';
    return 'Что-то сломалось на нашей стороне';
}

export function createApp(deps) {
    const rubric = loadRubric();
    const prompt = loadPrompt();
    const system = buildSystem(rubric, prompt.template);
    const env = deps.env;
    const stores = deps.stores;

    // Ключ API не должен попасть ни в ответ, ни в лог, даже внутри
    // текста ошибки, которую вернул чужой сервис.
    function scrub(s) {
        const key = env.ANTHROPIC_API_KEY;
        let out = String(s);
        if (key) out = out.split(key).join('[ключ скрыт]');
        return out;
    }

    function log(parts) {
        deps.log(scrub(new Date(deps.now()).toISOString() + ' ' + parts.join(' ')));
    }

    function json(status, payload, extra) {
        const headers = Object.assign({
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        }, extra || {});
        return new Response(scrub(JSON.stringify(payload)), { status: status, headers: headers });
    }

    function fail(status, reason) {
        return json(status, { error: status, message: messageFor(status, env, reason), reason: reason || undefined });
    }

    const versions = { rubric: rubric.version, prompt: prompt.version, model: MODEL };

    // Без ключа разбор невозможен, а без соли хуже: String(undefined)
    // дал бы всем известную соль для хеша IP и подписи заданий.
    function configured() {
        return Boolean(env.ANTHROPIC_API_KEY) && Boolean(env.IP_SALT);
    }

    // Ключ кэша: версия промпта, модель и пары «жанр, текст» в порядке
    // ввода. Сценарий в ключ не входит: он влияет только на подсчёт,
    // и смена сценария не должна стоить нового вызова модели.
    function cacheKey(texts) {
        return sha256(JSON.stringify([prompt.version, MODEL, texts.map(function (t) { return [t.genre, t.text]; })]));
    }

    // Разметка в кэше хранит тексты по порядковому номеру, а не по id:
    // одни и те же тексты с другими id должны попадать в тот же кэш.
    function scoreExtraction(ex, ids, scenario) {
        const findings = ex.findings.map(function (f) { return Object.assign({}, f, { text_id: ids[f.i] }); });
        const meta = ex.texts_meta.map(function (t) { return { id: ids[t.i], genre: t.genre, words: t.words, cluster: t.cluster }; });
        const result = score({
            findings: findings,
            texts_meta: meta,
            scenario: scenario,
            rubric: rubric,
            dropped_quotes: ex.dropped_quotes,
            raw_findings: ex.raw_findings,
        });
        return Object.assign({ versions: versions }, result);
    }

    async function rateOk(prefix, ip, limit) {
        const key = prefix + ':' + ipHash(ip, env.IP_SALT, deps.now()) + ':' + hourKey(deps.now());
        const n = await bump(stores.ratelimit, key);
        return n <= limit;
    }

    // ── POST /api/analyze ───────────────────────────────────────────
    async function analyze(req, context) {
        const t0 = deps.now();
        let texts = 0;
        let chars = 0;
        let cache = '-';
        const done = function (res) {
            log(['analyze', cache, 'texts=' + texts, 'chars=' + chars, 'ms=' + (deps.now() - t0), 'status=' + res.status]);
            return res;
        };

        if (req.method !== 'POST') return done(fail(405));
        if (!configured()) { cache = 'misconfigured'; return done(fail(500)); }
        if (!originAllowed(req, env)) return done(fail(403));

        const raw = await req.text();
        if (Buffer.byteLength(raw, 'utf8') > LIMITS.MAX_BODY_BYTES) return done(fail(413, 'тело запроса слишком большое'));

        let body;
        try { body = JSON.parse(raw); } catch (e) { return done(fail(400, 'тело запроса не JSON')); }

        const checked = validateAnalyzeBody(body, rubric);
        if (!checked.ok) return done(fail(checked.status, checked.reason));
        const input = checked.input;
        texts = input.texts.length;
        chars = checked.chars;

        const ip = clientIp(req, context);
        if (!(await rateOk('an', ip, numberEnv(env, 'HOURLY_PER_IP', 10)))) return done(fail(429));

        const key = cacheKey(input.texts);
        const ids = input.texts.map(function (t) { return t.id; });

        const ex = await stores.extractions.getJSON(key);
        if (ex && deps.now() - ex.created < CACHE_TTL_MS) {
            cache = 'HIT';
            return done(json(200, scoreExtraction(ex, ids, input.scenario), { 'x-cache': 'HIT' }));
        }

        cache = 'MISS';
        const calls = (await stores.counters.getJSON('calls:' + dayKey(deps.now()))) || 0;
        if (calls >= numberEnv(env, 'DAILY_CAP', 500)) return done(fail(503));

        // Те же тексты уже размечаются: отдаём то же задание, второй
        // вызов модели не нужен.
        const inflight = await stores.jobs.getJSON('inflight:' + key);
        if (inflight && deps.now() - inflight.created < JOB_STALE_MS) {
            const rec = await stores.jobs.getJSON('job:' + inflight.job);
            if (rec && (rec.status === 'pending' || rec.status === 'running')) {
                return done(json(202, { job: inflight.job, poll_ms: 2000 }));
            }
        }

        const job = deps.uuid();
        await stores.jobs.setJSON('job:' + job, { key: key, ids: ids, scenario: input.scenario, status: 'pending', created: deps.now() });
        await stores.jobs.setJSON('inflight:' + key, { job: job, created: deps.now() });

        // Не дозвонились до фоновой функции: задание сразу помечается
        // ошибкой, иначе страница ждала бы его пятнадцать минут.
        try {
            await deps.invokeBackground({ job: job, texts: input.texts }, signJob(env.IP_SALT, job), new URL(req.url).origin);
        } catch (e) {
            await stores.jobs.setJSON('job:' + job, Object.assign({}, await stores.jobs.getJSON('job:' + job), { status: 'error', code: 502 }));
            await stores.jobs.delete('inflight:' + key);
            return done(fail(502));
        }

        return done(json(202, { job: job, poll_ms: 2000 }));
    }

    // ── GET /api/analyze?job=… ──────────────────────────────────────
    async function status(req, context) {
        const t0 = deps.now();
        const done = function (res, cache) {
            log(['status', cache || '-', 'ms=' + (deps.now() - t0), 'status=' + res.status]);
            return res;
        };

        if (req.method !== 'GET') return done(fail(405));
        if (!configured()) return done(fail(500), 'misconfigured');
        const ip = clientIp(req, context);
        if (!(await rateOk('poll', ip, POLLS_PER_HOUR))) return done(fail(429));

        const job = new URL(req.url).searchParams.get('job') || '';
        if (!/^[A-Za-z0-9-]{1,64}$/.test(job)) return done(fail(404));
        const rec = await stores.jobs.getJSON('job:' + job);
        if (!rec) return done(fail(404));

        if (rec.status === 'pending' || rec.status === 'running') {
            if (deps.now() - rec.created > JOB_STALE_MS) return done(fail(502));
            return done(json(202, { status: rec.status, poll_ms: 2000 }));
        }

        if (rec.status === 'error') return done(fail(rec.code || 502, rec.reason));

        const ex = await stores.extractions.getJSON(rec.key);
        if (!ex) return done(fail(404));
        return done(json(200, scoreExtraction(ex, rec.ids, rec.scenario), { 'x-cache': 'MISS' }), 'MISS');
    }

    // ── Фоновая разметка ────────────────────────────────────────────
    async function background(req) {
        const t0 = deps.now();
        const done = function (res, extra) {
            log(['background'].concat(extra || []).concat(['ms=' + (deps.now() - t0), 'status=' + res.status]));
            return res;
        };

        if (req.method !== 'POST') return done(fail(405));
        if (!configured()) return done(fail(500), ['misconfigured']);

        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { return done(fail(400)); }
        const job = body && typeof body.job === 'string' ? body.job : '';

        if (!job || !tokenMatches(signJob(env.IP_SALT, job), req.headers.get('x-bg-token'))) return done(fail(403));

        const rec = await stores.jobs.getJSON('job:' + job);
        if (!rec) return done(fail(404));
        if (rec.status !== 'pending') return done(json(409, { error: 409 }));

        // Тексты приходят в теле вызова и никуда не пишутся. Их хеш обязан
        // совпасть с заданием: подменить тексты по чужому номеру нельзя.
        const texts = Array.isArray(body.texts) ? body.texts : [];
        if (cacheKey(texts) !== rec.key) return done(fail(403));

        rec.status = 'running';
        await stores.jobs.setJSON('job:' + job, rec);

        async function finishWithError(code, why, reason) {
            rec.status = 'error';
            rec.code = code;
            if (reason) rec.reason = reason;
            await stores.jobs.setJSON('job:' + job, rec);
            await stores.jobs.delete('inflight:' + rec.key);
            return done(json(200, { ok: false }), ['error=' + why, 'texts=' + texts.length]);
        }

        const cap = numberEnv(env, 'DAILY_CAP', 500);
        const callsKey = 'calls:' + dayKey(deps.now());
        if (((await stores.counters.getJSON(callsKey)) || 0) >= cap) return finishWithError(503, 'budget');

        const effort = effortFrom(env);
        const batches = splitBatches(texts, BATCH_CHARS);
        const results = await Promise.all(batches.map(function (batch) {
            return callModel({
                fetch: deps.fetch,
                sleep: deps.sleep,
                apiKey: env.ANTHROPIC_API_KEY,
                body: buildRequest(batch, rubric, system, effort),
                onAttempt: function () { return bump(stores.counters, callsKey); },
            });
        }));

        const bad = results.find(function (r) { return !r.ok; });
        if (bad) {
            // Баланс и ключ не чинятся ожиданием: у них свой код и своя
            // фраза, чтобы «модель занята» не прятало проблему с деньгами.
            if (bad.kind === 'billing') return finishWithError(503, 'billing:' + bad.status, 'billing');
            if (bad.kind === 'auth') return finishWithError(500, 'auth:' + bad.status);
            return finishWithError(502, bad.kind + ':' + bad.status);
        }

        let allFindings = [];
        const templateLike = [];
        for (const r of results) {
            allFindings = allFindings.concat(Array.isArray(r.input.findings) ? r.input.findings : []);
            for (const m of Array.isArray(r.input.texts_meta) ? r.input.texts_meta : []) {
                if (m && m.template_like === true) templateLike.push(m.text_id);
            }
        }

        const checked = verifyFindings(allFindings, texts, rubric);
        const meta = buildTextsMeta(texts, templateLike, rubric);
        const index = new Map(texts.map(function (t, i) { return [t.id, i]; }));

        // В кэш идёт разметка: короткие цитаты, сигналы, объяснения и
        // обезличенные метаданные текстов. Самих текстов тут нет.
        await stores.extractions.setJSON(rec.key, {
            created: deps.now(),
            versions: { prompt: prompt.version, model: MODEL },
            findings: checked.kept.map(function (f) {
                const out = Object.assign({ i: index.get(f.text_id) }, f);
                delete out.text_id;
                return out;
            }),
            texts_meta: meta.map(function (t) { return { i: index.get(t.id), genre: t.genre, words: t.words, cluster: t.cluster }; }),
            raw_findings: checked.raw,
            dropped_quotes: checked.dropped,
        });

        rec.status = 'done';
        await stores.jobs.setJSON('job:' + job, rec);
        await stores.jobs.delete('inflight:' + rec.key);

        return done(json(200, { ok: true }), ['texts=' + texts.length, 'calls=' + batches.length, 'dropped=' + checked.dropped]);
    }

    // ── POST /api/event ─────────────────────────────────────────────
    async function event(req, context) {
        if (req.method !== 'POST') return fail(405);
        if (!env.IP_SALT) { log(['event', 'misconfigured']); return fail(500); }
        if (!originAllowed(req, env)) return fail(403);

        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { return fail(400); }
        if (!body || EVENT_TYPES.indexOf(body.type) === -1) return fail(400, 'неизвестное событие');

        const ip = clientIp(req, context);
        if (!(await rateOk('ev', ip, EVENTS_PER_HOUR))) return fail(429);

        await bump(stores.counters, 'events:' + dayKey(deps.now()) + ':' + body.type);
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }

    return { analyze: analyze, status: status, background: background, event: event, _httpError: httpError };
}
