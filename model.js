/** Pure URL, language and formatter logic shared by the popup and worker. */

const WIKI_DOMAINS = [
	'wikipedia.org', 'wikibooks.org', 'wikifunctions.org', 'wikinews.org',
	'wikiquote.org', 'wikisource.org', 'wikiversity.org', 'wikivoyage.org',
	'wiktionary.org', 'wikidata.org',
];

export const RTL_LANGUAGES = new Set([
	'acm', 'aeb-arab', 'ar', 'arc', 'arq', 'ary', 'arz', 'azb', 'bjn', 'bqi',
	'ckb', 'dv', 'ett', 'fa', 'fa-af', 'glk', 'hbo', 'he', 'hno', 'khw',
	'kk-arab', 'kmz', 'ks', 'ks-arab', 'ku-arab', 'ky-arab', 'lrc', 'luz',
	'ms-arab', 'mzn', 'nqo', 'ota', 'otk', 'pnb', 'ps', 'sdh', 'syc', 'ug',
	'uzs', 'xpu', 'yi',
]);

/** Return true only for a Wikimedia project host or its subdomains. */
export function isWikimediaHost(host) {
	host = host.toLowerCase();
	return ['commons.wikimedia.org', 'species.wikimedia.org'].includes(host)
		|| WIKI_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain));
}

/** Parse an HTTP(S) URL; reject protocols that cannot be safely linked. */
export function safeUrl(value) {
	try {
		const url = new URL(value);
		return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

/** Identify a Wikidata item/property URL without treating other pages as entities. */
export function pageEntity(value) {
	if (!safeUrl(value)) return null;
	const url = new URL(value);
	if (url.hostname !== 'wikidata.org' && !url.hostname.endsWith('.wikidata.org')) return null;
	return url.pathname.match(/^\/(?:wiki\/|entity\/)?(?:Property:)?([QP][1-9]\d*)\/?$/)?.[1] ?? null;
}

/** Extract an entity ID from an API binding, rejecting unexpected IRIs. */
export function bindingEntity(binding) {
	return pageEntity(binding.iri?.value ?? '');
}

/** Select one valid formatter per property/value pair, preserving rank and language preferences. */
export function selectLinks(bindings, language) {
	const best = new Map();
	for (const binding of bindings) {
		const rank = binding.rankstr?.value ?? '';
		if (rank.includes('Deprecated')) continue;
		const value = binding.valueUri?.value ?? '';
		let score = rank.includes('Preferred') ? 20 : 10;
		const lang = binding.lang?.value;
		if (lang) score += lang === language ? 6 : lang === 'en' ? -5 : -6;
		if (binding.part) score -= 2;
		if (binding.jurisdiction) score -= 2;
		let url = (binding.fmt_URL?.value ?? '').replaceAll('$1', () => value);
		try {
			if (binding.regex_req) {
				const pattern = new RegExp(binding.regex_req.value);
				score += pattern.test(value) ? 8 : -20;
				if (binding.regex) url = value.replace(pattern, binding.regex.value);
			}
		} catch {
			continue;
		}
		url = safeUrl(url);
		if (score < 0 || !url) continue;
		let property = binding.property?.value ?? '';
		if (binding.operatorLabel) property += ' (' + binding.operatorLabel.value + ')';
		const key = JSON.stringify([property, value]);
		if (!best.has(key) || best.get(key).score < score) {
			best.set(key, {property, value, url, language: lang, score});
		}
	}
	return [...best.values()].sort((a, b) => a.property.localeCompare(b.property) || a.value.localeCompare(b.value));
}

/** Produce bounded URL aliases without changing path case or meaningful query parameters. */
export function websiteVariants(value) {
	if (!safeUrl(value)) return [];
	const url = new URL(value);
	url.hash = '';
	const host = url.hostname.replace(/^www\./, '');
	const profile = ['stackoverflow.com', 'stackexchange.com'].includes(host) || host.endsWith('.stackexchange.com');
	const paths = new Set([url.pathname]);
	if (profile) {
		const path = url.pathname.match(/^\/users\/\d+(?:\/[^/]+)?\/?$/)?.[0];
		if (path) paths.add(path.split('/').slice(0, 3).join('/'));
	}
	const variants = new Set();
	for (const path of paths) {
		for (const protocol of ['https:', 'http:']) {
			for (const hostname of [host, 'www.' + host]) {
				const origin = protocol + '//' + hostname + (url.port ? ':' + url.port : '');
				const base = origin + path.replace(/\/$/, '');
				variants.add(base + url.search);
				variants.add(base + '/' + url.search);
			}
		}
	}
	return [...variants];
}

/** Yandex embeds a track in its album URL; retain both documented entity addresses. */
export function identifierUrls(value) {
	if (!safeUrl(value)) return [];
	const url = new URL(value);
	url.hash = '';
	const urls = [url.href];
	if (url.hostname === 'music.yandex.ru') {
		const parts = url.pathname.match(/^\/album\/(\d+)\/track\/(\d+)\/?$/);
		if (parts) urls.push(url.origin + '/album/' + parts[1], url.origin + '/track/' + parts[2]);
	}
	return urls;
}

/** Escape the literal parts of a formatter before adding a separate ID capture. */
function escapePattern(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Infer only literal hosts; complex expressions remain in the fallback bucket. */
function patternHost(pattern) {
	const plain = pattern.replaceAll('\\/', '/').replaceAll('\\.', '.').replaceAll('[.]', '.')
		.replace(/^\^?https?\??:\/\//, '').replace(/^(?:\(\?:www\.\)\?|\(www\.\)\?)/, '');
	return plain.match(/^([a-z0-9.-]+)\//i)?.[1];
}

/** Index remote rules cheaply and compile expressions only for hosts actually visited. */
function createRuleIndex(formatters, matchpatterns) {
	const hosts = new Map();
	const fallback = [];
	for (const entry of [...formatters, ...matchpatterns]) {
		const rule = {...entry};
		let domains = rule.domains ?? (rule.domain ? [rule.domain] : []);
		try {
			if (rule.matchpattern) {
				if (!domains.length) domains = [patternHost(rule.matchpattern)].filter(Boolean);
			} else {
				rule.formatter = (rule.formatter ?? rule.formatter_url).replace(/^https?:\/\/(?:www\.)?/, '').replace(/^www\./, '');
				domains = [new URL('https://' + rule.formatter.replaceAll('$1', 'example')).hostname];
			}
		} catch { continue; }
		if (!domains.length) fallback.push(rule);
		for (const domain of domains) {
			const host = domain.toLowerCase().replace(/^www\./, '');
			if (!hosts.has(host)) hosts.set(host, []);
			hosts.get(host).push(rule);
		}
	}
	return value => {
		if (!safeUrl(value)) return [];
		const url = new URL(value);
		url.hash = '';
		let decoded;
		try { decoded = decodeURI(url.href); } catch { decoded = url.href; }
		const candidates = new Set(fallback);
		const parts = url.hostname.split('.');
		while (parts.length > 1) {
			for (const rule of hosts.get(parts.join('.')) ?? []) candidates.add(rule);
			parts.shift();
		}
		const stripped = decoded.replace(/^https?:\/\/(?:www\.)?/, '');
		const found = [];
		for (const rule of candidates) {
			try {
				if (rule.pattern === undefined) {
					const source = rule.matchpattern ?? '^' + rule.formatter.replace(/\/$/, '').split('$1').map(escapePattern).join('(.+?)') + '/?$';
					rule.pattern = new RegExp(source.replaceAll('(?i)', ''), source.includes('(?i)') ? 'i' : '');
					if (rule.regex) rule.validation = new RegExp('^(?:' + rule.regex.replaceAll('(?i)', '') + ')$', rule.regex.includes('(?i)') ? 'i' : '');
				}
				const match = rule.pattern?.exec(rule.matchpattern ? decoded : stripped);
				if (!match) continue;
				// P8967 uses backslash-number references, and defaults to the first capture.
				const id = rule.matchpattern
					? (rule.replacementvalue ?? '\\1').replace(/\\(\d+)/g, (_, group) => match[Number(group)] ?? '')
					: match[1];
				if (!rule.matchpattern && (!id || (rule.validation && !rule.validation.test(id)))) continue;
				const prop = rule.prop?.split('/').at(-1);
				found.push({prop, id});
			} catch {
				// Unsupported remote regexes cannot disable the remaining matching rules.
				rule.pattern = null;
			}
		}
		return found;
	};
}

/** Extract property/identifier pairs from P8966 patterns and reversible formatter URLs. */
export function createIdentifierResolver(formatters = [], matchpatterns = []) {
	const lookup = createRuleIndex(formatters, matchpatterns);
	return value => [...new Map(identifierUrls(value).flatMap(lookup)
		.filter(item => item.id && /^P[1-9]\d*$/.test(item.prop ?? ''))
		.map(item => [JSON.stringify(item), item])).values()];
}

/** Use the same indexed URL rules for the toolbar's inexpensive likely-match indicator. */
export function createMatcher(formatters = [], matchpatterns = []) {
	const lookup = createRuleIndex(formatters, matchpatterns);
	return value => identifierUrls(value).some(url => isWikimediaHost(new URL(url).hostname) || lookup(url).length > 0);
}
