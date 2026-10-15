/** Native popup UI. Cached content and controls never wait for the background worker. */
import {readCache, writeCache} from './api.js';
import {findEntities, fetchEntity} from './data.js';
import {RTL_LANGUAGES, safeUrl, selectLinks} from './model.js';
import {entityIri} from './queries.js';

const extension = globalThis.browser ?? globalThis.chrome;
const element = id => document.getElementById(id);
const languageSelect = element('box0');
const entitySelect = element('box1');
const sectionIds = {title: 'div_title', articles: 'div_wiki', properties: 'div1', values: 'div2', links: 'div3'};
const message = key => extension.i18n.getMessage(key);
let tab;
let language = extension.i18n.getUILanguage().toLowerCase().split('-')[0];
let translations = [];
let activeRequest;

/** Create plain-text nodes so remote labels never become executable markup. */
function node(tag, text, className) {
	const result = document.createElement(tag);
	if (text !== undefined) result.textContent = text;
	if (className) result.className = className;
	return result;
}

/** Only link to HTTP(S) destinations, isolating new tabs from the popup. */
function link(text, value) {
	const href = safeUrl(value);
	if (!href) return node('span', text);
	const result = node('a', text);
	result.href = href;
	result.target = '_blank';
	result.rel = 'noopener noreferrer';
	return result;
}

/** Update loading state without hiding controls or already available results. */
function setLoading(loading) {
	element('searchSpinner').hidden = !loading;
	element('results').setAttribute('aria-busy', String(loading));
	element('status').textContent = loading ? message('loading') : '';
}

/** Cancel superseded work and give each new selection its own immutable identity. */
function beginRequest() {
	activeRequest?.abort();
	activeRequest = new AbortController();
	for (const id of ['div_wdlink', ...Object.values(sectionIds)]) {
		element(id).replaceChildren();
		element(id).hidden = true;
	}
	setLoading(true);
	return activeRequest;
}

/** Keep toolbar state scoped to the popup's tab, including in multiple windows. */
function setMatch(found) {
	if (tab?.id !== undefined) {
		const state = found ? 'color' : 'gray';
		void extension.action.setIcon({tabId: tab.id, path: {16: 'images/wikidata-' + state + '-16.png', 32: 'images/wikidata-' + state + '-32.png'}}).catch(console.error);
	}
}

/** Localize the entity selector's accessible name and update content direction. */
function redrawLabels() {
	const translation = translations.find(item => item.lang === language);
	entitySelect.setAttribute('aria-label', translation?.entity ?? message('entityLabel'));
	const direction = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
	element('results').dir = direction;
	languageSelect.dir = direction;
	entitySelect.dir = direction;
}

/** Populate languages in one DOM update, retaining the saved language before metadata is ready. */
function populateLanguages() {
	const uiLanguage = extension.i18n.getUILanguage().toLowerCase();
	const codes = [...new Set([language, uiLanguage, 'en', ...translations.map(item => item.lang)])];
	languageSelect.replaceChildren(...codes.map(code => new Option(code, code)));
	languageSelect.value = language;
	redrawLabels();
}

/** Render one property with automatic direction isolation for mixed-language data. */
function propertyRow(property, value, url) {
	const row = node('p', undefined, 'property');
	const label = node('bdi', property);
	const strong = node('strong');
	const content = node('bdi', value);
	if (url) {
		const anchor = link(undefined, url);
		anchor.append(content);
		strong.append(anchor);
	} else {
		strong.append(content);
	}
	row.append(label, ': ', strong);
	return row;
}

/** Keep the entity link beside its title, including when the localized title is unavailable. */
function renderTitle(bindings, id) {
	const fragment = document.createDocumentFragment();
	const item = bindings[0] ?? {};
	const heading = node('div', undefined, 'entity-heading');
	if (item.itemLabel) {
		const title = node('h1', item.itemLabel.value);
		title.dir = 'auto';
		heading.append(title);
	}
	heading.append(link(id, entityIri(id)));
	fragment.append(heading);
	if (item.itemDesc) fragment.append(node('p', item.itemDesc.value));
	if (safeUrl(item.image?.value)) {
		try {
			const filename = decodeURIComponent(new URL(item.image.value).pathname.split('/').at(-1));
			const anchor = link(undefined, 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(filename));
			anchor.className = 'image-link';
			const image = node('img', undefined, 'entity-image');
			image.alt = item.itemLabel?.value ?? filename;
			image.decoding = 'async';
			image.referrerPolicy = 'no-referrer';
			image.src = 'https://commons.wikimedia.org/wiki/Special:Redirect/file/' + encodeURIComponent(filename) + '?width=800';
			image.addEventListener('error', () => anchor.remove(), {once: true});
			anchor.append(image);
			fragment.append(anchor);
		} catch {
			// A malformed image URL must not hide the entity's text.
		}
	}
	return fragment;
}

/** Translate project names for sitelinks, including multilingual Wikimedia projects. */
function articleName(url) {
	const projects = {
		'wikipedia': ['pedia', 'Wikipedia'], 'wikibooks': ['books', 'Wikibooks'],
		'wikifunctions': ['functions', 'Wikifunctions'], 'wikinews': ['news', 'Wikinews'],
		'wikiquote': ['quote', 'Wikiquote'], 'wikisource': ['source', 'Wikisource'],
		'wikiversity': ['versity', 'Wikiversity'], 'wikivoyage': ['voyage', 'Wikivoyage'],
		'wiktionary': ['tionary', 'Wiktionary'], 'commons': ['commons', 'Wikimedia Commons'],
		'species': ['species', 'Wikispecies'],
	};
	const project = Object.keys(projects).find(key => url.hostname.split('.').includes(key));
	if (!project) return url.hostname;
	const [key, fallback] = projects[project];
	return translations.find(item => item.lang === language)?.[key] ?? fallback;
}

/** Publish a complete section with a single DOM replacement. */
function renderSection(section, bindings, id) {
	const target = element(sectionIds[section]);
	const fragment = document.createDocumentFragment();
	if (section === 'title') fragment.append(renderTitle(bindings, id));
	else if (section === 'links') {
		for (const item of selectLinks(bindings, language)) {
			const suffix = item.language && item.language !== language ? ' [' + item.language + ']' : '';
			fragment.append(propertyRow(item.property + suffix, item.value, item.url));
		}
	} else if (section === 'articles') {
		for (const item of bindings) {
			if (!safeUrl(item.article?.value)) continue;
			const url = new URL(item.article.value);
			if (item.articlelang?.value !== language && !['commons.wikimedia.org', 'species.wikimedia.org'].includes(url.hostname)) continue;
			let title = url.pathname.split('/').at(-1).replaceAll('_', ' ');
			try { title = decodeURIComponent(title); } catch { /* Retain malformed encoded titles as text. */ }
			fragment.append(propertyRow(articleName(url), title, url.href));
		}
	} else {
		const rows = new Map();
		for (const item of bindings) {
			const value = item.value?.value ?? item.valueUri?.value ?? '';
			const property = item.property?.value ?? '';
			const key = JSON.stringify([property, item.valueUri?.value ?? value]);
			if (!rows.has(key)) {
				const url = section === 'values' ? safeUrl(value) : safeUrl(item.valueUri?.value);
				const row = propertyRow(property, value, url);
				rows.set(key, {row, links: new Set()});
				fragment.append(row);
			}
			const {row, links} = rows.get(key);
			for (const candidate of [item.externalUrl?.value, item.websiteUrl?.value]) {
				const url = safeUrl(candidate);
				if (!url || links.has(url)) continue;
				links.add(url);
				row.append(' · ', link(new URL(url).hostname.replace(/^www\./, ''), url));
			}
		}
	}
	target.replaceChildren(fragment);
	target.hidden = !target.hasChildNodes();
}

/** Render localized no-result guidance without assigning remote strings to innerHTML. */
function noResult() {
	entitySelect.replaceChildren(new Option(message('noResultDropdown'), ''));
	entitySelect.disabled = true;
	const target = element('div_wdlink');
	target.replaceChildren(
		message('noResult1') + ' (',
		link(message('search'), 'https://www.wikidata.org/wiki/Special:Search'),
		')' + message('noResult2'),
		link(message('newItem'), 'https://www.wikidata.org/wiki/Special:NewItem'),
		' ' + message('noResult3'),
	);
	target.hidden = false;
	setMatch(false);
}

/** Show cached details immediately, then fetch only when absent or explicitly refreshed. */
async function showEntity(id, request, force = false) {
	const locale = language;
	const cacheKey = 'entity:' + locale + ':' + id;
	const cached = force ? undefined : await readCache(cacheKey);
	if (request !== activeRequest) return;
	renderSection('title', [], id);
	if (cached) {
		for (const [section, bindings] of Object.entries(cached)) renderSection(section, bindings, id);
		setLoading(false);
		return;
	}
	const {data, errors} = await fetchEntity(id, locale, request.signal, (section, bindings) => {
		if (request === activeRequest) renderSection(section, bindings, id);
	});
	if (request !== activeRequest) return;
	setLoading(false);
	if (errors.length) element('status').textContent = message('requestFailed');
	else void writeCache(cacheKey, data);
}

/** Resolve the active page without allowing an older response to overwrite a newer selection. */
async function search(force = false) {
	const request = beginRequest();
	const locale = language;
	entitySelect.replaceChildren(new Option(message('select'), ''));
	entitySelect.disabled = true;
	if (!safeUrl(tab?.url)) {
		setLoading(false);
		element('status').textContent = message('unsupportedPage');
		return;
	}
	try {
		const key = 'page:' + locale + ':' + tab.url;
		let partial = false;
		let entities = force ? undefined : await readCache(key);
		if (request !== activeRequest) return;
		if (!entities) {
			entities = await findEntities(tab.url, locale, request.signal, (query, index) => {
				if (request !== activeRequest) return;
				const queryLink = link(message('query' + index), 'https://query.wikidata.org/#' + encodeURIComponent(query));
				element('status').replaceChildren(queryLink, ' ' + message('sentToWikidata'));
			}, () => { partial = true; });
			if (request !== activeRequest) return;
			if (!partial) void writeCache(key, entities);
		}
		if (!entities.length) {
			noResult();
			setLoading(false);
			return;
		}
		entitySelect.append(...entities.map(item => new Option(item.label === item.id ? item.id : item.label + ' (' + item.id + ')', item.id)));
		entitySelect.disabled = false;
		setMatch(true);
		// Display the first match immediately; the selector keeps alternatives available.
		entitySelect.value = entities[0].id;
		await showEntity(entities[0].id, request, force);
		if (partial && request === activeRequest) element('status').textContent = message('partialResults');
	} catch (error) {
		if (request !== activeRequest) return;
		setLoading(false);
		element('status').textContent = message('requestFailed');
		console.error(error);
	}
}

/** Firefox can clip a toolbar panel without shrinking its viewport; fit its scroll area to the screen. */
function fitFirefoxPopup() {
	if (typeof window.mozInnerScreenY !== 'number' || !extension.extension?.getViews({type: 'popup'}).includes(window)) return;
	const popup = document.querySelector('.popup');
	const fit = () => {
		// Leave room for the native panel border without changing the body's preferred size.
		const available = screen.availTop + screen.availHeight - window.mozInnerScreenY - 2;
		popup.style.maxHeight = Math.max(1, Math.min(600, available)) + 'px';
	};
	window.addEventListener('resize', fit);
	window.addEventListener('focus', fit);
	requestAnimationFrame(fit);
}

/** Read only the cached language list; network refreshes belong to the background worker. */
async function initialize() {
	fitFirefoxPopup();
	document.documentElement.lang = extension.i18n.getUILanguage();
	element('refresh').textContent = message('refresh');
	populateLanguages();
	languageSelect.addEventListener('change', () => {
		language = languageSelect.value;
		redrawLabels();
		void extension.storage.sync.set({IsoLanguage: language}).catch(console.error);
		void search();
	});
	entitySelect.addEventListener('change', () => {
		const request = beginRequest();
		if (entitySelect.value) void showEntity(entitySelect.value, request);
		else setLoading(false);
	});
	element('refresh').addEventListener('click', () => void search(true));
	extension.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && changes.languages?.newValue?.data) {
			translations = changes.languages.newValue.data;
			populateLanguages();
		}
	});
	const [tabs, saved, local] = await Promise.all([
		extension.tabs.query({active: true, currentWindow: true}),
		extension.storage.sync.get('IsoLanguage').catch(() => ({})),
		extension.storage.local.get('languages').catch(() => ({})),
	]);
	tab = tabs[0];
	language = saved.IsoLanguage || language;
	translations = local.languages?.data ?? translations;
	populateLanguages();
	void search();
}

void initialize().catch(error => {
	setLoading(false);
	element('status').textContent = message('requestFailed');
	console.error(error);
});
