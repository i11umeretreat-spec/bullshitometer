// GET /api/pack?domain=… — публичная часть доменного пакета для страницы.

import { netlifyApp } from '../../engine/netlify.mjs';

export default async function (req, context) {
    return netlifyApp(context).pack(req);
}

export const config = { path: '/api/pack' };
