/** Network and bounded persistent caching, with no dependencies on popup rendering. */

export const RESULT_TTL = 5 * 60 * 1000;
export const METADATA_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'result:';
const CACHE_LIMIT = 24;
const extension = globalThis.browser ?? globalThis.chrome;

/** Fetch JSON with cancellation, a timeout and explicit HTTP error handling. */
export async function fetchJson(url, signal) {
	const response = await fetch(url, {
		headers: {Accept: 'application/json'},
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
	});
	if (!response.ok) throw new Error('Wikidata returned HTTP ' + response.status);
	return response.json();
}

/** Execute SPARQL and return its bindings rather than the transport envelope. */
export async function queryWikidata(query, signal) {
	const url = new URL('https://query.wikidata.org/sparql');
	url.searchParams.set('query', query);
	const data = await fetchJson(url.href, signal);
	if (!Array.isArray(data.results?.bindings)) throw new Error('Invalid Wikidata response');
	return data.results.bindings;
}

/** Read a fresh cached value; storage failure must not prevent a live lookup. */
export async function readCache(key, storage = extension.storage.local, now = Date.now()) {
	try {
		const entry = (await storage.get(CACHE_PREFIX + key))[CACHE_PREFIX + key];
		return entry && now - entry.savedAt < RESULT_TTL ? entry.data : undefined;
	} catch {
		return undefined;
	}
}

/** Save one result independently, pruning old entries to bound storage and parsing costs. */
export async function writeCache(key, data, storage = extension.storage.local, now = Date.now()) {
	try {
		// Large responses can still be shown without consuming the extension's storage quota.
		const serialized = JSON.stringify(data);
		if (serialized.length > 200000 || new TextEncoder().encode(serialized).byteLength > 200000) return;
		await storage.set({[CACHE_PREFIX + key]: {savedAt: now, data}});
		const keys = (await storage.getKeys()).filter(name => name.startsWith(CACHE_PREFIX));
		const entries = Object.entries(await storage.get(keys))
			.sort((a, b) => b[1].savedAt - a[1].savedAt);
		const expired = entries.filter(([, entry], index) => index >= CACHE_LIMIT || now - entry.savedAt >= RESULT_TTL);
		if (expired.length) await storage.remove(expired.map(([name]) => name));
	} catch {
		// Cache writes are best effort: the live result remains usable if storage is full.
	}
}
