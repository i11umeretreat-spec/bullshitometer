// Фоновая разметка. Суффикс -background в имени файла делает функцию
// фоновой: Netlify сразу отвечает вызывающему 202, а сама функция
// работает до 15 минут. Снаружи её вызвать можно, но без подписи
// и без живого задания она ничего не делает (см. engine/app.mjs).

import { netlifyApp } from '../../engine/netlify.mjs';

export default async function (req, context) {
    return netlifyApp(context).background(req);
}
