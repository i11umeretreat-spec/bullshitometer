// Подсчёт. Ошибка здесь это ложное обвинение, а воспроизводимость
// главное обещание продукта. Всё без сети и без модели.

import test from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../engine/score.mjs';
import { buildTextsMeta } from '../engine/verify.mjs';
import { loadRubric } from '../engine/assets.mjs';

const rubric = loadRubric();

function f(text_id, signal, strength, extra) {
    return Object.assign({
        text_id: text_id, quote: 'цитата ' + signal + ' ' + text_id, signal: signal,
        strength: strength || 2, modifiers: [], context_note: '', alt_explanation: 'невинное объяснение ' + signal,
    }, extra || {});
}

// Восемь разных текстов по 500 слов: уверенность высокая,
// и тип определяется осями, а не нехваткой данных.
function meta(n, genre) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push({ id: 't' + i, genre: genre || 'post', words: 500, cluster: i - 1 });
    return out;
}

function levelOf(result, key) {
    return result.axes.find(function (a) { return a.key === key; }).level;
}

test('один вход сто раз: сто одинаковых выходов', () => {
    const findings = [
        f('t1', 'urgency', 2), f('t2', 'only_me', 3), f('t3', 'price_ladder', 2),
        f('t4', 'named_source', 2), f('t5', 'exit_ok', 1), f('t1', 'scarcity', 2, { modifiers: ['timebound'] }),
    ];
    const first = JSON.stringify(score({ findings: findings, texts_meta: meta(8), scenario: 'course', rubric: rubric }));
    for (let i = 0; i < 100; i++) {
        const shuffled = findings.slice().sort(function () { return 0.5 - (i % 2); });
        const again = JSON.stringify(score({ findings: shuffled, texts_meta: meta(8), scenario: 'course', rubric: rubric }));
        assert.equal(again, first, 'прогон ' + i);
    }
});

test('добавленная тревожная находка не опускает уровень её оси', () => {
    const base = [f('t1', 'urgency', 1), f('t2', 'scarcity', 1)];
    const before = score({ findings: base, texts_meta: meta(8), scenario: 'course', rubric: rubric });
    for (const extra of ['urgency', 'scarcity', 'shame_doubt', 'fear_loss']) {
        for (const tid of ['t1', 't3']) {
            const after = score({ findings: base.concat([f(tid, extra, 3)]), texts_meta: meta(8), scenario: 'course', rubric: rubric });
            assert.ok(levelOf(after, 'pressure') >= levelOf(before, 'pressure'), extra + ' в ' + tid);
            const a = after.axes.find(function (x) { return x.key === 'pressure'; });
            const b = before.axes.find(function (x) { return x.key === 'pressure'; });
            assert.ok(a.raw >= b.raw);
        }
    }
});

test('десять одинаковых urgency в одном тексте: сумма не выше 3·w', () => {
    const findings = [];
    for (let i = 0; i < 10; i++) findings.push(f('t1', 'urgency', 3, { modifiers: ['guaranteed', 'timebound'], quote: 'срок ' + i }));
    const r = score({ findings: findings, texts_meta: meta(1), scenario: 'ad', rubric: rubric });
    const axis = r.axes.find(function (a) { return a.key === 'pressure'; });
    const top = axis.top.find(function (t) { return t.signal === 'urgency'; });
    const w = rubric.signals.urgency.weight;
    // Множитель сценария ad на давление: 1.2. Сам потолок в текстовом
    // балле, до сценария: 3·w.
    assert.ok(top.points <= 3 * w * rubric.scenario.ad.pressure + 1e-9, 'балл ' + top.points);
    assert.ok(top.points / rubric.scenario.ad.pressure <= 3 * w + 1e-9);
});

test('насыщение: k-я находка весит 1/k', () => {
    const one = score({ findings: [f('t1', 'only_me', 2)], texts_meta: meta(1), scenario: 'course', rubric: rubric });
    const two = score({ findings: [f('t1', 'only_me', 2, { quote: 'a' }), f('t1', 'only_me', 2, { quote: 'b' })], texts_meta: meta(1), scenario: 'course', rubric: rubric });
    const r1 = one.axes.find(function (a) { return a.key === 'exclusivity'; }).raw;
    const r2 = two.axes.find(function (a) { return a.key === 'exclusivity'; }).raw;
    assert.ok(Math.abs(r2 - r1 * 1.5) < 1e-9, r1 + ' → ' + r2);
});

test('два одинаковых текста: n_eff = 1', () => {
    const text = 'Сегодня я расскажу вам про метод, который работает у всех без исключения, если вы делаете всё по инструкции и не пропускаете занятия.';
    const tm = buildTextsMeta([
        { id: 't1', genre: 'post', text: text },
        { id: 't2', genre: 'post', text: text },
    ], [], rubric);
    const r = score({ findings: [f('t1', 'urgency', 2), f('t2', 'urgency', 2)], texts_meta: tm, scenario: 'course', rubric: rubric });
    assert.equal(r.stats.n, 2);
    assert.equal(r.stats.n_eff, 1);
});

test('помеченные template_like склеиваются в один кластер', () => {
    const tm = buildTextsMeta([
        { id: 't1', genre: 'post', text: 'Первый совершенно отдельный текст про утро и кофе на балконе.' },
        { id: 't2', genre: 'post', text: 'Второй про вечерние прогулки у моря и шум волн под окнами.' },
        { id: 't3', genre: 'post', text: 'Третий про работу в саду и урожай помидоров в этом году.' },
    ], ['t1', 't2'], rubric);
    const clusters = new Set(tm.map(function (t) { return t.cluster; }));
    assert.equal(clusters.size, 2);
});

test('подходит и под Чёрную дыру, и под Кормушку: Чёрная дыра', () => {
    const findings = [];
    for (let i = 1; i <= 8; i++) {
        const t = 't' + i;
        findings.push(f(t, 'only_me', 3), f(t, 'forbid_others', 3), f(t, 'dependency', 3));
        findings.push(f(t, 'price_ladder', 3), f(t, 'upsell', 3), f(t, 'hidden_terms', 3));
        findings.push(f(t, 'urgency', 3));
    }
    const r = score({ findings: findings, texts_meta: meta(8), scenario: 'course', rubric: rubric });
    assert.equal(levelOf(r, 'exclusivity'), 2);
    assert.equal(levelOf(r, 'commerce'), 2);
    assert.equal(levelOf(r, 'autonomy'), 0);
    assert.equal(r.type.key, 'black_hole');
});

test('Кормушка без эксклюзивности', () => {
    const findings = [];
    for (let i = 1; i <= 8; i++) findings.push(f('t' + i, 'price_ladder', 3), f('t' + i, 'upsell', 3), f('t' + i, 'hidden_terms', 2));
    const r = score({ findings: findings, texts_meta: meta(8), scenario: 'course', rubric: rubric });
    assert.equal(r.type.key, 'feeder');
});

test('низкая уверенность при любых осях: Тёмная материя', () => {
    const heavy = [];
    for (let i = 1; i <= 2; i++) heavy.push(f('t' + i, 'only_me', 3), f('t' + i, 'forbid_others', 3), f('t' + i, 'urgency', 3));
    // два текста: n_eff меньше трёх
    const r1 = score({ findings: heavy, texts_meta: meta(2), scenario: 'course', rubric: rubric });
    assert.equal(r1.confidence.level, 0);
    assert.equal(r1.type.key, 'dark_matter');

    // восемь текстов, но всего 700 слов
    const small = meta(8).map(function (t) { return Object.assign({}, t, { words: 80 }); });
    const r2 = score({ findings: heavy, texts_meta: small, scenario: 'course', rubric: rubric });
    assert.equal(r2.confidence.level, 0);
    assert.equal(r2.type.key, 'dark_matter');
    assert.ok(r2.confidence.reason.length > 0);
});

test('один короткий текст до 800 слов: Тёмная материя и уверенность «низкая»', () => {
    const tm = [{ id: 't1', genre: 'post', words: 600, cluster: 0 }];
    const r = score({ findings: [f('t1', 'urgency', 2)], texts_meta: tm, scenario: 'course', rubric: rubric });
    assert.equal(r.type.title, 'Тёмная материя');
    assert.equal(r.confidence.level, 0);
});

test('много выброшенных цитат опускают уверенность на уровень', () => {
    const findings = [f('t1', 'named_source', 2)];
    const ok = score({ findings: findings, texts_meta: meta(8).map(function (t) { return Object.assign({}, t, { words: 500 }); }), scenario: 'course', rubric: rubric, raw_findings: 10, dropped_quotes: 1 });
    const bad = score({ findings: findings, texts_meta: meta(8).map(function (t) { return Object.assign({}, t, { words: 500 }); }), scenario: 'course', rubric: rubric, raw_findings: 10, dropped_quotes: 4 });
    assert.equal(ok.confidence.level, 2);
    assert.equal(bad.confidence.level, 1);
});

test('urgency в продающем тексте весит вдвое меньше, чем в посте', () => {
    const sale = score({ findings: [f('t1', 'urgency', 2)], texts_meta: meta(1, 'sale'), scenario: 'course', rubric: rubric });
    const post = score({ findings: [f('t1', 'urgency', 2)], texts_meta: meta(1, 'post'), scenario: 'course', rubric: rubric });
    const s = sale.axes.find(function (a) { return a.key === 'pressure'; }).raw;
    const p = post.axes.find(function (a) { return a.key === 'pressure'; }).raw;
    assert.ok(Math.abs(s * 2 - p) < 1e-9, s + ' против ' + p);
});

test('отрицательный балл хорошей оси обрезается до нуля, но находка видна', () => {
    const r = score({ findings: [f('t1', 'pseudo_science', 3)], texts_meta: meta(8), scenario: 'course', rubric: rubric });
    const axis = r.axes.find(function (a) { return a.key === 'verifiability'; });
    assert.ok(axis.raw < 0);
    assert.equal(axis.v, 0);
    assert.equal(axis.level, 0);
    assert.equal(r.findings.length, 1);
    assert.ok(r.findings[0].points < 0);
});

test('сценарий меняет порядок осей', () => {
    const a = score({ findings: [], texts_meta: meta(8), scenario: 'course', rubric: rubric });
    const b = score({ findings: [], texts_meta: meta(8), scenario: 'therapist', rubric: rubric });
    assert.equal(a.axes[0].key, 'commerce');
    assert.equal(b.axes[0].key, 'promises');
});

test('адвокат: до пяти пунктов, последний всегда про то, чего мы не видели', () => {
    const findings = [];
    for (let i = 1; i <= 8; i++) findings.push(f('t' + i, 'urgency', 3), f('t' + i, 'only_me', 3), f('t' + i, 'price_ladder', 3), f('t' + i, 'miracle_claim', 3));
    const saleMeta = meta(8, 'sale');
    saleMeta[0].cluster = saleMeta[1].cluster;
    const r = score({ findings: findings, texts_meta: saleMeta, scenario: 'course', rubric: rubric });
    assert.ok(r.advocate.length <= 5);
    assert.equal(r.advocate[r.advocate.length - 1], rubric.advocate.always);
    assert.equal(new Set(r.advocate).size, r.advocate.length, 'без повторов');
});

test('счётчики карточки', () => {
    const r = score({ findings: [
        f('t1', 'outcome_promise'), f('t2', 'miracle_claim'), f('t3', 'urgency'),
        f('t4', 'scarcity'), f('t5', 'scarcity'), f('t6', 'named_source'),
    ], texts_meta: meta(8), scenario: 'course', rubric: rubric });
    assert.deepEqual(r.counts, { promises: 2, deadlines: 3, sources: 1 });
});

test('в ответе нет ни процента, ни вероятности', () => {
    const r = score({ findings: [f('t1', 'urgency', 2)], texts_meta: meta(8), scenario: 'course', rubric: rubric });
    const text = JSON.stringify(r);
    assert.ok(!/percent|probability|вероятност|%/.test(text));
});
