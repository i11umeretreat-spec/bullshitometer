// Ответы на вопросы до оплаты. Чистая функция поверх уже посчитанного
// результата: уровни осей, находки, уверенность. Модель здесь не
// участвует, веса и пороги не меняются. Тексты вопросов, шаблонов и
// вопросов продавцу лежат в rubric.questions, здесь только правила
// выбора шаблона и подтверждений.
//
// Правило честности: ответ ссылается только на находки из findings,
// и если подходящих находок нет, шаблон берётся нижний, а не тот,
// который утверждал бы то, чего в текстах не нашлось.

const MAX_EVIDENCE = 3;
const MAX_SELLER = 5;
const MIN_SELLER = 3;

// Выбор вопросов со страницы. Нет выбора — вопросы по умолчанию из
// рубрики: так старые клиенты и прямые вызовы API получают осмысленный
// порядок вопросов продавцу.
export function normalizeSelection(value, rubric) {
    const known = rubric.questions.map(function (q) { return q.id; });
    if (value === undefined || value === null) {
        return { ok: true, ids: rubric.questions.filter(function (q) { return q.default; }).map(function (q) { return q.id; }) };
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > known.length) return { ok: false, reason: 'выбери от одного до семи вопросов' };
    const seen = new Set();
    for (const id of value) {
        if (typeof id !== 'string' || known.indexOf(id) === -1) return { ok: false, reason: 'неизвестный вопрос' };
        if (seen.has(id)) return { ok: false, reason: 'вопросы повторяются' };
        seen.add(id);
    }
    return { ok: true, ids: value.slice() };
}

// Индексы находок, отобранных условием, от самой весомой к лёгкой.
// При равных баллах раньше та, что раньше в списке: порядок findings
// уже детерминирован подсчётом.
function pick(findings, keep) {
    const idx = [];
    findings.forEach(function (f, i) { if (keep(f)) idx.push(i); });
    idx.sort(function (a, b) { return (Math.abs(findings[b].points) - Math.abs(findings[a].points)) || (a - b); });
    return idx;
}

// Подтверждения для шаблона оси. Для тревожной оси любой уровень
// подтверждают её находки. Для хорошей высокий и средний уровень
// подтверждают находки с плюсом, а низкий — с минусом: «источник без
// имени» не может подтверждать «есть на что опереться».
function axisEvidence(findings, axis, polarity, level) {
    if (polarity === 'pos' && level === 0) return pick(findings, function (f) { return f.axis === axis && f.points < 0; });
    return pick(findings, function (f) { return f.axis === axis && f.points > 0; });
}

function choose(q, result, levels, polarity) {
    const findings = result.findings;

    if (q.source.rules) {
        for (const rule of q.source.rules) {
            const idx = pick(findings, function (f) { return rule.signals.indexOf(f.signal) !== -1; });
            if (idx.length > 0 || rule.signals.length === 0) {
                const t = q.templates[rule.use];
                return { key: rule.use, level: t.level, alarm: t.alarm, idx: idx };
            }
        }
    }

    const o = q.override;
    if (o && levels[o.axis] >= o.gte) {
        const idx = pick(findings, function (f) { return f.axis === o.axis && f.points > 0; });
        if (idx.length > 0) {
            const t = q.templates[o.use];
            return { key: o.use, level: t.level, alarm: t.alarm, idx: idx };
        }
    }

    const axis = q.source.axis;
    const pol = polarity[axis];
    let level = levels[axis] || 0;
    let idx = axisEvidence(findings, axis, pol, level);
    // Уровень есть, а подтвердить нечем: нижний шаблон, а не выдумка.
    if (level > 0 && idx.length === 0) {
        level = 0;
        idx = axisEvidence(findings, axis, pol, 0);
    }
    return { key: String(level), level: level, alarm: pol === 'neg' ? level : 2 - level, idx: idx };
}

export function answers(result, rubric, selected) {
    const levels = {};
    const polarity = {};
    for (const a of result.axes) { levels[a.key] = a.level; polarity[a.key] = a.polarity; }
    const preliminary = result.confidence.level === 0;

    const list = rubric.questions.map(function (q) {
        const c = choose(q, result, levels, polarity);
        const t = q.templates[c.key];
        const asks = q.ask_seller.when.indexOf(c.key) !== -1;
        return {
            id: q.id,
            question: q.text,
            template: c.key,
            level: c.level,
            alarm: c.alarm,
            level_word: t.label,
            text: t.text.split('{n}').join(String(c.idx.length)),
            count: c.idx.length,
            evidence: c.idx.slice(0, MAX_EVIDENCE).map(function (i) { return 'f' + i; }),
            ask_seller: asks ? q.ask_seller.text : null,
            preliminary: preliminary,
        };
    });

    // Вопросы продавцу: сначала от выбранных, потом от остальных,
    // внутри каждой группы по тревожности. Потом добивка общими.
    const sel = normalizeSelection(selected, rubric).ids || [];
    const rank = function (a) { const i = sel.indexOf(a.id); return i === -1 ? 1 : 0; };
    const order = list.map(function (a, i) { return { a: a, i: i }; })
        .filter(function (x) { return x.a.ask_seller; })
        .sort(function (x, y) {
            return (rank(x.a) - rank(y.a)) || (y.a.alarm - x.a.alarm) ||
                ((rank(x.a) === 0 ? sel.indexOf(x.a.id) - sel.indexOf(y.a.id) : 0)) || (x.i - y.i);
        });
    const seller = [];
    for (const x of order) {
        if (seller.length >= MAX_SELLER) break;
        if (seller.indexOf(x.a.ask_seller) === -1) seller.push(x.a.ask_seller);
    }
    for (const q of rubric.seller_fallback) {
        if (seller.length >= MIN_SELLER) break;
        if (seller.indexOf(q) === -1) seller.push(q);
    }

    // «Что говорит в пользу»: находки хороших осей с плюсом.
    const good = pick(result.findings, function (f) { return polarity[f.axis] === 'pos' && f.points > 0; });

    return {
        answers: list,
        seller_questions: seller,
        in_favor: good.slice(0, MAX_EVIDENCE).map(function (i) { return 'f' + i; }),
    };
}
