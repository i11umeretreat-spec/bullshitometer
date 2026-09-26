// Запретные слова. Продукт разбирает тексты, а не людей, и эти слова
// превращают разбор в обвинение. Проверяется всё, что может увидеть
// человек: страница, строки типов и адвоката из рубрики.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPack } from '../engine/packs.mjs';

const pack = loadPack('courses');
const rubric = pack.rubric;
const copy = pack.copy;
const banned = rubric.banned_words;

function findBanned(text) {
    const low = text.toLowerCase().replace(/ё/g, 'е');
    return banned.filter(function (w) { return low.indexOf(w.replace(/ё/g, 'е')) !== -1; });
}

test('список запретных слов не пустой', () => {
    assert.ok(banned.length >= 9);
});

test('index.html: ни одного запретного слова', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.deepEqual(findBanned(html), []);
});

test('строки типов, адвоката и «чего мы не знаем» из рубрики: ни одного запретного слова', () => {
    const visible = [];
    // Все строки copy.json пакета: типы, адвокат, «чего мы не знаем»,
    // строки входа и результата.
    (function walk(x) {
        if (typeof x === 'string') visible.push(x);
        else if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') Object.keys(x).forEach(function (k) { walk(x[k]); });
    })(copy);
    for (const s of Object.values(rubric.signals)) visible.push(s.label);
    for (const a of Object.values(rubric.axes)) visible.push(a.label);
    assert.deepEqual(findBanned(visible.join('\n')), []);
});

test('промпт разметки тоже чистый: модель не должна подхватить эти слова', () => {
    const prompt = readFileSync(new URL('../packs/courses/prompt.md', import.meta.url), 'utf8');
    assert.deepEqual(findBanned(prompt), []);
});

test('в интерфейсе нет поля для имени, ника или ссылки на автора', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').toLowerCase();
    for (const bad of ['name="author', 'id="author', 'placeholder="имя', 'placeholder="ник', 'type="url"']) {
        assert.ok(html.indexOf(bad) === -1, bad);
    }
});

test('вопросы, ответы и вопросы продавцу из рубрики: без запретных слов, длинных тире и чужих подстановок', () => {
    const visible = rubric.seller_fallback.slice();
    for (const q of rubric.questions) {
        visible.push(q.text, q.ask_seller.text);
        for (const k of Object.keys(q.templates)) visible.push(q.templates[k].label, q.templates[k].text);
    }
    const all = visible.join('\n');
    assert.deepEqual(findBanned(all), []);
    assert.equal(all.indexOf('—'), -1, 'длинное тире');
    const subs = all.match(/\{[^}]*\}/g) || [];
    assert.deepEqual(subs.filter(function (x) { return x !== '{n}'; }), [], 'подстановки, кроме {n}');
});

test('вопросы продавцу звучат как вопросы: заканчиваются знаком вопроса', () => {
    const asks = rubric.questions.map(function (q) { return q.ask_seller.text; }).concat(rubric.seller_fallback);
    for (const a of asks) assert.match(a, /\?$/, a);
});

test('копия вопросов на странице совпадает с рубрикой: id, тексты, выбор по умолчанию, вступление', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const m = html.match(/<script type="application\/json" id="questions-data">([\s\S]*?)<\/script>/);
    assert.ok(m, 'нет блока questions-data');
    const data = JSON.parse(m[1]);
    assert.equal(data.intro, copy.result.seller_intro);
    assert.deepEqual(data.questions, rubric.questions.map(function (q) { return { id: q.id, text: q.text, default: q.default }; }));
});
