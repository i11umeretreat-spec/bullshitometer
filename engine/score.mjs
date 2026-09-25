// Подсчёт. Чистая функция: одинаковый вход всегда даёт одинаковый
// выход, без случайности, без часов и без сети. Всё знание о весах,
// порогах и типах лежит в rubric.json; здесь только его применение.
// Новый сигнал это строка в рубрике, а не новая ветка в этом файле.

function round(x, digits) {
    const p = Math.pow(10, digits);
    return Math.round(x * p) / p;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

// Шаг 1. Балл одной находки.
//   c = w · m_strength · Π m_modifier · m_genre
// Нет записи в рубрике — множитель 1.
function findingPoints(f, genre, rubric) {
    const sig = rubric.signals[f.signal];
    let c = sig.weight * (rubric.strength[String(f.strength)] || 1);
    for (const m of f.modifiers || []) c *= (rubric.modifiers[m] === undefined ? 1 : rubric.modifiers[m]);
    const g = rubric.genre[genre];
    if (g && g[f.signal] !== undefined) c *= g[f.signal];
    return c;
}

// Уровень оси: 0 низкий, 1 средний, 2 высокий.
function levelOf(v, levels) {
    if (v < levels[0]) return 0;
    if (v < levels[1]) return 1;
    return 2;
}

function confidenceOf(stats, dropShare, rubric) {
    const c = rubric.confidence;
    const labels = c.labels;
    let level;
    let reason;

    const textsWord = stats.n + ' ' + plural(stats.n, 'текст', 'текста', 'текстов');
    const sale = Math.round(stats.sale_share * stats.n);
    const saleTail = sale > 0 ? ', ' + sale + ' из них ' + plural(sale, 'продающий', 'продающие', 'продающие') : '';

    if (stats.n_eff < c.low_if.n_eff_lt) {
        level = 0;
        reason = stats.n_eff === stats.n
            ? textsWord + saleTail + '. Для выводов мало'
            : textsWord + ', но по-разному написанных только ' + stats.n_eff + '. Для выводов мало';
    } else if (stats.words < c.low_if.words_lt) {
        level = 0;
        reason = 'Всего ' + stats.words + ' ' + plural(stats.words, 'слово', 'слова', 'слов') + '. Для выводов мало';
    } else if (stats.n_eff >= c.high_if.n_eff_gte && stats.words >= c.high_if.words_gte && stats.sale_share <= c.high_if.sale_share_lte) {
        level = 2;
        reason = textsWord + ', ' + stats.words + ' ' + plural(stats.words, 'слово', 'слова', 'слов') + saleTail;
    } else {
        level = 1;
        reason = textsWord + saleTail;
        if (stats.n_eff < stats.n) reason += ', разных по сути ' + stats.n_eff;
    }

    if (dropShare > c.dropped_share_gt && level > 0) {
        level -= 1;
        reason += '. Часть цитат модели не нашлась в текстах';
    }

    return { level: level, label: labels[level], reason: reason };
}

// Условия типов из rubric.types. Незнакомый ключ условия — ошибка:
// опечатка в рубрике должна ронять тесты, а не тихо давать «ложь».
function evalCondition(cond, ctx) {
    const keys = Object.keys(cond);
    if (cond.always === true) return true;
    if (cond.all) return cond.all.every(function (c) { return evalCondition(c, ctx); });
    if (cond.any) return cond.any.some(function (c) { return evalCondition(c, ctx); });
    if (cond.confidence_lte !== undefined) return ctx.confidence <= cond.confidence_lte;
    if (cond.axis) {
        const lvl = ctx.levels[cond.axis];
        if (lvl === undefined) throw new Error('rubric.types: нет оси ' + cond.axis);
        if (cond.gte !== undefined) return lvl >= cond.gte;
        if (cond.lte !== undefined) return lvl <= cond.lte;
    }
    if (cond.signals) {
        let n = 0;
        for (const s of cond.signals) n += ctx.signalCounts[s] || 0;
        return n >= cond.count_gte;
    }
    throw new Error('rubric.types: непонятное условие ' + JSON.stringify(keys));
}

export function score(input) {
    const rubric = input.rubric;
    const scenario = input.scenario;
    const texts = input.texts_meta;
    const findings = input.findings || [];
    const dropped = input.dropped_quotes || 0;
    const rawFindings = input.raw_findings === undefined ? findings.length + dropped : input.raw_findings;

    const textIndex = new Map();
    texts.forEach(function (t, i) { textIndex.set(t.id, i); });
    const genreOf = new Map(texts.map(function (t) { return [t.id, t.genre]; }));

    // Находки с баллами, в каноническом порядке. Порядок входа на
    // результат не влияет: сортировка полная, до последнего поля.
    const scored = findings
        .filter(function (f) { return textIndex.has(f.text_id) && rubric.signals[f.signal]; })
        .map(function (f) {
            return {
                f: f,
                c: findingPoints(f, genreOf.get(f.text_id), rubric),
                axis: rubric.signals[f.signal].axis,
            };
        })
        .sort(function (a, b) {
            return (textIndex.get(a.f.text_id) - textIndex.get(b.f.text_id))
                || (Math.abs(b.c) - Math.abs(a.c))
                || cmp(a.f.signal, b.f.signal)
                || cmp(a.f.quote, b.f.quote)
                || cmp((a.f.modifiers || []).join(','), (b.f.modifiers || []).join(','));
        });

    // Шаг 2. Насыщение внутри текста:
    //   S = sign(w) · min( Σ |c_k| / k , cap · |w| )
    const cap = rubric.cap_per_signal_per_text;
    const perTextSignal = new Map(); // "textId|signal" -> [|c|...]
    for (const s of scored) {
        const k = s.f.text_id + '|' + s.f.signal;
        if (!perTextSignal.has(k)) perTextSignal.set(k, []);
        perTextSignal.get(k).push(Math.abs(s.c));
    }
    const S = new Map(); // textId -> { signal: S }
    for (const [k, list] of perTextSignal) {
        const [tid, sig] = k.split('|');
        const w = rubric.signals[sig].weight;
        list.sort(function (a, b) { return b - a; });
        let sum = 0;
        list.forEach(function (c, i) { sum += c / (i + 1); });
        const val = Math.sign(w) * Math.min(sum, cap * Math.abs(w));
        if (!S.has(tid)) S.set(tid, {});
        S.get(tid)[sig] = val;
    }

    // Шаг 3. Кластеры шаблонных текстов: балл кластера — среднее его текстов.
    const clusters = new Map(); // cluster -> [textId]
    for (const t of texts) {
        if (!clusters.has(t.cluster)) clusters.set(t.cluster, []);
        clusters.get(t.cluster).push(t.id);
    }
    const nEff = clusters.size;
    const clusterSignal = new Map(); // cluster -> { signal: mean S }
    for (const [cl, ids] of clusters) {
        const acc = {};
        for (const id of ids) {
            const row = S.get(id) || {};
            for (const sig of Object.keys(row)) acc[sig] = (acc[sig] || 0) + row[sig];
        }
        for (const sig of Object.keys(acc)) acc[sig] = acc[sig] / ids.length;
        clusterSignal.set(cl, acc);
    }

    // Шаг 4. Ось:
    //   raw = m_scenario · (1 / n_eff) · Σ_clusters Σ_signals∈axis S
    //   v   = 1 − e^(−max(raw, 0) / k)
    const scen = rubric.scenario[scenario] || {};
    const contrib = {}; // signal -> вклад в raw своей оси
    for (const acc of clusterSignal.values()) {
        for (const sig of Object.keys(acc)) contrib[sig] = (contrib[sig] || 0) + acc[sig];
    }
    const axisKeys = Object.keys(rubric.axes);
    const axisData = {};
    for (const key of axisKeys) {
        const m = scen[key] === undefined ? 1 : scen[key];
        const top = [];
        let raw = 0;
        for (const sig of Object.keys(contrib).sort()) {
            if (rubric.signals[sig].axis !== key) continue;
            const pts = nEff ? m * contrib[sig] / nEff : 0;
            raw += pts;
            if (pts !== 0) top.push({ signal: sig, label: rubric.signals[sig].label, points: pts });
        }
        top.sort(function (a, b) { return (Math.abs(b.points) - Math.abs(a.points)) || cmp(a.signal, b.signal); });
        const ax = rubric.axes[key];
        const v = 1 - Math.exp(-Math.max(raw, 0) / ax.k);
        const level = levelOf(v, rubric.levels);
        axisData[key] = {
            key: key,
            label: ax.label,
            polarity: ax.polarity,
            level: level,
            level_label: rubric.level_labels[level],
            v: round(v, 3),
            raw: round(raw, 2),
            multiplier: m,
            top: top.slice(0, 3).map(function (t) { return { signal: t.signal, label: t.label, points: round(t.points, 2) }; }),
        };
    }

    // Шаг 5. Уверенность, отдельно от осей.
    let words = 0;
    let sale = 0;
    for (const t of texts) {
        words += t.words;
        if (t.genre === 'sale') sale += 1;
    }
    const stats = {
        n: texts.length,
        n_eff: nEff,
        words: words,
        sale_share: texts.length ? round(sale / texts.length, 2) : 0,
        dropped_quotes: dropped,
    };
    const dropShare = rawFindings > 0 ? dropped / rawFindings : 0;
    const confidence = confidenceOf(stats, dropShare, rubric);

    // Шаг 6. Тип поля: первое сработавшее правило.
    const levels = {};
    for (const key of axisKeys) levels[key] = axisData[key].level;
    const signalCounts = {};
    for (const s of scored) signalCounts[s.f.signal] = (signalCounts[s.f.signal] || 0) + 1;
    const ctx = { levels: levels, confidence: confidence.level, signalCounts: signalCounts };
    const typeRule = rubric.types.find(function (t) { return evalCondition(t.when, ctx); });

    // Порядок осей задаёт сценарий.
    const order = (rubric.scenario_meta[scenario] && rubric.scenario_meta[scenario].order) || axisKeys;
    const axes = order.map(function (k) { return axisData[k]; });

    // Шаг 7. Адвокат автора, без модели. Сначала невинные объяснения
    // самых весомых находок тревожных осей, потом поправки на жанр
    // и копирку, и всегда в конце то, чего мы не видели.
    const advocate = [];
    for (const ax of axes) {
        if (ax.polarity !== 'neg' || ax.level < 1) continue;
        const best = scored
            .filter(function (s) { return s.axis === ax.key && s.f.alt_explanation; })
            .sort(function (a, b) { return (Math.abs(b.c) - Math.abs(a.c)) || (textIndex.get(a.f.text_id) - textIndex.get(b.f.text_id)) || cmp(a.f.quote, b.f.quote); })[0];
        if (best && advocate.indexOf(best.f.alt_explanation) === -1) advocate.push(best.f.alt_explanation);
    }
    if (stats.sale_share >= 0.5) advocate.push(rubric.advocate.sale_share);
    if (nEff < texts.length) advocate.push(rubric.advocate.templates);
    const advocateOut = advocate.slice(0, 4).concat([rubric.advocate.always]);

    // Шаг 8. Чего мы не знаем.
    const unknowns = rubric.unknowns.concat(['Уверенность ' + confidence.label + ': ' + confidence.reason]);

    // Счётчики карточки.
    const counts = {};
    for (const key of Object.keys(rubric.counts)) {
        counts[key] = scored.filter(function (s) { return rubric.counts[key].indexOf(s.f.signal) !== -1; }).length;
    }

    return {
        type: { key: typeRule.key, title: typeRule.title, line: typeRule.line, check: typeRule.check },
        confidence: confidence,
        axes: axes,
        findings: scored.map(function (s) {
            return {
                text_id: s.f.text_id,
                quote: s.f.quote,
                signal: s.f.signal,
                signal_label: rubric.signals[s.f.signal].label,
                axis: s.axis,
                axis_label: rubric.axes[s.axis].label,
                strength: s.f.strength,
                modifiers: s.f.modifiers || [],
                points: round(s.c, 2),
                context_note: s.f.context_note || '',
                alt_explanation: s.f.alt_explanation || '',
            };
        }),
        counts: counts,
        advocate: advocateOut,
        unknowns: unknowns,
        stats: stats,
    };
}
