// Фикстуры: форма и объём. Качество по ним меряет scripts/eval.mjs
// через живую модель, а здесь проверяется, что сами фикстуры годятся
// для этой проверки: проходят лимиты входа, тип ожидания существует,
// и у «Тёмной материи» объём действительно мал, а у остальных нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { loadPack } from '../engine/packs.mjs';
import { validateAnalyzeBody } from '../engine/limits.mjs';
import { countWords } from '../engine/verify.mjs';

const pack = loadPack('courses');
const rubric = pack.rubric;
const copy = pack.copy;
const dir = new URL('../fixtures/', import.meta.url);
const files = readdirSync(dir).filter(function (f) { return f.endsWith('.json'); }).sort();
const fixtures = files.map(function (f) { return JSON.parse(readFileSync(new URL(f, dir), 'utf8')); });

function words(fx) {
    return fx.texts.reduce(function (s, t) { return s + countWords(t.text); }, 0);
}

test('14 фикстур, по две на каждый тип', () => {
    assert.equal(fixtures.length, 14);
    for (const t of rubric.types) {
        const n = fixtures.filter(function (fx) { return fx.expected === t.key; }).length;
        assert.equal(n, 2, t.key);
    }
});

test('имя файла совпадает с name, поля на месте', () => {
    fixtures.forEach(function (fx, i) {
        assert.equal(fx.name + '.json', files[i]);
        assert.equal(typeof fx.author, 'string');
        assert.equal(typeof fx.note, 'string');
        assert.ok(fx.author.length > 0 && fx.note.length > 0);
    });
});

test('каждая фикстура проходит лимиты входа', () => {
    for (const fx of fixtures) {
        const body = {
            scenario: fx.scenario,
            texts: fx.texts.map(function (t, i) { return { id: 't' + (i + 1), genre: t.genre, text: t.text }; }),
        };
        const r = validateAnalyzeBody(body, rubric);
        assert.equal(r.ok, true, fx.name + ': ' + r.reason);
    }
});

test('в каждом тексте есть подпись {{NAME}} для проверки подменой имени', () => {
    for (const fx of fixtures) {
        for (const t of fx.texts) assert.ok(t.text.indexOf('{{NAME}}') !== -1, fx.name);
    }
});

test('кроме «Тёмной материи»: от 6 до 10 текстов, от 800 слов, не меньше трёх жанров', () => {
    for (const fx of fixtures) {
        if (fx.expected === 'dark_matter') continue;
        assert.ok(fx.texts.length >= 6 && fx.texts.length <= 10, fx.name + ': ' + fx.texts.length);
        assert.ok(words(fx) >= rubric.confidence.low_if.words_lt, fx.name + ': ' + words(fx));
        const genres = new Set(fx.texts.map(function (t) { return t.genre; }));
        assert.ok(genres.size >= 3, fx.name);
    }
});

test('«Тёмная материя»: слов меньше порога низкой уверенности', () => {
    for (const fx of fixtures) {
        if (fx.expected !== 'dark_matter') continue;
        assert.ok(words(fx) < rubric.confidence.low_if.words_lt, fx.name);
    }
});

test('тексты внутри фикстуры не повторяются дословно', () => {
    for (const fx of fixtures) {
        const seen = new Set(fx.texts.map(function (t) { return t.text; }));
        assert.equal(seen.size, fx.texts.length, fx.name);
    }
});
