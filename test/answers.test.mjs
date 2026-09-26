// Ответы на вопросы до оплаты. Функция только читает уже посчитанный
// результат: уровни осей, находки, уверенность. Здесь проверяется,
// что ответ собран по шаблону своего уровня, ссылается только на
// существующие находки и не утверждает больше, чем в них есть.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRubric } from '../engine/assets.mjs';
import { answers, normalizeSelection } from '../engine/answers.mjs';
import { score } from '../engine/score.mjs';

const rubric = loadRubric();
const AXES = Object.keys(rubric.axes);

// Результат подсчёта в той форме, в какой его отдаёт score(): оси с
// уровнями, находки с баллами, уверенность. Всё, что не задано, по нулям.
function result(opts) {
    opts = opts || {};
    const levels = opts.levels || {};
    return {
        axes: AXES.map(function (k) {
            return { key: k, label: rubric.axes[k].label, polarity: rubric.axes[k].polarity, level: levels[k] || 0 };
        }),
        findings: (opts.findings || []).map(function (f, i) {
            const sig = rubric.signals[f.signal];
            return {
                text_id: f.text_id || 't1',
                quote: f.quote || ('цитата ' + i),
                signal: f.signal,
                signal_label: sig.label,
                axis: sig.axis,
                strength: 2,
                modifiers: [],
                points: f.points !== undefined ? f.points : sig.weight,
            };
        }),
        confidence: { level: opts.confidence === undefined ? 1 : opts.confidence, label: 'средняя', reason: 'причина' },
    };
}

function byId(out, id) { return out.answers.find(function (a) { return a.id === id; }); }
function rep(n, f) { return Array.from({ length: n }, function () { return Object.assign({}, f); }); }

test('семь ответов в порядке рубрики, у каждого вопрос, текст, метка уровня', () => {
    const out = answers(result(), rubric);
    assert.deepEqual(out.answers.map(function (a) { return a.id; }), rubric.questions.map(function (q) { return q.id; }));
    for (const a of out.answers) {
        assert.equal(typeof a.question, 'string');
        assert.ok(a.text.length > 0 && a.level_word.length > 0, a.id);
        assert.doesNotMatch(a.text, /\{/, a.id + ': подстановка осталась в тексте');
    }
});

test('шаблон по уровню тревожной оси: 0, 1, 2 и {n} равно числу находок оси', () => {
    const q = rubric.questions.find(function (x) { return x.id === 'q_now'; });
    for (const level of [0, 1, 2]) {
        const f = rep(5, { signal: 'urgency' }).concat(rep(2, { signal: 'scarcity' }));
        const a = byId(answers(result({ levels: { pressure: level }, findings: f }), rubric), 'q_now');
        assert.equal(a.level, level);
        assert.equal(a.level_word, q.templates[String(level)].label);
        assert.equal(a.count, 7);
        assert.equal(a.text, q.templates[String(level)].text.replace('{n}', '7'));
    }
});

test('хорошая ось: высокий уровень считает только находки с плюсом, низкий только с минусом', () => {
    const f = rep(3, { signal: 'named_source' }).concat(rep(4, { signal: 'vague_source' }));
    const high = byId(answers(result({ levels: { verifiability: 2 }, findings: f }), rubric), 'q_check');
    assert.equal(high.count, 3, 'источник без имени не подтверждает «есть на что опереться»');
    const low = byId(answers(result({ levels: { verifiability: 0 }, findings: f }), rubric), 'q_check');
    assert.equal(low.count, 4, 'низкий уровень подтверждают находки с минусом');
});

test('подтверждения: первые три по модулю баллов, ссылки на существующие находки, count — все', () => {
    const f = [
        { signal: 'urgency', points: 1 }, { signal: 'urgency', points: 3 },
        { signal: 'scarcity', points: 2 }, { signal: 'fear_loss', points: 2.5 }, { signal: 'urgency', points: 0.5 },
    ];
    const r = result({ levels: { pressure: 2 }, findings: f });
    const a = byId(answers(r, rubric), 'q_now');
    assert.deepEqual(a.evidence, ['f1', 'f3', 'f2']);
    assert.equal(a.count, 5);
    for (const id of a.evidence) assert.ok(r.findings[Number(id.slice(1))], id);
});

test('уровень оси высокий, а подходящих находок нет: шаблон «низкий», не выдумка', () => {
    const a = byId(answers(result({ levels: { promises: 2 }, findings: [] }), rubric), 'q_promise');
    assert.equal(a.level, 0);
    assert.equal(a.count, 0);
    assert.deepEqual(a.evidence, []);
});

test('без находок все ответы на нижнем шаблоне, у q_fail шаблон «молчание»', () => {
    const out = answers(result(), rubric);
    for (const a of out.answers) {
        if (a.id === 'q_fail') assert.equal(a.template, 'silent');
        else assert.equal(a.template, '0', a.id);
        assert.equal(a.count, 0);
    }
});

test('q_after: высокая Эксклюзивность включает шаблон «зависимость», {n} по Эксклюзивности', () => {
    const f = rep(4, { signal: 'only_me' }).concat(rep(2, { signal: 'referral' }));
    const a = byId(answers(result({ levels: { exclusivity: 2, autonomy: 1 }, findings: f }), rubric), 'q_after');
    assert.equal(a.template, 'dependency');
    assert.equal(a.count, 4);
    assert.match(a.text, /: 4\./);
    const b = byId(answers(result({ levels: { exclusivity: 1, autonomy: 1 }, findings: f }), rubric), 'q_after');
    assert.equal(b.template, '1');
    assert.equal(b.count, 2);
});

test('q_fail: тревожные сигналы важнее неудачного случая, иначе «хороший», иначе «молчание»', () => {
    const alarm = byId(answers(result({ findings: [{ signal: 'negative_case' }, { signal: 'shame_doubt' }, { signal: 'hidden_terms' }] }), rubric), 'q_fail');
    assert.equal(alarm.template, 'alarm');
    assert.equal(alarm.count, 2);
    const good = byId(answers(result({ findings: [{ signal: 'negative_case' }] }), rubric), 'q_fail');
    assert.equal(good.template, 'good');
    assert.equal(good.count, 1);
    assert.equal(byId(answers(result({ findings: [{ signal: 'urgency' }] }), rubric), 'q_fail').template, 'silent');
});

test('низкая уверенность: у всех ответов preliminary, иначе ни у одного', () => {
    assert.ok(answers(result({ confidence: 0 }), rubric).answers.every(function (a) { return a.preliminary === true; }));
    assert.ok(answers(result({ confidence: 1 }), rubric).answers.every(function (a) { return a.preliminary === false; }));
});

test('вопросы продавцу: от 3 до 5, без повторов, при нуле сработавших добиваются общими', () => {
    const none = answers(result({ levels: { integrity: 2, verifiability: 2, autonomy: 2 }, findings: [
        { signal: 'limitation_stated' }, { signal: 'named_source' }, { signal: 'referral' }, { signal: 'negative_case' },
    ] }), rubric);
    assert.deepEqual(none.seller_questions, rubric.seller_fallback);

    const all = answers(result({ levels: { pressure: 2, promises: 2, commerce: 2, exclusivity: 2 }, findings: [
        { signal: 'urgency' }, { signal: 'outcome_promise' }, { signal: 'price_ladder' }, { signal: 'only_me' }, { signal: 'shame_doubt' },
    ] }), rubric);
    assert.equal(all.seller_questions.length, 5);
    assert.equal(new Set(all.seller_questions).size, 5);
});

test('вопросы продавцу: сначала от выбранных, внутри по тревожности', () => {
    const r = result({ levels: { pressure: 1, commerce: 2 }, findings: [{ signal: 'urgency' }, { signal: 'price_ladder' }] });
    const ask = function (id) { return rubric.questions.find(function (q) { return q.id === id; }).ask_seller.text; };

    const a = answers(r, rubric, ['q_now', 'q_cost']);
    assert.deepEqual(a.seller_questions.slice(0, 2), [ask('q_cost'), ask('q_now')], 'Коммерция высокая, Давление среднее');

    const b = answers(r, rubric, ['q_now']);
    assert.equal(b.seller_questions[0], ask('q_now'), 'выбранный раньше невыбранного, даже менее тревожный');
});

test('«в пользу»: до трёх находок хороших осей с плюсом, по баллам', () => {
    const r = result({ findings: [
        { signal: 'urgency' }, { signal: 'referral', points: 2 }, { signal: 'vague_source' },
        { signal: 'named_source', points: 3 }, { signal: 'exit_ok', points: 1 }, { signal: 'negative_case', points: 2.5 },
    ] });
    assert.deepEqual(answers(r, rubric).in_favor, ['f3', 'f5', 'f1']);
    assert.deepEqual(answers(result({ findings: [{ signal: 'urgency' }] }), rubric).in_favor, []);
});

test('детерминизм: тот же результат дважды даёт те же ответы', () => {
    const f = [{ signal: 'urgency' }, { signal: 'urgency', points: 1 }, { signal: 'price_ladder' }, { signal: 'negative_case' }];
    const r = result({ levels: { pressure: 1, commerce: 1 }, findings: f });
    assert.deepEqual(answers(r, rubric, ['q_fail', 'q_now']), answers(JSON.parse(JSON.stringify(r)), rubric, ['q_fail', 'q_now']));
});

test('на настоящем результате score(): каждая ссылка ведёт на находку своей оси или своего сигнала', () => {
    const texts = ['t1', 't2', 't3'];
    const findings = [
        { text_id: 't1', quote: 'а', signal: 'urgency', strength: 3, modifiers: [], context_note: '', alt_explanation: '' },
        { text_id: 't2', quote: 'б', signal: 'scarcity', strength: 2, modifiers: [], context_note: '', alt_explanation: '' },
        { text_id: 't3', quote: 'в', signal: 'named_source', strength: 2, modifiers: [], context_note: '', alt_explanation: '' },
        { text_id: 't3', quote: 'г', signal: 'unfalsifiable', strength: 2, modifiers: [], context_note: '', alt_explanation: '' },
    ];
    const r = score({
        findings: findings,
        texts_meta: texts.map(function (id, i) { return { id: id, genre: 'post', words: 400, cluster: i }; }),
        scenario: 'course', rubric: rubric, dropped_quotes: 0, raw_findings: 4,
    });
    const out = answers(r, rubric);
    for (const a of out.answers) {
        const q = rubric.questions.find(function (x) { return x.id === a.id; });
        for (const id of a.evidence) {
            const f = r.findings[Number(id.slice(1))];
            assert.ok(f, a.id + ' ' + id);
            const axis = a.template === 'dependency' ? q.override.axis : q.source.axis;
            if (axis) assert.equal(f.axis, axis, a.id);
        }
    }
});

test('выбор вопросов: дубли и незнакомые отвергаются, пустой выбор тоже; без выбора — вопросы по умолчанию', () => {
    assert.deepEqual(normalizeSelection(undefined, rubric), { ok: true, ids: ['q_now', 'q_promise', 'q_cost'] });
    assert.deepEqual(normalizeSelection(['q_fail', 'q_now'], rubric), { ok: true, ids: ['q_fail', 'q_now'] });
    assert.equal(normalizeSelection([], rubric).ok, false);
    assert.equal(normalizeSelection(['q_now', 'q_now'], rubric).ok, false);
    assert.equal(normalizeSelection(['q_zzz'], rubric).ok, false);
    assert.equal(normalizeSelection('q_now', rubric).ok, false);
});

test('нижние шаблоны осей говорят «почти»: нижний уровень бывает и при слабых находках', () => {
    for (const q of rubric.questions) {
        const t = q.templates['0'];
        if (!t) continue;
        assert.match(t.text, /почти/i, q.id + ': ' + t.text);
        assert.match(t.label, /почти/i, q.id + ': ' + t.label);
    }
});
