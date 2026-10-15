import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium, firefox} from 'playwright';

const root = new URL('../../', import.meta.url);
const messages = JSON.parse(await readFile(new URL('_locales/en/messages.json', root), 'utf8'));
const archiveMatches = [
	{id: 'Q461', label: 'Internet Archive'},
	{id: 'Q15745318', label: 'American Journalism'},
	{id: 'Q140694416', label: 'Archive.org'},
];
let browser;

before(async () => {
	const type = process.env.TEST_BROWSER === 'firefox' ? firefox : chromium;
	browser = await type.launch({headless: true, channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.BROWSER_EXECUTABLE || undefined});
});
after(async () => { await browser?.close(); });

/** Deterministic Wikidata responses cover the text, images and external link sections. */
function entityData(label = 'Douglas Adams') {
	return {
		title: [{itemLabel: {value: label}, itemDesc: {value: 'English writer'}, image: {value: 'https://commons.wikimedia.org/wiki/Special:FilePath/Example.svg'}}],
		articles: [{article: {value: 'https://en.wikipedia.org/wiki/Douglas_Adams'}, articlelang: {value: 'en'}}],
		properties: [{property: {value: 'Occupation'}, value: {value: 'Writer'}}],
		values: [{property: {value: 'Website'}, valueUri: {value: 'https://example.test'}}],
		links: [{property: {value: 'Identifier'}, valueUri: {value: '42'}, fmt_URL: {value: 'https://example.test/$1'}, rankstr: {value: 'PreferredRank'}}],
	};
}

/** Serve extension files locally and mock only browser APIs and remote Wikidata responses. */
async function openPopup(options = {}) {
	const context = await browser.newContext({viewport: options.viewport ?? {width: 800, height: 600}, colorScheme: options.scheme ?? 'light'});
	const page = await context.newPage();
	if (options.slowCpu && process.env.TEST_BROWSER !== 'firefox') {
		const cdp = await context.newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
	}
	const errors = [];
	const requests = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(({messages, options, namespace}) => {
		const local = options.local ?? {languages: {data: [
			{lang: 'en', tongue: 'English', language: 'Language', entity: 'Entity'},
			{lang: 'ar', tongue: 'العربية', language: 'اللغة', entity: 'كيان'},
		]}};
		const sync = {IsoLanguage: 'en'};
		const icons = [];
		window.__store = {local, sync, icons};
		const storage = data => ({
			async getKeys() { return Object.keys(data); },
			async get(keys) {
				if (options.storageDelay) await new Promise(resolve => setTimeout(resolve, options.storageDelay));
				return keys === null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]));
			},
			async set(values) { Object.assign(data, structuredClone(values)); },
			async remove(keys) { for (const key of keys) delete data[key]; },
		});
		window[namespace] = {
			i18n: {getMessage: key => messages[key]?.message ?? key, getUILanguage: () => 'en'},
			storage: {local: storage(local), sync: storage(sync), onChanged: {addListener() {}}},
			tabs: {query: async () => [{id: 1, url: options.url ?? 'https://www.wikidata.org/wiki/Q42'}]},
			action: {setIcon: async icon => icons.push(icon)},
		};
	}, {messages, options, namespace: process.env.TEST_BROWSER === 'firefox' ? 'browser' : 'chrome'});
	await context.route('**/*', async route => {
		const url = new URL(route.request().url());
		if (url.hostname === 'extension.test') {
			const file = new URL('.' + url.pathname, root);
			if (!file.href.startsWith(root.href)) return route.abort();
			const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
			return route.fulfill({contentType: type, body: await readFile(fileURLToPath(file))});
		}
		if (url.hostname === 'commons.wikimedia.org') {
			return route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'800\' height=\'400\'><rect width=\'800\' height=\'400\' fill=\'#369\'/></svg>'});
		}
		requests.push(url.href);
		const query = url.searchParams.get('query') ?? '';
		if (options.failLookup && query.includes('P8966')) return route.fulfill({status: 503, body: 'Unavailable'});
		if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
		if (options.fail) return route.fulfill({status: 503, body: 'Unavailable'});
		const arabic = query.includes('"ar"') || query.includes('"ar,');
		if (options.delayEnglish && !arabic) await new Promise(resolve => setTimeout(resolve, options.delayEnglish));
		const matchedEntity = options.matches?.find(item => query.includes('/entity/' + item.id + '>'));
		const data = entityData(options.hostile ? '<img src=x onerror=alert(1)>' : arabic ? 'نتيجة جديدة' : matchedEntity?.label ?? 'Douglas Adams');
		let bindings = [];
		if (query.includes('SELECT DISTINCT ?itemLabel')) bindings = data.title;
		else if (query.includes('SELECT DISTINCT ?article')) bindings = data.articles;
		else if (query.includes('SELECT DISTINCT ?property ?value ')) bindings = options.properties ?? data.properties;
		else if (query.includes('SELECT DISTINCT ?property ?valueUri')) bindings = data.values;
		else if (query.includes('SELECT DISTINCT ?genProp')) bindings = data.links;
		else if (options.matches && query.includes('wikibase:qualifier')) bindings = options.matches.map(({id, label}) => ({iri: {value: 'http://www.wikidata.org/entity/' + id}, iriLabel: {value: label}}));
		else if (options.multiple) bindings = ['Q42', 'Q84'].map(id => ({iri: {value: 'http://www.wikidata.org/entity/' + id}, iriLabel: {value: id}}));
		try { await route.fulfill({json: {results: {bindings}}}); } catch { /* A superseded request can be aborted. */ }
	});
	await page.goto('http://extension.test/popup.html', {waitUntil: 'domcontentloaded'});
	return {context, page, requests, errors};
}

test('popup renders data, preserves links and gives the image its full width', async () => {
	const {context, page, errors} = await openPopup();
	await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelector('h1'));
	assert.equal(await page.textContent('h1'), 'Douglas Adams');
	assert.equal(await page.textContent('#boxLabel0'), 'Languages');
	assert.match(await page.textContent('#div1'), /Writer/);
	assert.equal(await page.getAttribute('#div3 a', 'href'), 'https://example.test/42');
	await page.waitForFunction(() => document.querySelector('.entity-image')?.naturalWidth > 0);
	const dimensions = await page.evaluate(() => ({image: document.querySelector('.entity-image').getBoundingClientRect().width, popup: document.querySelector('main').clientWidth}));
	assert.equal(dimensions.image, dimensions.popup);
	assert.deepEqual(await page.evaluate(() => ({width: document.body.clientWidth, height: document.body.clientHeight})), {width: 800, height: 600});
	assert.equal(await page.locator('#wdlogo, #div_footer1, #div_footer2').count(), 0);
	assert.deepEqual(errors, []);
	await context.close();
});

test('upstream #38: tracklists link to Wikidata and the listening page without duplicate rows', async () => {
	const track = {property: {value: 'Tracklist'}, value: {value: 'The Plenary'}, valueUri: {value: 'http://www.wikidata.org/entity/Q123'}, externalUrl: {value: 'https://music.yandex.ru/track/30124805'}};
	const {context, page} = await openPopup({properties: [track, track, {...track, externalUrl: {value: 'javascript:alert(1)'}}]});
	await page.waitForSelector('#div1 .property');
	assert.equal(await page.locator('#div1 .property').count(), 1);
	assert.equal(await page.getAttribute('#div1 strong a', 'href'), 'http://www.wikidata.org/entity/Q123');
	assert.equal(await page.locator('#div1 a').nth(1).getAttribute('href'), 'https://music.yandex.ru/track/30124805');
	assert.equal(await page.locator('#div1 a').count(), 2);
	await context.close();
});

test('the shell paints while network requests are pending, including with CPU throttling', async t => {
	const {context, page} = await openPopup({delay: 1500, slowCpu: true});
	assert.equal(await page.locator('#box0').isVisible(), true);
	assert.equal(await page.locator('h1').count(), 0);
	if (process.env.TEST_BROWSER !== 'firefox') {
		await page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
		const paint = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0].startTime);
		t.diagnostic('First contentful paint with 6× CPU throttling: ' + Math.round(paint) + ' ms');
		assert.ok(paint < 1000, 'Popup shell should paint before the delayed network data');
	}
	await context.close();
});

test('dropdowns and Refresh scroll with the results', async t => {
	const properties = Array.from({length: 30}, (_, index) => ({property: {value: 'Property ' + index}, value: {value: 'Example value'}}));
	const {context, page} = await openPopup({properties});
	t.after(() => context.close());
	await page.waitForSelector('.entity-image');
	await page.waitForFunction(() => document.querySelector('.entity-image').naturalWidth > 0);
	const before = await page.locator('header').boundingBox();
	await page.evaluate(() => { document.querySelector('.popup').scrollTop = document.querySelector('header').getBoundingClientRect().height + 20; });
	const after = await page.locator('header').boundingBox();
	assert.ok(after.y < before.y, 'Scrolling results must also move the header');
	for (const selector of ['#box0', '#box1', '#refresh']) {
		const control = await page.locator(selector).boundingBox();
		assert.ok(control.y + control.height <= 0, selector + ' must scroll out of view');
	}
});

test('a provisional popup viewport cannot trap the content at dropdown height', async t => {
	const local = {'result:entity:en:Q42': {savedAt: Date.now(), data: entityData('Cached title')}};
	const {context, page, requests} = await openPopup({viewport: {width: 320, height: 200}, local});
	t.after(() => context.close());
	await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelector('h1'));
	// Browser toolbar panels measure the document's preferred size after an initial layout.
	const preferred = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
		width: document.body.clientWidth, height: document.body.clientHeight,
	})))));
	await page.setViewportSize(preferred);
	const layout = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
		const results = document.querySelector('main').getBoundingClientRect();
		const title = document.querySelector('h1').getBoundingClientRect();
		resolve({width: innerWidth, height: innerHeight, resultsHeight: results.height, titleVisible: title.top >= results.top && title.bottom <= innerHeight});
	}))));
	assert.ok(layout.resultsHeight > 100, 'The panel must recover space for results after its initial small viewport');
	assert.deepEqual({width: layout.width, height: layout.height}, {width: 800, height: 600});
	assert.equal(layout.titleVisible, true);
	assert.equal(requests.length, 0);
});

test('a popup already constrained by the browser fits without waiting for another resize', async t => {
	const {context, page} = await openPopup({viewport: {width: 700, height: 450}});
	t.after(() => context.close());
	await page.waitForSelector('h1');
	const dimensions = await page.evaluate(() => {
		const popup = document.querySelector('.popup').getBoundingClientRect();
		return {width: popup.width, height: popup.height, bodyWidth: document.body.clientWidth, bodyHeight: document.body.clientHeight};
	});
	assert.deepEqual(dimensions, {width: 700, height: 450, bodyWidth: 800, bodyHeight: 600});
});

test('refresh bypasses cached entity data', async () => {
	const local = {'result:entity:en:Q42': {savedAt: Date.now(), data: entityData('Cached title')}};
	const {context, page, requests} = await openPopup({local});
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Cached title');
	await page.click('#refresh');
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Douglas Adams');
	assert.equal(requests.length, 5);
	await context.close();
});

test('dark mode uses the requested colors before slow requests finish', async () => {
	const {context, page} = await openPopup({scheme: 'dark', delay: 800, storageDelay: 200});
	assert.equal(await page.locator('#box0').isVisible(), true);
	const colors = await page.evaluate(() => ({background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color}));
	assert.deepEqual(colors, {background: 'rgb(0, 0, 0)', color: 'rgb(187, 187, 187)'});
	await context.close();
});

test('cached details render without any Wikidata requests', async () => {
	const local = {'result:entity:en:Q42': {savedAt: Date.now(), data: entityData()}};
	const {context, page, requests} = await openPopup({local});
	await page.waitForSelector('h1');
	assert.equal(await page.textContent('h1'), 'Douglas Adams');
	assert.equal(await page.textContent('#boxLabel0'), 'Languages');
	assert.equal(requests.length, 0);
	await context.close();
});

test('Archive.org displays its initial match immediately and keeps alternatives selectable', async t => {
	const {context, page, errors} = await openPopup({url: 'https://archive.org/', matches: archiveMatches});
	t.after(() => context.close());
	await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelector('h1')?.textContent === 'Internet Archive', undefined, {timeout: 3000});
	assert.equal(await page.inputValue('#box1'), 'Q461');
	assert.equal(await page.locator('#box1 option').count(), 4);
	assert.equal(await page.getAttribute('#div_wdlink a', 'href'), 'http://www.wikidata.org/entity/Q461');
	await page.selectOption('#box1', 'Q15745318');
	await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelector('h1')?.textContent === 'American Journalism', undefined, {timeout: 3000});
	assert.equal(await page.getAttribute('#div_wdlink a', 'href'), 'http://www.wikidata.org/entity/Q15745318');
	assert.deepEqual(errors, []);
});

test('cached Archive.org matches display the initial entity without Wikidata requests', async t => {
	const savedAt = Date.now();
	const local = {
		'result:page:en:https://archive.org/': {savedAt, data: archiveMatches},
		'result:entity:en:Q461': {savedAt, data: entityData('Internet Archive')},
	};
	const {context, page, requests, errors} = await openPopup({url: 'https://archive.org/', local});
	t.after(() => context.close());
	await page.waitForFunction(() => document.querySelector('#results').getAttribute('aria-busy') === 'false' && document.querySelector('h1')?.textContent === 'Internet Archive', undefined, {timeout: 3000});
	assert.equal(await page.inputValue('#box1'), 'Q461');
	assert.equal(await page.locator('#box1 option').count(), 4);
	assert.equal(requests.length, 0);
	assert.deepEqual(errors, []);
});

test('remote labels remain text, never markup', async () => {
	const {context, page, errors} = await openPopup({hostile: true});
	await page.waitForSelector('h1');
	assert.equal(await page.textContent('h1'), '<img src=x onerror=alert(1)>');
	assert.equal(await page.locator('h1 img').count(), 0);
	assert.deepEqual(errors, []);
	await context.close();
});

test('language changes cancel old responses and update text direction', async () => {
	const {context, page, errors} = await openPopup({delayEnglish: 250});
	await page.waitForSelector('#box0 option[value=ar]', {state: 'attached'});
	await page.selectOption('#box0', 'ar');
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'نتيجة جديدة');
	await page.waitForTimeout(300);
	assert.equal(await page.textContent('h1'), 'نتيجة جديدة');
	assert.equal(await page.getAttribute('#results', 'dir'), 'rtl');
	assert.equal(await page.textContent('#boxLabel0'), 'Languages');
	assert.deepEqual(errors, []);
	await context.close();
});

test('no results produce a grayscale icon and safe localized guidance', async () => {
	const {context, page} = await openPopup({url: 'https://example.test/no-match'});
	await page.waitForFunction(() => document.querySelector('#div_wdlink').textContent.includes('No result'));
	assert.equal(await page.locator('#box1').isDisabled(), true);
	assert.match(await page.evaluate(() => window.__store.icons.at(-1).path[16]), /gray/);
	await context.close();
});

test('failed requests stop the spinner and leave refresh available', async () => {
	const {context, page} = await openPopup({fail: true});
	await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Could not load'));
	assert.equal(await page.locator('#searchSpinner').isVisible(), false);
	assert.equal(await page.locator('#refresh').isEnabled(), true);
	await context.close();
});

test('partial page matches remain usable but are not cached as complete results', async () => {
	const {context, page} = await openPopup({url: 'https://example.test/items', multiple: true, failLookup: true});
	await page.waitForFunction(() => document.querySelector('#box1').options.length === 3 && document.querySelector('#results').getAttribute('aria-busy') === 'false');
	assert.equal(await page.locator('#box1').isEnabled(), true);
	assert.match(await page.textContent('#status'), /Some matching results/);
	assert.equal(await page.evaluate(() => Object.keys(window.__store.local).some(key => key.startsWith('result:page:'))), false);
	await context.close();
});

test('empty entity selection does not send malformed SPARQL queries', async () => {
	const {context, page, requests, errors} = await openPopup({url: 'https://example.test/items', multiple: true});
	await page.waitForFunction(() => document.querySelector('#box1').options.length === 3 && document.querySelector('#results').getAttribute('aria-busy') === 'false');
	const count = requests.length;
	await page.selectOption('#box1', '');
	assert.equal(requests.length, count);
	assert.deepEqual(errors, []);
	await context.close();
});
