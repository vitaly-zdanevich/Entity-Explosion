import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import * as model from '../model.js';
import {findEntities} from '../data.js';
import {searchQuery, websiteQuery, identifiersQuery} from '../queries.js';

const rules = JSON.parse(await readFile(new URL('fixtures/url-rules.json', import.meta.url), 'utf8'));
const cases = [
	[40, 'https://lutris.net/games/massive-assault-network-2/', 'P7597', 'massive-assault-network-2'],
	[31, 'https://www.youtube.com/watch?v=-VMiyJbtW60', 'P1651', '-VMiyJbtW60'],
	[29, 'https://www.instagram.com/vitalyzdanevich', 'P2003', 'vitalyzdanevich'],
	[24, 'https://www.mobygames.com/game/34196/kings-bounty-the-legend/', 'P11688', '34196'],
	[22, 'https://www.myabandonware.com/game/armies-of-exigo-f3n', 'P12652', 'f3n'],
];

for (const [issue, url, prop, id] of cases) {
	test('upstream #' + issue + ': extract the identifier from the reported URL', () => {
		const identify = model.createIdentifierResolver(rules.formatters, rules.matchpatterns);
		assert.ok(identify(url).some(item => item.prop === prop && item.id === id));
		assert.equal(model.createMatcher(rules.formatters, rules.matchpatterns)(url), true);
	});
}

test('P8967 combines capture groups without retaining an unmatched URL suffix', () => {
	const identify = model.createIdentifierResolver([], [{prop: 'P1', matchpattern: '^https://example[.]test/(\\w+)/(\\d+)', replacementvalue: '\\1:\\2'}]);
	assert.deepEqual(identify('https://example.test/name/42?tracking=1'), [{prop: 'P1', id: 'name:42'}]);
});

test('upstream #38: a Yandex album/track page can resolve its album as well as its track', () => {
	const identify = model.createIdentifierResolver([
		{prop: 'P2819', formatter: 'https://music.yandex.ru/album/$1', regex: '[1-9][0-9]*'},
		{prop: 'P13289', formatter: 'https://music.yandex.ru/track/$1', regex: '\\d+'},
	]);
	assert.deepEqual(identify('https://music.yandex.ru/album/3639885/track/30124805').sort((a, b) => a.prop.localeCompare(b.prop)), [
		{prop: 'P13289', id: '30124805'}, {prop: 'P2819', id: '3639885'},
	]);
	const query = searchQuery('https://music.yandex.ru/album/3639885/track/30124805', 'en');
	assert.ok(query.includes('"https://music.yandex.ru/album/3639885"'));
	assert.ok(query.includes('"https://music.yandex.ru/track/30124805"'));
	assert.deepEqual(identify('https://example.test/album/3639885/track/30124805'), []);
});

test('host indexing avoids scanning thousands of unrelated URL expressions', t => {
	const patterns = Array.from({length: 7000}, (_, i) => ({prop: 'P1', matchpattern: '^https://site' + i + '[.]test/(\\d+)', domains: ['site' + i + '.test']}));
	const matches = model.createMatcher([], patterns);
	const exec = t.mock.method(RegExp.prototype, 'exec');
	assert.equal(matches('https://site6999.test/42'), true);
	assert.ok(exec.mock.callCount() < 40, 'Matching should examine this host, not all 7000 rules');
});

test('upstream #37 and #30: official sites retain trailing slash variants', () => {
	for (const url of ['https://complexnumbers.ru/earths-attraction/', 'https://www.cube.eu/', 'https://www.gentoo.org/']) {
		assert.ok(model.websiteVariants(url).includes(url));
		assert.ok(model.websiteVariants(url).includes(url.replace(/\/$/, '')));
	}
	assert.ok(model.websiteVariants('https://example.test/Path?q=Case#section').includes('https://example.test/Path?q=Case'));
	assert.ok(!model.websiteVariants('https://example.test/Path?q=Case').includes('https://example.test/path'));
});

test('upstream #28 and #27: numeric Stack Exchange user URLs ignore optional display-name slugs', () => {
	assert.ok(model.websiteVariants('https://stackoverflow.com/users/1879101/vitaly-zdanevich').includes('https://stackoverflow.com/users/1879101'));
	assert.ok(model.websiteVariants('https://stackexchange.com/users/2114516/vitaly-zdanevich').includes('https://stackexchange.com/users/2114516'));
	assert.ok(!model.websiteVariants('https://example.test/users/42/other').includes('https://example.test/users/42'));
});

test('upstream #35, #28 and #27: URL queries include statement qualifiers', () => {
	const query = websiteQuery('https://www.crazygames.com/game/vector-td', 'en');
	assert.match(query, /wikibase:qualifier/);
	assert.match(query, /wikibase:claim/);
	assert.match(query, /wikibase:DeprecatedRank/);
});

test('upstream #31: identifier lookup includes normal statements when preferred ones exist', () => {
	const query = searchQuery('https://www.youtube.com/watch?v=-VMiyJbtW60', 'en');
	assert.match(query, /wikibase:statementProperty/);
	assert.match(query, /wikibase:DeprecatedRank/);
	assert.doesNotMatch(query, /wikibase:directClaim/);
});

test('identifier and direct-URL matches are combined instead of discarding the second source', async t => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		const id = calls++ === 0 ? 'Q42' : 'Q84';
		return Response.json({results: {bindings: [{iri: {value: 'http://www.wikidata.org/entity/' + id}}]}});
	});
	assert.deepEqual((await findEntities('https://example.test/42', 'en')).map(item => item.id).sort(), ['Q42', 'Q84']);
	assert.equal(calls, 2);
});

test('fresh cached metadata resolves the reported IDs without a server-side regex scan', async t => {
	const previous = globalThis.chrome;
	globalThis.chrome = {storage: {local: {get: async () => ({
		formatters: {savedAt: Date.now(), data: rules.formatters},
		matchpatterns: {savedAt: Date.now(), data: rules.matchpatterns},
	})}}};
	t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
	t.mock.method(globalThis, 'fetch', async value => {
		const query = new URL(value).searchParams.get('query');
		assert.doesNotMatch(query, /P8966/);
		const found = query.includes('(wd:P7597 "massive-assault-network-2")');
		return Response.json({results: {bindings: found ? [{iri: {value: 'http://www.wikidata.org/entity/Q4043784'}}] : []}});
	});
	assert.deepEqual(await findEntities(cases[0][1], 'en'), [{id: 'Q4043784', label: 'Q4043784'}]);
	assert.deepEqual(await findEntities('https://unrecognized.test/page', 'en'), []);
	assert.throws(() => identifiersQuery([{prop: 'P1} UNION {}', id: 'x'}], 'en'), /Invalid/);
});

test('failed lookups are reported instead of cached as no match, while successful matches remain usable', async t => {
	t.mock.method(globalThis, 'fetch', async () => new Response('', {status: 503}));
	await assert.rejects(findEntities('https://example.test/page', 'en'), /503/);
	globalThis.fetch = async value => new URL(value).searchParams.get('query').includes('wikibase:qualifier')
		? Response.json({results: {bindings: [{iri: {value: 'http://www.wikidata.org/entity/Q42'}}]}})
		: new Response('', {status: 503});
	assert.deepEqual(await findEntities('https://example.test/page', 'en'), [{id: 'Q42', label: 'Q42'}]);
});

test('unsupported metadata expressions do not prevent a valid rule from matching', () => {
	const identify = model.createIdentifierResolver([
		{prop: 'P1', formatter: 'https://example.test/$1', regex: '['},
		{prop: 'P2', formatter: 'https://example.test/$1', regex: '\\d+'},
	], [{prop: 'P3', matchpattern: '['}]);
	assert.deepEqual(identify('https://example.test/42'), [{prop: 'P2', id: '42'}]);
	assert.deepEqual(identify('https://example.test/43'), [{prop: 'P2', id: '43'}]);
});
