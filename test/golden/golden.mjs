// Снимки движка: подсчёт, тип, ответы и вопросы продавцу для всех
// фикстур, через весь путь сервера (лимиты, разметка подставной
// моделью по ключевым словам, проверка цитат, подсчёт, ответы).
// Снимки записаны до переезда в доменные пакеты и сравниваются
// после: любое расхождение — ошибка переезда, а не улучшение.
//
// Перезаписать (только осознанно, отдельным коммитом):
//   node test/golden/golden.mjs --write

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makeHarness, runAnalysis, keywordModel } from '../helpers.mjs';

const FIXTURES = new URL('../../fixtures/', import.meta.url);
const GOLDEN = new URL('./', import.meta.url);
// Второй выбор вопросов проверяет порядок вопросов продавцу.
export const SELECTIONS = { default: undefined, reversed: ['q_fail', 'q_after', 'q_cost', 'q_check', 'q_fit', 'q_promise', 'q_now'] };

export function fixtureNames() {
    return readdirSync(FIXTURES).filter(function (f) { return f.endsWith('.json'); }).map(function (f) { return f.slice(0, -5); }).sort();
}

export async function snapshot(name) {
    const fx = JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'));
    const out = {};
    for (const key of Object.keys(SELECTIONS)) {
        const h = makeHarness({ model: keywordModel });
        const body = {
            scenario: fx.scenario,
            texts: fx.texts.map(function (t, i) { return { id: 't' + (i + 1), genre: t.genre, text: t.text.split('{{NAME}}').join(fx.author) }; }),
        };
        if (SELECTIONS[key]) body.questions = SELECTIONS[key];
        const res = await runAnalysis(h, body);
        if (res.status !== 200) throw new Error(name + ': статус ' + res.status);
        const r = await res.json();
        // Версии меняются при каждой правке рубрики и не относятся
        // к выходу движка.
        delete r.versions;
        out[key] = r;
    }
    return out;
}

export function goldenPath(name) { return new URL(name + '.json', GOLDEN); }

if (process.argv.indexOf('--write') !== -1) {
    for (const name of fixtureNames()) {
        writeFileSync(goldenPath(name), JSON.stringify(await snapshot(name), null, 2) + '\n');
        console.log('записан', name);
    }
}
