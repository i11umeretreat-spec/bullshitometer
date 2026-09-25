// Боевая обвязка: Netlify Blobs, настоящий fetch, настоящие часы.
// Тесты этот файл не трогают, они собирают приложение со своими
// заглушками через createApp.

import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.mjs';
import { blobStore } from './store.mjs';

let app = null;

function envFor(context) {
    const env = Object.assign({}, process.env);
    // Адрес сайта для проверки Origin. В рантайме функций его надёжнее
    // брать из контекста: переменная URL задаётся при сборке.
    if (!env.URL && context && context.site && context.site.url) env.URL = context.site.url;
    return env;
}

export function netlifyApp(context) {
    if (app) return app;
    app = createApp({
        stores: {
            extractions: blobStore(getStore, 'extractions'),
            ratelimit: blobStore(getStore, 'ratelimit'),
            counters: blobStore(getStore, 'counters'),
            jobs: blobStore(getStore, 'jobs'),
        },
        fetch: function (url, init) { return fetch(url, init); },
        env: envFor(context),
        now: function () { return Date.now(); },
        sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
        log: function (line) { console.log(line); },
        uuid: function () { return randomUUID(); },
        // Фоновая функция отвечает 202 сразу и работает дальше до 15
        // минут. Вызываем её по адресу того же деплоя, из которого
        // пришёл запрос: у превью веток адрес свой.
        invokeBackground: async function (payload, token, origin) {
            const res = await fetch(origin + '/.netlify/functions/analyze-background', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-bg-token': token },
                body: JSON.stringify(payload),
            });
            if (res.status !== 202 && res.status !== 200) throw new Error('background ' + res.status);
        },
    });
    return app;
}
