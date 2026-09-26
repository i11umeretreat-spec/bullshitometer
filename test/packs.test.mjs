// Доменные пакеты: загрузка, проверка перекрёстных ссылок, публичная
// часть, выбор пакета в API. Игрушечный пакет demo ничего не знает
// про курсы: если весь путь проходит на нём, знание про курсы из
// движка действительно ушло.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack, publicPack, REQUIRED_COPY } from '../engine/packs.mjs';
import { makeHarness, analyzeRequest, runAnalysis, textsFromModelRequest, toolReply, body3, SITE } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PACKS = path.join(ROOT, 'test', 'fixtures', 'packs');

function get(obj, dotted) {
    return dotted.split('.').reduce(function (o, k) { return o === undefined || o === null ? undefined : o[k]; }, obj);
}

// ── Загрузка ─────────────────────────────────────────────────────────

test('courses: паспорт, подкрепление цитатами, сценарии совпадают с рубрикой', () => {
    const p = loadPack('courses');
    assert.equal(p.id, 'courses');
    assert.equal(p.version, '1');
    assert.equal(p.evidence.kind, 'quote');
    assert.deepEqual(p.scenarios.map(function (s) { return s.id; }).sort(), Object.keys(p.rubric.scenario).sort());
    assert.equal(p.scenarios.filter(function (s) { return s.default; }).length, 1);
    assert.match(p.prompt.template, /\{\{SIGNALS\}\}/);
});

test('у courses и demo есть все обязательные ключи copy.json', () => {
    for (const p of [loadPack('courses'), loadPack('demo', { roots: [TEST_PACKS] })]) {
        for (const key of REQUIRED_COPY) assert.ok(get(p.copy, key) !== undefined, p.id + ': ' + key);
    }
});

test('публичная часть: тексты, сценарии, жанры и вопросы, без весов, правил и промпта', () => {
    const p = loadPack('courses');
    const pub = publicPack(p);
    assert.equal(pub.id, 'courses');
    assert.equal(pub.version, '1');
    assert.deepEqual(pub.copy, p.copy);
    assert.deepEqual(pub.scenarios, p.scenarios);
    assert.deepEqual(pub.questions, p.rubric.questions.map(function (q) { return { id: q.id, text: q.text, default: q.default }; }));
    assert.deepEqual(pub.genres.map(function (g) { return g.id; }), Object.keys(p.rubric.genres));
    const raw = JSON.stringify(pub);
    for (const secret of ['"weight"', '"definition"', '"when"', '"source"', '"ask_seller"', '"override"', '"levels"', 'prompt-version', '{{SIGNALS}}']) {
        assert.equal(raw.indexOf(secret), -1, secret);
    }
    assert.equal(raw.indexOf(p.prompt.template.slice(0, 60)), -1, 'текст промпта');
});

// ── Сломанные пакеты ────────────────────────────────────────────────

// Копия demo под новым именем с одной порчей. Имя папки и id совпадают,
// иначе загрузка падала бы по другой причине.
function broken(name, mutate) {
    const root = mkdtempSync(path.join(tmpdir(), 'packs-'));
    const dir = path.join(root, name);
    cpSync(path.join(TEST_PACKS, 'demo'), dir, { recursive: true });
    const files = {};
    for (const f of ['pack.json', 'rubric.json', 'copy.json']) files[f] = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    files['pack.json'].id = name;
    mutate(files);
    for (const f of Object.keys(files)) writeFileSync(path.join(dir, f), JSON.stringify(files[f]));
    return root;
}

function loadError(root, name) {
    try { loadPack(name, { roots: [root] }); } catch (e) { return e.message; }
    return null;
}

const CASES = [
    ['b-axis', 'rubric.json', 'questions[0].source.axis', function (f) { f['rubric.json'].questions[0].source.axis = 'nope'; }],
    ['b-signal', 'rubric.json', 'ghost', function (f) {
        f['rubric.json'].questions[0].source = { rules: [{ signals: ['ghost'], use: '0' }] };
    }],
    ['b-signal-axis', 'rubric.json', 'signals.boast.axis', function (f) { f['rubric.json'].signals.boast.axis = 'nope'; }],
    ['b-type-axis', 'rubric.json', 'types[0]', function (f) { f['rubric.json'].types[0].when.all[0].axis = 'nope'; }],
    ['b-copy', 'copy.json', 'result.seller_intro', function (f) { delete f['copy.json'].result.seller_intro; }],
    ['b-copy-type', 'copy.json', 'types.loud', function (f) { delete f['copy.json'].types.loud; }],
    ['b-evidence', 'pack.json', 'evidence.kind', function (f) { f['pack.json'].evidence.kind = 'measure'; }],
    ['b-scenario', 'pack.json', 'scenarios', function (f) { f['pack.json'].scenarios[0].id = 'other'; }],
    ['b-counter', 'copy.json', 'card.counters', function (f) { f['copy.json'].card.counters[0].key = 'nope'; }],
];

for (const [name, file, key, mutate] of CASES) {
    test('сломанный пакет не загружается, в ошибке пакет, файл и ключ: ' + key, () => {
        const msg = loadError(broken(name, mutate), name);
        assert.ok(msg, 'пакет загрузился');
        assert.ok(msg.indexOf(name) !== -1, 'нет имени пакета: ' + msg);
        assert.ok(msg.indexOf(file) !== -1, 'нет файла: ' + msg);
        assert.ok(msg.indexOf(key) !== -1, 'нет ключа: ' + msg);
    });
}

test('id в паспорте должен совпадать с папкой', () => {
    const root = broken('b-id', function (f) { f['pack.json'].id = 'other'; });
    assert.match(loadError(root, 'b-id'), /pack\.json.*id/);
});

test('неизвестный или кривой id пакета: ошибка с кодом PACK_NOT_FOUND, путь из id не собирается', () => {
    for (const id of ['nope', '../courses', 'Courses', '']) {
        try { loadPack(id); assert.fail('загрузился ' + id); } catch (e) { assert.equal(e.code, 'PACK_NOT_FOUND', id); }
    }
});

// ── Весь путь на игрушечном пакете ──────────────────────────────────

// Модель для demo: «лучший» — хвастовство, «!» — шум, «ссылка» — опора.
function demoModel(body) {
    const findings = [];
    for (const t of textsFromModelRequest(body)) {
        for (const s of t.text.split(/(?<=[.!?])\s+/)) {
            let signal = null;
            if (/лучш/i.test(s)) signal = 'boast';
            else if (/!/.test(s)) signal = 'hype';
            else if (/ссылк/i.test(s)) signal = 'cite';
            if (signal) findings.push({ text_id: t.id, quote: s, signal: signal, strength: 2, modifiers: [], context_note: '', alt_explanation: 'может быть правдой' });
        }
    }
    return toolReply({ findings: findings, texts_meta: [] });
}

const DEMO_BODY = {
    domain: 'demo',
    scenario: 'look',
    texts: [
        { id: 'n1', genre: 'note', text: 'Я лучший мастер в городе. Приходите скорее! Это лучший выбор, без вариантов. Просто поверьте на слово и приходите. Всё будет хорошо, обещаю каждому.' },
        { id: 'n2', genre: 'note', text: 'Мы лучшие на рынке. Звоните сейчас! Отзывы у нас только хорошие, так что сомнений быть не может. Работаем каждый день без выходных.' },
        { id: 'n3', genre: 'note', text: 'Цены лучшие в округе. Ссылка на прайс есть в профиле. Скидки бывают, но редко, так что лучше не ждать. Приходите, будем рады вам всем!' },
    ],
};

test('demo: находки, подсчёт, тип, ответ и строки из собственного copy.json', async () => {
    const h = makeHarness({ model: demoModel, packRoots: [TEST_PACKS] });
    const res = await runAnalysis(h, DEMO_BODY);
    assert.equal(res.status, 200);
    const r = await res.json();

    const copy = JSON.parse(readFileSync(path.join(TEST_PACKS, 'demo', 'copy.json'), 'utf8'));
    assert.equal(r.versions.pack, 'demo@demo-1');
    assert.deepEqual(r.axes.map(function (a) { return a.key; }), ['claims', 'proof']);
    assert.equal(r.type.key, 'loud');
    assert.deepEqual(r.type, { key: 'loud', title: copy.types.loud.title, line: copy.types.loud.line, check: copy.types.loud.check });
    assert.equal(r.advocate[r.advocate.length - 1], copy.advocate.always);
    assert.equal(r.unknowns[0], copy.unknowns[0]);
    assert.deepEqual(r.answers.map(function (a) { return a.id; }), ['q_proof']);
    assert.ok(r.findings.some(function (f) { return f.signal === 'boast'; }));
    assert.ok(r.findings.some(function (f) { return f.signal === 'cite'; }));
    assert.ok(r.seller_questions.length >= 3);
    assert.deepEqual(Object.keys(r.counts), ['boasts']);

    const sys = h.modelCalls[0].body.system[0].text;
    assert.match(sys, /Разметь сигналы из списка/);
    assert.match(sys, /`boast`/);
    assert.doesNotMatch(sys, /urgency/);
    const tool = h.modelCalls[0].body.tools[0];
    assert.deepEqual(tool.input_schema.properties.findings.items.properties.signal.enum, ['boast', 'hype', 'cite']);
});

test('demo: сценарий и жанр проверяются по рубрике demo, а не courses', async () => {
    const h = makeHarness({ model: demoModel, packRoots: [TEST_PACKS] });
    const bad1 = Object.assign({}, DEMO_BODY, { scenario: 'course' });
    assert.equal((await h.app.analyze(analyzeRequest(bad1))).status, 400);
    const bad2 = Object.assign({}, DEMO_BODY, { texts: DEMO_BODY.texts.map(function (t) { return Object.assign({}, t, { genre: 'post' }); }) });
    assert.equal((await h.app.analyze(analyzeRequest(bad2))).status, 400);
    assert.equal(h.modelCalls.length, 0);
});

// ── API ──────────────────────────────────────────────────────────────

test('analyze без domain работает как раньше, versions.pack = courses@1', async () => {
    const h = makeHarness();
    const r = await (await runAnalysis(h, body3())).json();
    assert.equal(r.versions.pack, 'courses@1');
});

test('analyze с неизвестным domain: 400 до частоты и модели', async () => {
    for (const d of ['nope', '../courses', 42]) {
        const h = makeHarness();
        const res = await h.app.analyze(analyzeRequest(Object.assign(body3(), { domain: d })));
        assert.equal(res.status, 400, String(d));
        assert.equal(h.modelCalls.length, 0);
        assert.deepEqual(h.stores.ratelimit.dump(), {});
    }
});

test('id пакета входит в ключ кэша: те же тексты в другом пакете размечаются заново', async () => {
    const h = makeHarness({ model: demoModel, packRoots: [TEST_PACKS] });
    const texts = DEMO_BODY.texts.map(function (t) { return Object.assign({}, t, { genre: 'sale' }); });
    await runAnalysis(h, { domain: 'demo', scenario: 'look', texts: texts });
    await runAnalysis(h, { scenario: 'course', texts: texts });
    assert.equal(h.modelCalls.length, 2);
    assert.equal(Object.keys(h.stores.extractions.dump()).length, 2);
});

function packRequest(query) {
    return new Request(SITE + '/api/pack' + (query || ''), { method: 'GET' });
}

test('/api/pack: публичная часть пакета, кэш на час; без domain — courses', async () => {
    const h = makeHarness({ packRoots: [TEST_PACKS] });
    const res = await h.app.pack(packRequest('?domain=demo'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    const body = await res.json();
    assert.deepEqual(body, JSON.parse(JSON.stringify(publicPack(loadPack('demo', { roots: [TEST_PACKS] })))));

    const def = await (await h.app.pack(packRequest(''))).json();
    assert.equal(def.id, 'courses');
});

test('/api/pack: неизвестный домен 400, не GET 405', async () => {
    const h = makeHarness();
    assert.equal((await h.app.pack(packRequest('?domain=nope'))).status, 400);
    assert.equal((await h.app.pack(new Request(SITE + '/api/pack', { method: 'POST', body: '{}' }))).status, 405);
});

// ── Знание про домен живёт только в пакете ──────────────────────────

function walk(dir, out) {
    for (const f of readdirSync(dir)) {
        if (f === 'node_modules' || f === '.git') continue;
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}

test('в engine/, netlify/functions/ и странице нет слов домена', () => {
    const files = walk(path.join(ROOT, 'engine'), []).concat(walk(path.join(ROOT, 'netlify', 'functions'), []), [path.join(ROOT, 'public', 'index.html')]);
    const stems = ['оплат', 'продав', 'курс', 'наставник', 'покупател'];
    const hits = [];
    for (const f of files) {
        const text = readFileSync(f, 'utf8').toLowerCase().replace(/ё/g, 'е');
        for (const s of stems) if (text.indexOf(s) !== -1) hits.push(path.relative(ROOT, f) + ': ' + s);
    }
    assert.deepEqual(hits, []);
});

test('старые engine/rubric.json и prompts/extract.md удалены, других копий рубрики и промпта нет', () => {
    assert.equal(existsSync(path.join(ROOT, 'engine', 'rubric.json')), false);
    assert.equal(existsSync(path.join(ROOT, 'prompts', 'extract.md')), false);
    const all = walk(ROOT, []).map(function (p) { return path.relative(ROOT, p); });
    const rubrics = all.filter(function (p) { return /(^|\/)rubric\.json$/.test(p); });
    const prompts = all.filter(function (p) { return /(^|\/)(prompt|extract)\.md$/.test(p); });
    assert.deepEqual(rubrics, ['packs/courses/rubric.json', 'test/fixtures/packs/demo/rubric.json']);
    assert.deepEqual(prompts, ['packs/courses/prompt.md', 'test/fixtures/packs/demo/prompt.md']);
});
