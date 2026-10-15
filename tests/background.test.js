import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startBackground, flattenBindings} from '../background.js';

/** Provide cached metadata and controllable extension events without a browser. */
function browserFixture() {
	const events = {};
	const icons = [];
	const data = {
		formatters: {savedAt: Date.now(), data: [{formatter: 'example.test/$1', regex: '\\d+'}]},
		matchpatterns: {savedAt: Date.now(), data: [{matchpattern: '^https://other\\.test/\\d+$'}]},
		languages: {savedAt: Date.now(), data: [{lang: 'en', tongue: 'English'}]},
	};
	const event = key => ({addListener: listener => { events[key] = listener; }});
	return {
		data, events, icons,
		storage: {local: {get: async () => data, set: async values => Object.assign(data, values)}},
		tabs: {query: async () => [], get: async id => ({id, url: 'https://example.test/42'}), onUpdated: event('updated'), onActivated: event('activated'), onRemoved: event('removed')},
		action: {setIcon: async icon => icons.push(icon)},
	};
}

test('cached metadata avoids background queries and repeated icon writes', async () => {
	const browser = browserFixture();
	const worker = startBackground(browser, async () => { throw new Error('Unexpected network request'); });
	assert.equal(typeof browser.events.updated, 'function');
	await worker.refreshed;
	await worker.updateIcon(1, 'https://example.test/42');
	await worker.updateIcon(1, 'https://example.test/42');
	await worker.updateIcon(2, 'https://unmatched.test');
	assert.equal(browser.icons.length, 2);
	assert.match(browser.icons[0].path[16], /color/);
	assert.match(browser.icons[1].path[16], /gray/);
	assert.equal(browser.icons[0].tabId, 1);
	assert.equal(browser.icons[1].tabId, 2);
});

test('newer navigation supersedes icon work waiting on storage', async () => {
	const browser = browserFixture();
	let restore;
	browser.storage.local.get = () => new Promise(resolve => { restore = resolve; });
	const worker = startBackground(browser);
	const old = worker.updateIcon(1, 'https://example.test/42');
	const latest = worker.updateIcon(1, 'https://unmatched.test');
	restore(browser.data);
	await Promise.all([old, latest, worker.refreshed]);
	assert.equal(browser.icons.length, 1);
	assert.match(browser.icons[0].path[16], /gray/);
});

test('navigation replaces the popup-confirmed icon even when the estimated match state stays the same', async () => {
	const browser = browserFixture();
	const worker = startBackground(browser);
	await worker.refreshed;
	await worker.updateIcon(1, 'https://unmatched.test/first');
	await browser.action.setIcon({tabId: 1, path: {16: 'images/wikidata-color-16.png'}});
	await worker.updateIcon(1, 'https://unmatched.test/second');
	assert.match(browser.icons.at(-1).path[16], /gray/);
	await worker.updateIcon(1, 'https://example.test/42');
	await browser.action.setIcon({tabId: 1, path: {16: 'images/wikidata-gray-16.png'}});
	await worker.updateIcon(1, 'https://example.test/84');
	assert.match(browser.icons.at(-1).path[16], /color/);
});

test('bindings are flattened without mutating the response', () => {
	const rows = [{lang: {value: 'en', type: 'literal'}}];
	assert.deepEqual(flattenBindings(rows), [{lang: 'en'}]);
	assert.equal(rows[0].lang.type, 'literal');
});

test('expired metadata is refreshed and cached as plain data', async () => {
	const browser = browserFixture();
	for (const entry of Object.values(browser.data)) entry.savedAt = 0;
	let requests = 0;
	const worker = startBackground(browser, async query => {
		requests++;
		if (query.includes('?formatter_url')) return [{formatter_url: {value: 'fresh.test/$1'}, regex: {value: '\\d+'}}];
		if (query.includes('?matchpattern')) return [{matchpattern: {value: '^https://another.test/42$'}}];
		return [{lang: {value: 'en'}, tongue: {value: 'English'}}];
	});
	await worker.refreshed;
	assert.equal(requests, 3);
	assert.equal(browser.data.formatters.data[0].formatter, 'fresh.test/$1');
	await worker.updateIcon(4, 'https://fresh.test/42');
	assert.match(browser.icons.at(-1).path[16], /color/);
});
