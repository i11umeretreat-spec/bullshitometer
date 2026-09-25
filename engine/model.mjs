// Разметка через Claude API. Модель только размечает; оценку считает код.
//
// Запрос собран по правилам claude-sonnet-5, сверено с документацией
// перед написанием:
//   - temperature не отправляется. На этой модели параметры сэмплинга
//     убраны, любое значение кроме умолчания даёт 400. Воспроизводимость
//     держат кэш разметки и подсчёт в коде, а не температура;
//   - инструмент принудительный (tool_choice: tool) и строгий (strict):
//     ответ всегда валиден по схеме. На Claude API это работает вместе
//     с размышлением модели; только Bedrock требовал бы его выключить;
//   - в схеме нет minLength, maximum и подобного: строгий режим их
//     не принимает, эти границы проверяет verify.mjs.

export const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Размышление модели включено адаптивно, глубину задаёт effort.
// medium — компромисс между точностью разметки и временем: разбор
// должен укладываться в 20 секунд. Меняется переменной MODEL_EFFORT
// после замера через scripts/eval.mjs.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export function effortFrom(env) {
    return EFFORTS.indexOf(env.MODEL_EFFORT) !== -1 ? env.MODEL_EFFORT : 'medium';
}

// 12 находок на текст по сотне токенов плюс размышление. С запасом:
// обрезанный ответ инструмента не разбирается вовсе.
const MAX_TOKENS = 20000;

// Повтор только на то, что может пройти со второго раза.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export function buildSystem(rubric, template) {
    const lines = Object.keys(rubric.signals).map(function (key) {
        const s = rubric.signals[key];
        return '- `' + key + '` (' + rubric.axes[s.axis].label.toLowerCase() + '): ' + s.definition;
    });
    return template.replace('{{SIGNALS}}', lines.join('\n'));
}

export function toolSchema(rubric) {
    return {
        name: 'report_findings',
        description: 'Сообщить найденные в текстах риторические сигналы и шаблонность текстов.',
        strict: true,
        input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['findings', 'texts_meta'],
            properties: {
                findings: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['text_id', 'quote', 'signal', 'strength', 'modifiers', 'context_note', 'alt_explanation'],
                        properties: {
                            text_id: { type: 'string' },
                            quote: { type: 'string' },
                            signal: { type: 'string', enum: Object.keys(rubric.signals) },
                            strength: { type: 'integer', enum: [1, 2, 3] },
                            modifiers: { type: 'array', items: { type: 'string', enum: Object.keys(rubric.modifiers) } },
                            context_note: { type: 'string' },
                            alt_explanation: { type: 'string' },
                        },
                    },
                },
                texts_meta: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['text_id', 'template_like'],
                        properties: {
                            text_id: { type: 'string' },
                            template_like: { type: 'boolean' },
                        },
                    },
                },
            },
        },
    };
}

// Тексты в тегах. Закрывающий тег внутри самого текста обезврежен:
// иначе текст мог бы «закрыть» себя и дописать инструкцию снаружи.
export function textsXml(batch) {
    return batch.map(function (t) {
        const safe = t.text.replace(/<(\/?)text/gi, '‹$1text');
        return '<text id="' + t.id + '" genre="' + t.genre + '">\n' + safe + '\n</text>';
    }).join('\n\n');
}

export function buildRequest(batch, rubric, system, effort) {
    return {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: effort },
        // Промпт с сигналами одинаков для всех вызовов: кэшируем его
        // на стороне API, платим за него один раз за пять минут.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: [toolSchema(rubric)],
        tool_choice: { type: 'tool', name: 'report_findings' },
        messages: [{ role: 'user', content: textsXml(batch) }],
    };
}

// Один вызов с одним повтором через 2 секунды. onAttempt вызывается
// перед каждой попыткой: из него считается бюджет, потому что каждая
// попытка может стоить денег.
export async function callModel(deps) {
    let last = { ok: false, status: 0, kind: 'network' };

    for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1) await deps.sleep(2000);
        await deps.onAttempt();

        let res;
        try {
            res = await deps.fetch(API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': deps.apiKey,
                    'anthropic-version': API_VERSION,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(deps.body),
            });
        } catch (e) {
            last = { ok: false, status: 0, kind: 'network' };
            continue;
        }

        let json = null;
        try { json = await res.json(); } catch (e) { json = null; }

        if (!res.ok) {
            last = { ok: false, status: res.status, kind: (json && json.error && json.error.type) || 'http' };
            if (RETRYABLE.has(res.status)) continue;
            return last;
        }

        if (!json || json.stop_reason === 'refusal') return { ok: false, status: 200, kind: 'refusal' };
        if (json.stop_reason === 'max_tokens') return { ok: false, status: 200, kind: 'max_tokens' };

        const block = (json.content || []).find(function (b) {
            return b.type === 'tool_use' && b.name === 'report_findings';
        });
        if (!block || !block.input) return { ok: false, status: 200, kind: 'no_tool_use' };

        return { ok: true, input: block.input };
    }

    return last;
}
