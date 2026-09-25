import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, splitBatches, countWords } from '../engine/verify.mjs';

test('нормализация: регистр, ё, кавычки, тире, невидимые символы, пробелы', () => {
    assert.equal(normalize('  «Ёлка» — “это”​   Всё  '), '"елка" - "это" все');
    assert.equal(normalize('ﬁ'), 'fi', 'NFKC');
});

test('пачки: целые тексты, каждая не больше лимита, порядок сохранён', () => {
    const texts = [
        { id: 'a', genre: 'post', text: 'x'.repeat(7000) },
        { id: 'b', genre: 'post', text: 'x'.repeat(7000) },
        { id: 'c', genre: 'post', text: 'x'.repeat(3000) },
    ];
    const batches = splitBatches(texts, 12000);
    assert.deepEqual(batches.map(function (b) { return b.map(function (t) { return t.id; }); }), [['a'], ['b', 'c']]);
});

test('слова считаются по буквенным словам', () => {
    assert.equal(countWords('Раз, два — три! 4 пять'), 5);
});
