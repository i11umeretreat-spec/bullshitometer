// Доменные пакеты. Движок один, домен — папка с данными:
//
//   packs/<id>/pack.json    паспорт: id, версия, язык, вид подкрепления,
//                           порядок жанров, сценарии
//   packs/<id>/rubric.json  сигналы, оси, веса, пороги, типы, вопросы
//   packs/<id>/prompt.md    промпт разметки, первая строка «prompt-version: N»
//   packs/<id>/copy.json    строки интерфейса, которые говорят про домен
//
// Загрузка проверяет перекрёстные ссылки между файлами и падает сразу,
// с пакетом, файлом и ключом в тексте ошибки: сломанный пакет должен
// остановить функцию при холодном старте, а не дать странный разбор.
// В пакете нет кода: всё, что он умеет, объявлено данными.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Виды подкрепления, которые умеет движок. Пакет с другим видом не
// загружается: угадывать, как его проверять, движок не должен.
export const SUPPORTED_EVIDENCE = ['quote'];

// Контракт copy.json: без любого из этих ключей пакет не загружается.
export const REQUIRED_COPY = [
    'input.questions_title',
    'input.questions_sub',
    'input.questions_aria',
    'input.questions_none',
    'input.texts_hint',
    'input.text_placeholder',
    'input.wait_lines',
    'result.answers_title',
    'result.answers_prelim',
    'result.answer_prelim',
    'result.answer_ask',
    'result.in_favor_title',
    'result.in_favor_empty',
    'result.seller_title',
    'result.seller_intro',
    'result.seller_copy',
    'result.seller_copied',
    'result.seller_copy_failed',
    'result.more_title',
    'result.axes_title',
    'card.counters',
    'types',
    'advocate.sale_share',
    'advocate.templates',
    'advocate.always',
    'unknowns',
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Корни, где лежат пакеты. После сборки функции папка packs лежит не
// рядом с бандлом, а там, куда её положил included_files.
function defaultRoots() {
    return [
        path.join(HERE, '..', 'packs'),
        path.join(process.cwd(), 'packs'),
        '/var/task/packs',
    ];
}

function notFound(id) {
    const e = new Error('пакет «' + id + '» не найден');
    e.code = 'PACK_NOT_FOUND';
    return e;
}

const cache = new Map();

export function loadPack(id, opts) {
    const roots = ((opts && opts.roots) || []).concat(defaultRoots());
    if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound(String(id));
    const root = roots.find(function (r) { return existsSync(path.join(r, id, 'pack.json')); });
    if (!root) throw notFound(id);
    const dir = path.join(root, id);
    if (!cache.has(dir)) cache.set(dir, readPack(id, dir));
    return cache.get(dir);
}

function readPack(id, dir) {
    const rel = function (f) { return path.join('packs', id, f); };
    const fail = function (file, key, msg) {
        throw new Error('пакет «' + id + '»: ' + rel(file) + ': ' + key + ': ' + msg);
    };
    const readJson = function (file) {
        let raw;
        try { raw = readFileSync(path.join(dir, file), 'utf8'); } catch (e) { fail(file, '-', 'файла нет'); }
        try { return JSON.parse(raw); } catch (e) { return fail(file, '-', 'не JSON: ' + e.message); }
    };

    const passport = readJson('pack.json');
    const rubric = readJson('rubric.json');
    const copy = readJson('copy.json');

    let promptRaw;
    try { promptRaw = readFileSync(path.join(dir, 'prompt.md'), 'utf8'); } catch (e) { fail('prompt.md', '-', 'файла нет'); }
    const first = promptRaw.split('\n', 1)[0];
    const m = /^prompt-version:\s*(\S+)/.exec(first);
    if (!m) fail('prompt.md', 'prompt-version', 'первая строка должна быть «prompt-version: N»');
    const template = promptRaw.slice(first.length + 1).trim();
    if (template.indexOf('{{SIGNALS}}') === -1) fail('prompt.md', '{{SIGNALS}}', 'нет места для списка сигналов');

    checkPassport(passport, id, rubric, fail);
    checkRubric(rubric, fail);
    checkCopy(copy, rubric, fail);

    return Object.freeze({
        id: passport.id,
        version: passport.version,
        title: passport.title,
        language: passport.language,
        evidence: passport.evidence,
        genres: passport.genres,
        scenarios: passport.scenarios,
        rubric: rubric,
        prompt: { version: m[1], template: template },
        copy: copy,
    });
}

function isStr(x) { return typeof x === 'string' && x.length > 0; }

function checkPassport(p, id, rubric, fail) {
    const F = 'pack.json';
    if (p.id !== id) fail(F, 'id', '«' + p.id + '» не совпадает с папкой «' + id + '»');
    for (const k of ['version', 'title', 'language']) if (!isStr(p[k])) fail(F, k, 'нужна непустая строка');
    if (!p.evidence || SUPPORTED_EVIDENCE.indexOf(p.evidence.kind) === -1) {
        fail(F, 'evidence.kind', '«' + (p.evidence && p.evidence.kind) + '» не поддерживается, движок умеет: ' + SUPPORTED_EVIDENCE.join(', '));
    }
    // Порядок жанров в интерфейсе, первый — по умолчанию. Набор тот же,
    // что в рубрике: жанр без весов или вес без жанра — ошибка пакета.
    const gWant = Object.keys(rubric.genres || {});
    if (!Array.isArray(p.genres) || p.genres.slice().sort().join() !== gWant.slice().sort().join()) {
        fail(F, 'genres', '[' + (p.genres || []).join(', ') + '] не совпадает с rubric.genres [' + gWant.join(', ') + ']');
    }
    if (!Array.isArray(p.scenarios) || p.scenarios.length === 0) fail(F, 'scenarios', 'нужен хотя бы один сценарий');
    const ids = p.scenarios.map(function (s) { return s.id; });
    const want = Object.keys(rubric.scenario || {});
    if (ids.slice().sort().join() !== want.slice().sort().join()) {
        fail(F, 'scenarios', 'id сценариев [' + ids.join(', ') + '] не совпадают с rubric.scenario [' + want.join(', ') + ']');
    }
    p.scenarios.forEach(function (s, i) { if (!isStr(s.label)) fail(F, 'scenarios[' + i + '].label', 'нужна строка'); });
    if (p.scenarios.filter(function (s) { return s.default; }).length !== 1) fail(F, 'scenarios', 'ровно один сценарий должен быть default');
}

function checkRubric(r, fail) {
    const F = 'rubric.json';
    const axes = r.axes || {};
    const signals = r.signals || {};
    const hasAxis = function (a) { return Object.prototype.hasOwnProperty.call(axes, a); };
    const hasSignal = function (s) { return Object.prototype.hasOwnProperty.call(signals, s); };

    if (!Object.keys(axes).length) fail(F, 'axes', 'нет осей');
    for (const k of Object.keys(axes)) {
        if (['neg', 'pos'].indexOf(axes[k].polarity) === -1) fail(F, 'axes.' + k + '.polarity', 'нужно neg или pos');
        if (!(axes[k].k > 0)) fail(F, 'axes.' + k + '.k', 'нужно число больше нуля');
    }
    for (const k of Object.keys(signals)) {
        if (!hasAxis(signals[k].axis)) fail(F, 'signals.' + k + '.axis', 'нет оси «' + signals[k].axis + '»');
        if (typeof signals[k].weight !== 'number') fail(F, 'signals.' + k + '.weight', 'нужно число');
    }
    if (!r.genres || !Object.keys(r.genres).length) fail(F, 'genres', 'нет жанров');
    for (const g of Object.keys(r.genre || {})) {
        if (!Object.prototype.hasOwnProperty.call(r.genres, g)) fail(F, 'genre.' + g, 'нет жанра «' + g + '» в genres');
        for (const s of Object.keys(r.genre[g])) if (!hasSignal(s)) fail(F, 'genre.' + g + '.' + s, 'нет сигнала «' + s + '»');
    }
    for (const sc of Object.keys(r.scenario || {})) {
        for (const a of Object.keys(r.scenario[sc])) if (!hasAxis(a)) fail(F, 'scenario.' + sc + '.' + a, 'нет оси «' + a + '»');
    }
    for (const sc of Object.keys(r.scenario_meta || {})) {
        if (!Object.prototype.hasOwnProperty.call(r.scenario || {}, sc)) fail(F, 'scenario_meta.' + sc, 'нет сценария «' + sc + '»');
        (r.scenario_meta[sc].order || []).forEach(function (a) { if (!hasAxis(a)) fail(F, 'scenario_meta.' + sc + '.order', 'нет оси «' + a + '»'); });
    }
    for (const c of Object.keys(r.counts || {})) {
        r.counts[c].forEach(function (s) { if (!hasSignal(s)) fail(F, 'counts.' + c, 'нет сигнала «' + s + '»'); });
    }

    // Правила типов: оси и сигналы в условиях существуют, последний тип
    // срабатывает всегда, иначе результат мог бы остаться без типа.
    const checkCond = function (c, where) {
        if (c.always === true) return;
        if (c.all || c.any) { (c.all || c.any).forEach(function (x, i) { checkCond(x, where + '.' + (c.all ? 'all' : 'any') + '[' + i + ']'); }); return; }
        if (c.confidence_lte !== undefined) return;
        if (c.axis !== undefined) { if (!hasAxis(c.axis)) fail(F, where + '.axis', 'нет оси «' + c.axis + '»'); return; }
        if (c.signals) { c.signals.forEach(function (s) { if (!hasSignal(s)) fail(F, where + '.signals', 'нет сигнала «' + s + '»'); }); return; }
        fail(F, where, 'непонятное условие');
    };
    if (!Array.isArray(r.types) || !r.types.length) fail(F, 'types', 'нет типов');
    const typeKeys = new Set();
    r.types.forEach(function (t, i) {
        if (!isStr(t.key) || typeKeys.has(t.key)) fail(F, 'types[' + i + '].key', 'пустой или повторяется');
        typeKeys.add(t.key);
        checkCond(t.when || {}, 'types[' + i + '].when');
    });
    if (!(r.types[r.types.length - 1].when || {}).always) fail(F, 'types[' + (r.types.length - 1) + '].when', 'последний тип должен срабатывать всегда');

    // Вопросы: источник ответа, шаблоны и условия встречного вопроса.
    if (!Array.isArray(r.questions) || !r.questions.length) fail(F, 'questions', 'нет вопросов');
    const qids = new Set();
    r.questions.forEach(function (q, i) {
        const at = 'questions[' + i + ']';
        if (!isStr(q.id) || qids.has(q.id)) fail(F, at + '.id', 'пустой или повторяется');
        qids.add(q.id);
        if (!isStr(q.text)) fail(F, at + '.text', 'нужна строка');
        const tpl = q.templates || {};
        const src = q.source || {};
        if (src.rules) {
            src.rules.forEach(function (rule, j) {
                (rule.signals || []).forEach(function (s) { if (!hasSignal(s)) fail(F, at + '.source.rules[' + j + '].signals', 'нет сигнала «' + s + '»'); });
                if (!tpl[rule.use]) fail(F, at + '.source.rules[' + j + '].use', 'нет шаблона «' + rule.use + '»');
            });
        } else {
            if (!hasAxis(src.axis)) fail(F, at + '.source.axis', 'нет оси «' + src.axis + '»');
            ['0', '1', '2'].forEach(function (lv) { if (!tpl[lv]) fail(F, at + '.templates.' + lv, 'нет шаблона уровня'); });
        }
        if (q.override) {
            if (!hasAxis(q.override.axis)) fail(F, at + '.override.axis', 'нет оси «' + q.override.axis + '»');
            if (!tpl[q.override.use]) fail(F, at + '.override.use', 'нет шаблона «' + q.override.use + '»');
        }
        for (const k of Object.keys(tpl)) {
            if (!isStr(tpl[k].label) || !isStr(tpl[k].text)) fail(F, at + '.templates.' + k, 'нужны label и text');
        }
        if (!q.ask_seller || !isStr(q.ask_seller.text)) fail(F, at + '.ask_seller.text', 'нужна строка');
        (q.ask_seller.when || []).forEach(function (k) { if (!tpl[k]) fail(F, at + '.ask_seller.when', 'нет шаблона «' + k + '»'); });
    });
    if (!r.questions.some(function (q) { return q.default; })) fail(F, 'questions', 'ни один вопрос не выбран по умолчанию');
    if (!Array.isArray(r.seller_fallback)) fail(F, 'seller_fallback', 'нужен список строк');
}

function checkCopy(c, rubric, fail) {
    const F = 'copy.json';
    for (const key of REQUIRED_COPY) {
        const v = key.split('.').reduce(function (o, k) { return o === undefined || o === null ? undefined : o[k]; }, c);
        if (v === undefined || v === null || v === '') fail(F, key, 'нет ключа');
    }
    if (!Array.isArray(c.input.wait_lines) || !c.input.wait_lines.length) fail(F, 'input.wait_lines', 'нужен непустой список');
    if (!Array.isArray(c.unknowns)) fail(F, 'unknowns', 'нужен список');
    for (const t of rubric.types) {
        const s = c.types[t.key];
        if (!s || !isStr(s.title) || !isStr(s.line) || !isStr(s.check)) fail(F, 'types.' + t.key, 'нужны title, line и check');
    }
    for (const k of Object.keys(c.types)) {
        if (!rubric.types.some(function (t) { return t.key === k; })) fail(F, 'types.' + k, 'такого типа нет в rubric.types');
    }
    if (!Array.isArray(c.card.counters)) fail(F, 'card.counters', 'нужен список');
    c.card.counters.forEach(function (x, i) {
        if (!Object.prototype.hasOwnProperty.call(rubric.counts || {}, x.key)) fail(F, 'card.counters[' + i + '].key', 'нет счётчика «' + x.key + '» в rubric.counts');
        if (!Array.isArray(x.forms) || x.forms.length !== 3) fail(F, 'card.counters[' + i + '].forms', 'нужны три формы слова');
    });
}

// Публичная часть пакета для страницы. Весов, правил и промпта здесь
// нет: странице нужны только тексты, сценарии, жанры и вопросы.
export function publicPack(p) {
    return {
        id: p.id,
        version: p.version,
        title: p.title,
        language: p.language,
        evidence: { kind: p.evidence.kind },
        scenarios: p.scenarios,
        genres: p.genres.map(function (g) { return { id: g, label: p.rubric.genres[g].label }; }),
        questions: p.rubric.questions.map(function (q) { return { id: q.id, text: q.text, default: q.default }; }),
        copy: p.copy,
    };
}
