// Выходы движка для всех фикстур глубоко равны снимкам из test/golden.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureNames, snapshot, goldenPath } from './golden/golden.mjs';

for (const name of fixtureNames()) {
    test('снимок движка: ' + name, async () => {
        const want = JSON.parse(readFileSync(goldenPath(name), 'utf8'));
        assert.deepEqual(await snapshot(name), want);
    });
}
