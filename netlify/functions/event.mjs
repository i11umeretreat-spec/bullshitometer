// POST /api/event — счётчики метрики по дням.

import { netlifyApp } from '../../engine/netlify.mjs';

export default async function (req, context) {
    return netlifyApp(context).event(req, context);
}

export const config = { path: '/api/event' };
