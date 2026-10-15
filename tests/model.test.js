import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isWikimediaHost, pageEntity, safeUrl, selectLinks, createMatcher} from '../model.js';
import {searchQuery, websiteQuery, titleQuery} from '../queries.js';

test('Wikimedia hosts must match a domain boundary', () => {
	for (const host of ['en.wikipedia.org', 'commons.wikimedia.org', 'www.wikidata.org']) {
		assert.equal(isWikimediaHost(host), true);
	}
	for (const host of ['en.wikipedia.org.evil.test', 'notwikidata.org', 'commons.wikimedia.org.evil.test']) {
		assert.equal(isWikimediaHost(host), false);
	}
});

test('entity URLs ignore fragments and query parameters but validate IDs', () => {
	assert.equal(pageEntity('https://www.wikidata.org/wiki/Q42?uselang=en#claims'), 'Q42');
	assert.equal(pageEntity('https://www.wikidata.org/wiki/Property:P31'), 'P31');
	assert.equal(pageEntity('https://www.wikidata.org/wiki/Special:Search'), null);
	assert.equal(pageEntity('https://www.wikidata.org.evil.test/wiki/Q42'), null);
});

test('page URLs are escaped as complete SPARQL literals', () => {
	const url = 'https://example.test/O\'Brien?q="quote"\\path';
	assert.ok(searchQuery(url, 'en').includes(JSON.stringify(new URL(url).href)));
	assert.ok(websiteQuery(url, 'en').includes(JSON.stringify(new URL(url).href)));
	assert.throws(() => titleQuery('Q42> . ?s ?p ?o', 'en'), /Invalid/);
});

test('literal dollar signs and placeholder-like URL text are not reinterpreted', () => {
	const url = 'https://example.test/$&/__LANG_LITERAL__';
	assert.ok(searchQuery(url, 'en').includes(JSON.stringify(url)));
});

test('query normalization removes www. but preserves different hostnames such as www2', () => {
	const query = searchQuery('https://www2.example.test/42', 'en');
	const patterns = [...query.matchAll(/REPLACE\(\?(?:test_url0|formatter_url0), ("[^"]+")/g)];
	assert.equal(patterns.length, 2);
	for (const [, literal] of patterns) {
		const pattern = new RegExp(JSON.parse(literal));
		assert.equal('https://www.example.test'.replace(pattern, ''), 'example.test');
		assert.equal('https://www2.example.test'.replace(pattern, ''), 'www2.example.test');
	}
});

test('external links reject executable and malformed URLs', () => {
	assert.equal(safeUrl('javascript:alert(1)'), null);
	assert.equal(safeUrl('data:text/html,test'), null);
	assert.equal(safeUrl('not a URL'), null);
	assert.equal(safeUrl('https://example.test/42'), 'https://example.test/42');
});

/** Make one mocked SPARQL formatter binding. */
function link(rank, extra = {}) {
	return {
		property: {value: 'Identifier'}, valueUri: {value: '42'},
		fmt_URL: {value: 'https://example.test/$1'},
		rankstr: {value: rank + 'Rank'}, ...extra,
	};
}

test('a deprecated first result is not displayed', () => {
	assert.deepEqual(selectLinks([link('Deprecated')], 'en'), []);
});

test('links choose the highest ranked formatter without mutating responses', () => {
	const data = [link('Normal'), link('Preferred', {fmt_URL: {value: 'https://preferred.test/$1'}})];
	const before = structuredClone(data);
	const links = selectLinks(data, 'en');
	assert.equal(links.length, 1);
	assert.equal(links[0].url, 'https://preferred.test/42');
	assert.deepEqual(data, before);
});

test('invalid formatter regular expressions do not break other links', () => {
	assert.equal(selectLinks([link('Normal', {regex_req: {value: '['}}), link('Preferred')], 'en').length, 1);
});

test('cached matcher is stable across repeated checks and uses literal hostname boundaries', () => {
	const matches = createMatcher([
		{formatter: 'example.test/item/$1', regex: '\\d+'},
	], [{matchpattern: '^https?://other\\.test/\\d+$'}]);
	for (let i = 0; i < 3; i++) {
		assert.equal(matches('https://example.test/item/42'), true);
		assert.equal(matches('https://other.test/42'), true);
		assert.equal(matches('https://example.test.evil/item/42'), false);
		assert.equal(matches('about:blank'), false);
	}
});
