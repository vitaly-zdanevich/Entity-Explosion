/** Lookup operations; query state belongs to the request rather than shared globals. */
import {fetchJson, queryWikidata, METADATA_TTL} from './api.js';
import {bindingEntity, createIdentifierResolver, isWikimediaHost, pageEntity, safeUrl} from './model.js';
import {
	searchQuery, identifiersQuery, websiteQuery, titleQuery, articlesQuery,
	propertiesQuery, valuesQuery, linksQuery,
} from './queries.js';

/** Reuse fresh matching metadata without making popup startup depend on the worker. */
async function identifierSearch(value, language) {
	const extension = globalThis.browser ?? globalThis.chrome;
	try {
		const cached = await extension?.storage.local.get(['formatters', 'matchpatterns']);
		if ([cached?.formatters, cached?.matchpatterns].every(entry => Array.isArray(entry?.data) && Date.now() - entry.savedAt < METADATA_TTL)) {
			const ids = createIdentifierResolver(cached.formatters.data, cached.matchpatterns.data)(value);
			return ids.length ? identifiersQuery(ids, language) : null;
		}
	} catch { /* Live queries remain available when storage cannot be read. */ }
	return searchQuery(value, language);
}

/** Resolve a page through its entity ID, MediaWiki API, or formatter/direct-URL queries. */
export async function findEntities(value, language, signal, onQuery = () => {}, onPartialFailure = () => {}) {
	if (!safeUrl(value)) return [];
	const id = pageEntity(value);
	if (id) return [{id, label: id}];
	const url = new URL(value);
	if (isWikimediaHost(url.hostname)) {
		const title = url.searchParams.get('title') ?? decodeURIComponent(url.pathname.replace(/^\/wiki\//, ''));
		const api = new URL('/w/api.php', url.origin);
		api.search = new URLSearchParams({action: 'query', prop: 'pageprops', titles: title, redirects: '1', format: 'json', origin: '*'});
		const data = await fetchJson(api.href, signal);
		return Object.values(data.query?.pages ?? {}).flatMap(page => {
			const id = page.pageprops?.wikibase_item;
			return /^Q[1-9]\d*$/.test(id ?? '') ? [{id, label: page.title ?? title.replaceAll('_', ' ')}] : [];
		});
	}
	const queries = [await identifierSearch(value, language), websiteQuery(value, language)];
	const results = await Promise.allSettled(queries.map(async (query, index) => {
		if (!query) return [];
		onQuery(query, index + 1);
		return queryWikidata(query, signal);
	}));
	signal?.throwIfAborted();
	const bindings = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
	// A failed lookup is not evidence that the page has no matching entity.
	const failures = results.filter(result => result.status === 'rejected');
	if (failures.length) {
		if (!bindings.length) throw failures[0].reason;
		onPartialFailure(failures.map(result => result.reason));
	}
	const entities = new Map();
	for (const binding of bindings) {
		const id = bindingEntity(binding);
		if (id) entities.set(id, {id, label: binding.iriLabel?.value ?? id});
	}
	return [...entities.values()];
}

/** Fetch sections concurrently and publish each as soon as it arrives. */
export async function fetchEntity(id, language, signal, onSection) {
	const builders = {title: titleQuery, articles: articlesQuery, properties: propertiesQuery, values: valuesQuery, links: linksQuery};
	const data = {};
	const results = await Promise.allSettled(Object.entries(builders).map(async ([section, build]) => {
		const bindings = await queryWikidata(build(id, language), signal);
		data[section] = bindings;
		onSection(section, bindings);
	}));
	return {data, errors: results.filter(result => result.status === 'rejected').map(result => result.reason)};
}
