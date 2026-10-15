import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readCache, writeCache, fetchJson, queryWikidata, RESULT_TTL} from '../api.js';
import {findEntities, fetchEntity} from '../data.js';

/** Simulate extension storage with independent values and no filesystem access. */
function storage() {
	const data = {};
	return {
		data,
		async get(key) { return structuredClone(key === null ? data : Object.fromEntries((Array.isArray(key) ? key : [key]).map(name => [name, data[name]]))); },
		async getKeys() { return Object.keys(data); },
		async set(values) { Object.assign(data, structuredClone(values)); },
		async remove(keys) { for (const key of keys) delete data[key]; },
	};
}

test('fresh cache is reused and expired cache is ignored', async () => {
	const store = storage();
	await writeCache('Q42/en', {label: 'Douglas Adams'}, store, 1000);
	assert.deepEqual(await readCache('Q42/en', store, 1001), {label: 'Douglas Adams'});
	assert.equal(await readCache('Q42/en', store, 1000 + RESULT_TTL), undefined);
});

test('cache is bounded and does not remove unrelated preferences', async () => {
	const store = storage();
	store.data.languages = {data: ['en']};
	for (let i = 0; i < 30; i++) await writeCache('item' + i, i, store, 1000 + i);
	assert.equal(Object.keys(store.data).length, 25);
	assert.deepEqual(store.data.languages, {data: ['en']});
	assert.equal(await readCache('item0', store, 1030), undefined);
	assert.equal(await readCache('item29', store, 1030), 29);
});

test('cache pruning does not reread the large matching metadata datasets', async t => {
	const store = storage();
	store.data.formatters = {data: ['large metadata fixture']};
	const get = t.mock.method(store, 'get');
	await writeCache('test', {title: 'Example'}, store);
	assert.ok(get.mock.calls.length > 0);
	for (const call of get.mock.calls) {
		assert.notEqual(call.arguments[0], null);
		assert.ok(!call.arguments[0].includes('formatters'));
	}
});

test('storage failures and oversized results do not prevent showing live data', async () => {
	const store = storage();
	await writeCache('huge', 'a'.repeat(200001), store);
	await writeCache('unicode', '界'.repeat(70000), store);
	assert.deepEqual(Object.keys(store.data), []);
	const broken = {get: async () => { throw new Error('offline'); }, set: async () => { throw new Error('full'); }};
	assert.equal(await readCache('test', broken), undefined);
	await writeCache('test', {}, broken);
});

test('HTTP errors and invalid SPARQL envelopes are reported', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response('', {status: 503}));
	await assert.rejects(fetchJson('https://example.test'), /503/);
	globalThis.fetch = async () => Response.json({error: 'bad query'});
	await assert.rejects(queryWikidata('SELECT * WHERE {}'), /Invalid/);
});

test('Wikidata item links do not need an entity search request', async t => {
	t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
	assert.deepEqual(await findEntities('https://www.wikidata.org/wiki/Q42#claims', 'en'), [{id: 'Q42', label: 'Q42'}]);
	assert.deepEqual(await findEntities('about:blank', 'en'), []);
});

test('Wikipedia titles with query characters are encoded as one API parameter', async t => {
	t.mock.method(globalThis, 'fetch', async value => {
		const url = new URL(value);
		assert.equal(url.searchParams.get('titles'), 'A&B');
		assert.equal(url.searchParams.get('redirects'), '1');
		return Response.json({query: {pages: {'1': {title: 'A&B', pageprops: {wikibase_item: 'Q42'}}}}});
	});
	assert.deepEqual(await findEntities('https://en.wikipedia.org/wiki/A%26B', 'en'), [{id: 'Q42', label: 'A&B'}]);
});

test('identifier and direct-URL searches deduplicate entities', async t => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => Response.json({results: {bindings: calls++ ? [
		{iri: {value: 'http://www.wikidata.org/entity/Q42'}, iriLabel: {value: 'Test'}},
		{iri: {value: 'http://www.wikidata.org/entity/Q42'}, iriLabel: {value: 'Test'}},
	] : []}}));
	assert.deepEqual(await findEntities('https://example.test/42', 'en'), [{id: 'Q42', label: 'Test'}]);
	assert.equal(calls, 2);
});

test('one failed detail request does not discard successful sections', async t => {
	t.mock.method(globalThis, 'fetch', async value => new URL(value).searchParams.get('query').includes('?itemLabel')
		? new Response('', {status: 500}) : Response.json({results: {bindings: []}}));
	const sections = [];
	const result = await fetchEntity('Q42', 'en', undefined, section => sections.push(section));
	assert.equal(result.errors.length, 1);
	assert.equal(sections.length, 4);
});
