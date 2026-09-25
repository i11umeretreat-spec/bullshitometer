// Рубрика и промпт читаются с диска.
//
// После сборки функции файл лежит не там, где лежал в репозитории:
// esbuild кладёт бандл в корень функции, а included_files из
// netlify.toml раскладывает эти два файла относительно корня проекта.
// Поэтому путь ищется среди нескольких кандидатов, и если не найден
// ни один, падаем с понятной причиной, а не с ENOENT на полпути.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function find(rel) {
    const candidates = [
        path.join(HERE, '..', rel),
        path.join(process.cwd(), rel),
        path.join('/var/task', rel),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    throw new Error('не найден ' + rel + ' (проверь included_files в netlify.toml)');
}

let rubricCache = null;
let promptCache = null;

export function loadRubric() {
    if (!rubricCache) rubricCache = JSON.parse(readFileSync(find('engine/rubric.json'), 'utf8'));
    return rubricCache;
}

// Первая строка файла: «prompt-version: N». Версия входит в ключ
// кэша, поэтому правка промпта без смены версии оставила бы старые
// разметки жить ещё 30 дней.
export function loadPrompt() {
    if (!promptCache) {
        const raw = readFileSync(find('prompts/extract.md'), 'utf8');
        const first = raw.split('\n', 1)[0];
        const m = /^prompt-version:\s*(\S+)/.exec(first);
        if (!m) throw new Error('prompts/extract.md: первая строка должна быть «prompt-version: N»');
        promptCache = { version: m[1], template: raw.slice(first.length + 1).trim() };
    }
    return promptCache;
}
