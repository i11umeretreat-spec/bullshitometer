// Нормализация текста, проверка цитат, пачки и шаблонные тексты.
//
// Модель размечает, код проверяет. Находка остаётся, только если её
// цитата дословно есть в тексте, на который она ссылается. Иначе
// разбор держался бы на том, что модель додумала.

const QUOTES = /[«»„“”‟"'‘’‚‛`´]/g;
const DASHES = /[‐-―−⸺⸻﹘﹣－-]/g;
const INVISIBLE = /[­​-‏⁠﻿]/g;

export function normalize(s) {
    return String(s)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(QUOTES, '"')
        .replace(DASHES, '-')
        .replace(INVISIBLE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function countWords(s) {
    const m = String(s).match(/[\p{L}\p{N}]+/gu);
    return m ? m.length : 0;
}

// Пачки по целым текстам: текст не режется посередине, иначе цитата
// на стыке не нашлась бы ни в одной половине. Текст длиннее лимита
// идёт отдельной пачкой.
export function splitBatches(texts, maxChars) {
    const batches = [];
    let cur = [];
    let size = 0;
    for (const t of texts) {
        if (cur.length && size + t.text.length > maxChars) {
            batches.push(cur);
            cur = [];
            size = 0;
        }
        cur.push(t);
        size += t.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
}

const MAX_FINDINGS_PER_TEXT = 12;
const MAX_NOTE = 300;

// Возвращает оставленные находки и сколько выброшено. Выброшенные
// бывают двух сортов, и считаются они по-разному:
//   dropped  - цитаты нет в тексте, чужой текст, сигнал не из рубрики,
//              сила вне 1-3; это ошибки модели, они бьют по уверенности;
//   дубли и сверх 12 на текст просто не берутся, модель не ошиблась.
export function verifyFindings(findings, texts, rubric) {
    const byId = new Map();
    for (const t of texts) byId.set(t.id, normalize(t.text));

    const kept = [];
    const seen = new Set();
    let dropped = 0;

    for (const f of Array.isArray(findings) ? findings : []) {
        const valid = f && typeof f === 'object'
            && byId.has(f.text_id)
            && Object.prototype.hasOwnProperty.call(rubric.signals, f.signal)
            && (f.strength === 1 || f.strength === 2 || f.strength === 3)
            && typeof f.quote === 'string'
            && normalize(f.quote).length > 0
            && byId.get(f.text_id).indexOf(normalize(f.quote)) !== -1;

        if (!valid) {
            dropped += 1;
            continue;
        }

        const dedupKey = f.text_id + '|' + f.signal + '|' + normalize(f.quote);
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        kept.push({
            text_id: f.text_id,
            quote: f.quote.trim(),
            signal: f.signal,
            strength: f.strength,
            modifiers: (Array.isArray(f.modifiers) ? f.modifiers : [])
                .filter(function (m) { return Object.prototype.hasOwnProperty.call(rubric.modifiers, m); })
                .filter(function (m, i, arr) { return arr.indexOf(m) === i; })
                .sort(),
            context_note: String(f.context_note || '').slice(0, MAX_NOTE),
            alt_explanation: String(f.alt_explanation || '').slice(0, MAX_NOTE),
        });
    }

    // Не больше 12 находок на текст, в приоритете самые сильные.
    // Порядок внутри текста детерминирован, иначе одинаковая разметка
    // в разном порядке давала бы разный набор.
    const perText = new Map();
    for (const f of kept) {
        if (!perText.has(f.text_id)) perText.set(f.text_id, []);
        perText.get(f.text_id).push(f);
    }
    const out = [];
    for (const t of texts) {
        const list = (perText.get(t.id) || []).sort(function (a, b) {
            return (b.strength - a.strength)
                || (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0)
                || (a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0);
        });
        for (const f of list.slice(0, MAX_FINDINGS_PER_TEXT)) out.push(f);
    }

    return { kept: out, dropped: dropped, raw: Array.isArray(findings) ? findings.length : 0 };
}

// ── Шаблонные тексты ────────────────────────────────────────────────

function shingles(text, n) {
    const words = normalize(text).match(/[\p{L}\p{N}]+/gu) || [];
    const out = new Set();
    if (words.length < n) {
        if (words.length) out.add(words.join(' '));
        return out;
    }
    for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
    return out;
}

function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

// Метаданные текстов, которые нужны подсчёту: жанр, число слов и номер
// кластера. Сами тексты дальше не идут и в кэш не пишутся.
//
// Кластер: тексты с похожими словесными 5-граммами (Жаккар от порога
// рубрики) и все, что модель пометила как шаблонные. Кластеры нумеруются
// по первому появлению, поэтому номер не зависит от порядка сравнения.
export function buildTextsMeta(texts, templateLikeIds, rubric) {
    const n = texts.length;
    const parent = texts.map(function (_, i) { return i; });
    function root(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function join(a, b) { const ra = root(a), rb = root(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }

    const sh = texts.map(function (t) { return shingles(t.text, 5); });
    const threshold = rubric.template_jaccard;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (jaccard(sh[i], sh[j]) >= threshold) join(i, j);
        }
    }

    const tpl = new Set(templateLikeIds || []);
    let firstTpl = -1;
    texts.forEach(function (t, i) {
        if (!tpl.has(t.id)) return;
        if (firstTpl === -1) firstTpl = i;
        else join(firstTpl, i);
    });

    const numbers = new Map();
    return texts.map(function (t, i) {
        const r = root(i);
        if (!numbers.has(r)) numbers.set(r, numbers.size);
        return { id: t.id, genre: t.genre, words: countWords(t.text), cluster: numbers.get(r) };
    });
}
