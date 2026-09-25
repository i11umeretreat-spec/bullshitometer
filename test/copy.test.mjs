// Запретные слова. Продукт разбирает тексты, а не людей, и эти слова
// превращают разбор в обвинение. Проверяется всё, что может увидеть
// человек: страница, строки типов и адвоката из рубрики.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRubric } from '../engine/assets.mjs';

const rubric = loadRubric();
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
    for (const t of rubric.types) visible.push(t.title, t.line, t.check);
    for (const k of Object.keys(rubric.advocate)) visible.push(rubric.advocate[k]);
    for (const u of rubric.unknowns) visible.push(u);
    for (const s of Object.values(rubric.signals)) visible.push(s.label);
    for (const a of Object.values(rubric.axes)) visible.push(a.label);
    assert.deepEqual(findBanned(visible.join('\n')), []);
});

test('промпт разметки тоже чистый: модель не должна подхватить эти слова', () => {
    const prompt = readFileSync(new URL('../prompts/extract.md', import.meta.url), 'utf8');
    assert.deepEqual(findBanned(prompt), []);
});

test('в интерфейсе нет поля для имени, ника или ссылки на автора', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').toLowerCase();
    for (const bad of ['name="author', 'id="author', 'placeholder="имя', 'placeholder="ник', 'type="url"']) {
        assert.ok(html.indexOf(bad) === -1, bad);
    }
});
