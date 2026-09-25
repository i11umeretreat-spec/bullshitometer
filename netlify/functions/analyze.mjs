// POST /api/analyze — запуск разбора, GET /api/analyze?job=… — опрос.

import { netlifyApp } from '../../engine/netlify.mjs';

export default async function (req, context) {
    const app = netlifyApp(context);
    return req.method === 'GET' ? app.status(req, context) : app.analyze(req, context);
}

export const config = { path: '/api/analyze' };
