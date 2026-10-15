/** Cached toolbar matching. This worker never blocks popup initialization. */
import {METADATA_TTL, queryWikidata} from './api.js';
import {createMatcher} from './model.js';
import {formattersQuery, matchPatternsQuery, languagesQuery} from './queries.js';

/** Flatten SPARQL bindings before caching, avoiding serialized RegExp objects. */
export function flattenBindings(bindings) {
	return bindings.map(binding => Object.fromEntries(Object.entries(binding).map(([key, value]) => [key, value.value])));
}

/** Register listeners synchronously, then restore metadata and refresh only stale datasets. */
export function startBackground(browser, query = queryWikidata) {
	const currentUrls = new Map();
	const lastIcons = new Map();
	const matchResults = new Map();
	let matches = createMatcher();
	const definitions = {
		formatters: formattersQuery,
		matchpatterns: matchPatternsQuery,
		languages: languagesQuery,
	};
	let metadata = {};
	const ready = browser.storage.local.get(Object.keys(definitions)).then(cached => {
		metadata = cached;
		compile();
	}).catch(console.error);

	/** Rebuild regexes only when metadata changes, rather than once per tab event. */
	function compile() {
		matches = createMatcher(metadata.formatters?.data ?? [], metadata.matchpatterns?.data ?? []);
		lastIcons.clear();
		matchResults.clear();
	}

	/** Keep asynchronous icon updates tied to the URL that triggered them. */
	async function updateIcon(tabId, url) {
		currentUrls.set(tabId, url);
		await ready;
		if (currentUrls.get(tabId) !== url) return;
		if (!matchResults.has(url)) {
			if (matchResults.size >= 128) matchResults.delete(matchResults.keys().next().value);
			matchResults.set(url, matches(url));
		}
		const state = matchResults.get(url) ? 'color' : 'gray';
		// The popup can confirm a different result, so a new page must always reset its icon.
		if (lastIcons.get(tabId)?.url === url && lastIcons.get(tabId)?.state === state) return;
		lastIcons.set(tabId, {url, state});
		try {
			await browser.action.setIcon({tabId, path: {16: 'images/wikidata-' + state + '-16.png', 32: 'images/wikidata-' + state + '-32.png'}});
		} catch {
			// Tabs can close between their URL event and the icon update.
			lastIcons.delete(tabId);
		}
	}

	/** Refresh active icons once after loading updated matching rules. */
	async function updateActiveTabs() {
		try {
			const tabs = await browser.tabs.query({active: true});
			await Promise.all(tabs.map(tab => updateIcon(tab.id, tab.url)));
		} catch (error) {
			console.error('Unable to update toolbar icons.', error);
		}
	}

	browser.tabs.onUpdated.addListener((tabId, change) => {
		if (change.url !== undefined) void updateIcon(tabId, change.url);
	});
	browser.tabs.onActivated.addListener(({tabId}) => {
		void browser.tabs.get(tabId).then(tab => updateIcon(tabId, tab.url)).catch(() => {});
	});
	browser.tabs.onRemoved.addListener(tabId => {
		currentUrls.delete(tabId);
		lastIcons.delete(tabId);
	});

	const refreshed = ready.then(async () => {
		void updateActiveTabs();
		let changed = false;
		await Promise.all(Object.entries(definitions).map(async ([key, build]) => {
			if (metadata[key]?.data?.length && Date.now() - metadata[key].savedAt < METADATA_TTL) return;
			try {
				const data = flattenBindings(await query(build()));
				if (!data.length) return;
				if (key === 'formatters') {
					for (const entry of data) {
						entry.formatter = entry.formatter_url;
						delete entry.formatter_url;
					}
				}
				metadata[key] = {savedAt: Date.now(), data};
				await browser.storage.local.set({[key]: metadata[key]});
				changed ||= key !== 'languages';
			} catch (error) {
				// Keep stale metadata when Wikidata is temporarily unavailable.
				console.error('Unable to refresh ' + key + '.', error);
			}
		}));
		if (changed) {
			compile();
			await updateActiveTabs();
		}
	});
	return {ready, refreshed, updateIcon};
}

const extension = globalThis.browser ?? globalThis.chrome;
if (extension?.tabs) startBackground(extension);
