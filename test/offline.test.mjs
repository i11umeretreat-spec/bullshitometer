// scripts/offline.mjs: промпт для чата и подсчёт по готовой разметке.
// Сеть не нужна, модель не вызывается.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/offline.mjs', import.meta.url).pathname;
const fixture = new URL('../fixtures/black_hole_1.json', import.meta.url).pathname;

test('prompt: сигналы из рубрики, схема ответа и все тексты в тегах', () => {
    const out = execFileSync('node', [script, 'prompt', fixture], { encoding: 'utf8' });
    assert.match(out, /`forbid_others`/);
    assert.match(out, /"template_like"/);
    const n = JSON.parse(readFileSync(fixture, 'utf8')).texts.length;
    const texts = out.slice(out.lastIndexOf('## Тексты'));
    assert.equal((texts.match(/<text id="t\d+"/g) || []).length, n);
    assert.doesNotMatch(out, /\{\{NAME\}\}/);
});

test('score: ответ чата в обрамлении ```json, выдуманная цитата выброшена', () => {
    const fx = JSON.parse(readFileSync(fixture, 'utf8'));
    const real = fx.texts[1].text.slice(0, 40);
    const markup = {
        findings: [
            { text_id: 't2', quote: real, signal: 'only_me', strength: 2, modifiers: [], context_note: '', alt_explanation: 'отбор' },
            { text_id: 't2', quote: 'такой фразы нет', signal: 'dependency', strength: 2, modifiers: [], context_note: '', alt_explanation: '-' },
        ],
        texts_meta: [],
    };
    const dir = mkdtempSync(join(tmpdir(), 'bsm-'));
    const file = join(dir, 'markup.json');
    writeFileSync(file, 'Вот:\n```json\n' + JSON.stringify(markup) + '\n```\n');

    const res = JSON.parse(execFileSync('node', [script, 'score', fixture, file, '--json'], { encoding: 'utf8' }));
    assert.equal(res.stats.dropped_quotes, 1);
    assert.equal(res.findings.length, 1);
    assert.equal(res.findings[0].signal, 'only_me');
    assert.ok(res.type && res.type.key);
});

test('без аргументов: подсказка и код 2', () => {
    const r = spawnSync('node', [script], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /offline\.mjs prompt/);
});
