// Лимиты входа и частоты. Всё, что стоит денег, отсекается здесь,
// до обращения к модели.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const LIMITS = {
    MAX_TEXTS: 30,
    MAX_TEXT_CHARS: 20000,
    MIN_TOTAL_CHARS: 300,
    MAX_TOTAL_CHARS: 40000,
    // Спека ставила 60 КБ, но 40 000 кириллических знаков в UTF-8 весят
    // около 80 КБ, а в JSON ещё и экранирование. С 60 КБ разрешённый
    // объём отбивался бы раньше, чем до него дойдёт проверка знаков.
    MAX_BODY_BYTES: 100000,
    MAX_ID: 20,
};

export function httpError(status, reason) {
    return { ok: false, status: status, reason: reason };
}

export function validateAnalyzeBody(body, rubric) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return httpError(400, 'тело запроса не объект');

    if (!Object.prototype.hasOwnProperty.call(rubric.scenario, body.scenario)) {
        return httpError(400, 'неизвестный сценарий');
    }

    const texts = body.texts;
    if (!Array.isArray(texts) || texts.length === 0) return httpError(400, 'нет текстов');
    if (texts.length > LIMITS.MAX_TEXTS) return httpError(400, 'текстов больше ' + LIMITS.MAX_TEXTS);

    const ids = new Set();
    let total = 0;
    const clean = [];

    for (const t of texts) {
        if (!t || typeof t !== 'object') return httpError(400, 'текст не объект');
        if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t.id) || t.id.length > LIMITS.MAX_ID) {
            return httpError(400, 'плохой id текста');
        }
        if (ids.has(t.id)) return httpError(400, 'id текстов повторяются');
        ids.add(t.id);
        if (!Object.prototype.hasOwnProperty.call(rubric.genres, t.genre)) return httpError(400, 'неизвестный жанр');
        if (typeof t.text !== 'string') return httpError(400, 'текст не строка');
        if (t.text.length > LIMITS.MAX_TEXT_CHARS) return httpError(413, 'один текст длиннее ' + LIMITS.MAX_TEXT_CHARS + ' знаков');
        total += t.text.length;
        clean.push({ id: t.id, genre: t.genre, text: t.text });
    }

    if (total > LIMITS.MAX_TOTAL_CHARS) return httpError(413, 'всего больше ' + LIMITS.MAX_TOTAL_CHARS + ' знаков');
    if (total < LIMITS.MIN_TOTAL_CHARS) return httpError(400, 'меньше ' + LIMITS.MIN_TOTAL_CHARS + ' знаков');

    return { ok: true, input: { scenario: body.scenario, texts: clean }, chars: total };
}

// Origin обязан совпасть с адресом сайта. Без этого чужая страница
// сделала бы из нас бесплатный прокси к модели за наш счёт.
// DEPLOY_PRIME_URL нужен для превью веток: у них свой адрес.
export function originAllowed(req, env) {
    const origin = req.headers.get('origin');
    if (!origin) return false;
    const allowed = [env.URL, env.DEPLOY_PRIME_URL, env.DEPLOY_URL].filter(Boolean);
    return allowed.indexOf(origin) !== -1;
}

export function clientIp(req, context) {
    if (context && context.ip) return context.ip;
    const direct = req.headers.get('x-nf-client-connection-ip');
    if (direct) return direct;
    const fwd = req.headers.get('x-forwarded-for');
    return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

export function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function hourKey(ms) { return new Date(ms).toISOString().slice(0, 13); }

// IP хранится только как хеш с суточной солью: назавтра тот же адрес
// даёт другой хеш, и связать дни между собой нельзя.
export function ipHash(ip, salt, ms) {
    return createHash('sha256').update(String(salt) + '|' + dayKey(ms) + '|' + ip).digest('hex').slice(0, 32);
}

export function sha256(s) {
    return createHash('sha256').update(s).digest('hex');
}

// Подпись вызова фоновой функции. Ключ подписи тот же секрет, что солит
// IP: наружу он не выходит, а новый секрет ради одной подписи заводить
// незачем.
export function signJob(salt, job) {
    return createHmac('sha256', String(salt)).update('bg:' + job).digest('hex');
}

export function tokenMatches(expected, got) {
    if (typeof got !== 'string' || got.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
