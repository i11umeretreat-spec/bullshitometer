// Хранилища. В проде это Netlify Blobs, в тестах Map в памяти.
// Код приложения видит только getJSON / setJSON / delete.

export function memoryStore() {
    const m = new Map();
    return {
        async getJSON(key) { return m.has(key) ? JSON.parse(m.get(key)) : null; },
        async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
        async delete(key) { m.delete(key); },
        dump() {
            const out = {};
            for (const [k, v] of m) out[k] = JSON.parse(v);
            return out;
        },
    };
}

// consistency: 'strong' обязательна для счётчиков: иначе чтение сразу
// после записи может вернуть старое значение, и лимит пропустит лишнее.
export function blobStore(getStore, name) {
    const s = getStore({ name: name, consistency: 'strong' });
    return {
        async getJSON(key) {
            const v = await s.get(key, { type: 'json' });
            return v === undefined ? null : v;
        },
        async setJSON(key, value) { await s.setJSON(key, value); },
        async delete(key) { await s.delete(key); },
    };
}

// Счётчик через чтение и запись. У Blobs нет атомарного инкремента,
// поэтому при одновременных запросах счёт может отстать на единицы.
// Для лимитов это допустимо: они мягкие, и ошибка всегда в сторону
// пропуска лишнего запроса, а не отказа честному.
export async function bump(store, key, by) {
    const cur = (await store.getJSON(key)) || 0;
    const next = cur + (by === undefined ? 1 : by);
    await store.setJSON(key, next);
    return next;
}
