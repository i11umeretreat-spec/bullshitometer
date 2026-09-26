// Проверка прибора без API: разметку делает Claude в обычном чате
// (в рамках подписки), а подсчёт идёт тем же движком, что на сайте.
//
//   node scripts/offline.mjs prompt fixtures/black_hole_1.json > prompt.txt
//     → вставить prompt.txt в чат Claude, ответ сохранить в markup.json
//   node scripts/offline.mjs score fixtures/black_hole_1.json markup.json
//     → тип, уверенность, оси, выброшенные цитаты
//
// Вход — файл в формате фикстуры: { "scenario": "course",
// "texts": [{ "genre": "post", "text": "…" }], "author": "…" }.
// {{NAME}} в текстах заменяется на author. Свои тексты можно положить
// в такой же файл рядом, в репозиторий их класть не нужно.
//
// Ответ чата можно сохранять как есть: обрамление ```json и текст
// вокруг объекта отрезаются. Цитаты проверяются так же строго, как на
// сайте: чего нет в тексте дословно, то выбрасывается.

import { readFileSync } from 'node:fs';
import { loadPack } from '../engine/packs.mjs';
import { buildSystem, textsXml, toolSchema } from '../engine/model.mjs';
import { verifyFindings, buildTextsMeta } from '../engine/verify.mjs';
import { score } from '../engine/score.mjs';
import { validateAnalyzeBody } from '../engine/limits.mjs';

function usage() {
    console.error('node scripts/offline.mjs prompt <вход.json>');
    console.error('node scripts/offline.mjs score <вход.json> <разметка.json> [--json]');
    return 2;
}

function loadInput(path, rubric) {
    const fx = JSON.parse(readFileSync(path, 'utf8'));
    const name = fx.author || 'Автор';
    const body = {
        scenario: fx.scenario,
        texts: fx.texts.map(function (t, i) {
            return { id: 't' + (i + 1), genre: t.genre, text: t.text.split('{{NAME}}').join(name) };
        }),
    };
    // Те же лимиты, что на сайте: иначе офлайн можно проверить то,
    // что живая страница не примет.
    const checked = validateAnalyzeBody(body, rubric);
    if (!checked.ok) throw new Error('вход не проходит лимиты сайта: ' + checked.reason);
    return checked.input;
}

function extractJson(raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('в файле разметки нет JSON-объекта');
    return JSON.parse(raw.slice(start, end + 1));
}

function promptFor(input, rubric) {
    const system = buildSystem(rubric, loadPack('courses').prompt.template);
    const schema = toolSchema(rubric).input_schema;
    return [
        system,
        '',
        '## Как ответить в этом чате',
        '',
        'Инструмента report_findings здесь нет. Верни то, что передал бы в него: один JSON-объект строго по схеме ниже, в блоке ```json и без текста вокруг.',
        '',
        '```json',
        JSON.stringify(schema, null, 2),
        '```',
        '',
        '## Тексты',
        '',
        textsXml(input.texts),
    ].join('\n');
}

function report(result, checked) {
    const lines = [];
    lines.push('Тип: ' + result.type.title + '. ' + result.type.line);
    lines.push('Уверенность: ' + result.confidence.label + '. ' + result.confidence.reason);
    lines.push('');
    for (const a of result.axes) {
        const top = a.top.map(function (t) { return t.label + ' ' + t.points; }).join(', ');
        lines.push('  ' + a.label.padEnd(18) + a.level_label.padEnd(10) + 'v=' + a.v + (top ? '  ' + top : ''));
    }
    lines.push('');
    lines.push('Находок принято: ' + checked.kept.length + ', выброшено (нет в тексте или чужой сигнал): ' + checked.dropped);
    lines.push('Текстов ' + result.stats.n + ', разных по сути ' + result.stats.n_eff + ', слов ' + result.stats.words);
    return lines.join('\n');
}

function main(argv) {
    const mode = argv[0];
    const pack = loadPack('courses');
    const rubric = pack.rubric;

    if (mode === 'prompt' && argv[1]) {
        process.stdout.write(promptFor(loadInput(argv[1], rubric), rubric) + '\n');
        return 0;
    }

    if (mode === 'score' && argv[1] && argv[2]) {
        const input = loadInput(argv[1], rubric);
        const markup = extractJson(readFileSync(argv[2], 'utf8'));
        const findings = Array.isArray(markup.findings) ? markup.findings : [];
        const templateLike = (Array.isArray(markup.texts_meta) ? markup.texts_meta : [])
            .filter(function (m) { return m && m.template_like === true; })
            .map(function (m) { return m.text_id; });

        const checked = verifyFindings(findings, input.texts, rubric);
        const result = score({
            findings: checked.kept,
            texts_meta: buildTextsMeta(input.texts, templateLike, rubric),
            scenario: input.scenario,
            rubric: rubric,
            copy: pack.copy,
            dropped_quotes: checked.dropped,
            raw_findings: checked.raw,
        });

        if (argv.indexOf('--json') !== -1) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        else process.stdout.write(report(result, checked) + '\n');
        return 0;
    }

    return usage();
}

try {
    process.exitCode = main(process.argv.slice(2));
} catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
