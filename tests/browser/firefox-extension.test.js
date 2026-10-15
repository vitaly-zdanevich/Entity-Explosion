import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {cp, mkdtemp, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {firefox} from 'playwright';

/** Exchange length-prefixed JSON packets with Firefox's local DevTools socket. */
function debuggerClient(path) {
	const socket = net.connect(path);
	const queued = [];
	const waiting = new Set();
	let buffer = Buffer.alloc(0);
	const fail = error => {
		for (const item of waiting) item.reject(error);
	};
	socket.on('error', fail);
	socket.on('close', () => fail(new Error('Firefox debugger closed')));
	socket.on('data', bytes => {
		buffer = Buffer.concat([buffer, bytes]);
		while (true) {
			const colon = buffer.indexOf(':');
			if (colon < 0) return;
			const length = Number(buffer.subarray(0, colon));
			if (buffer.length < colon + 1 + length) return;
			const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
			buffer = buffer.subarray(colon + 1 + length);
			const item = [...waiting].find(item => item.predicate(packet));
			if (item) item.resolve(packet);
			else queued.push(packet);
		}
	});
	const wait = predicate => {
		const index = queued.findIndex(predicate);
		if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); waiting.delete(item); };
			const item = {
				predicate,
				resolve: value => { cleanup(); resolve(value); },
				reject: error => { cleanup(); reject(error); },
			};
			const timer = setTimeout(() => item.reject(new Error('Firefox debugger response timed out')), 5000);
			waiting.add(item);
		});
	};
	const send = async (to, type, params = {}) => {
		const json = JSON.stringify({to, type, ...params});
		const reply = wait(packet => packet.from === to && !packet.type);
		socket.write(Buffer.byteLength(json) + ':' + json);
		const result = await reply;
		if (result.error) throw new Error(JSON.stringify(result));
		return result;
	};
	return {
		socket, wait, send,
		async evaluate(actor, text) {
			const {resultID} = await send(actor, 'evaluateJSAsync', {text});
			const result = await wait(packet => packet.resultID === resultID);
			assert.equal(result.hasException, false, result.exceptionMessage);
			return result.result;
		},
	};
}

/** Poll browser state without assuming a fixed startup or popup animation time. */
async function evaluateUntil(client, actor, expression, ready) {
	let result;
	for (let attempt = 0; attempt < 100; attempt++) {
		result = await client.evaluate(actor, expression);
		if (ready(result)) return result;
		await delay(50);
	}
	assert.fail('Firefox did not reach the expected state: ' + JSON.stringify(result));
}

/** Install the unchanged extension and exercise its real toolbar panel. */
async function checkFirefoxPopup(screenHeight) {
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const temp = await mkdtemp(join(tmpdir(), 'entity-explosion-firefox-'));
	const profile = join(temp, 'profile');
	const extension = join(temp, 'extension');
	const socketPath = join(temp, 'debugger.socket');
	let child;
	let client;
	try {
		await mkdir(profile);
		await cp(root, extension, {
			recursive: true,
			filter: path => !['.git', 'node_modules', '.agents', '.codex', '.aws', 'tests'].some(name => path === join(root, name)),
		});
		const prefs = {
			'devtools.debugger.remote-enabled': true,
			'devtools.chrome.enabled': true,
			'devtools.debugger.prompt-connection': false,
			'browser.shell.checkDefaultBrowser': false,
			'browser.startup.homepage_override.mstone': 'ignore',
			'browser.startup.page': 0,
			// Keep this smoke test independent of the public query service.
			'network.dns.localDomains': 'query.wikidata.org',
		};
		await writeFile(join(profile, 'user.js'), Object.entries(prefs).map(([key, value]) => 'user_pref(' + JSON.stringify(key) + ', ' + JSON.stringify(value) + ');').join('\n'));
		child = spawn(process.env.BROWSER_EXECUTABLE || firefox.executablePath(), [
			'--no-remote', '--headless', '--profile', profile,
			'--start-debugger-server', socketPath, 'about:blank',
		], {
			stdio: 'ignore',
			env: {...process.env, MOZ_HEADLESS_WIDTH: '1280', MOZ_HEADLESS_HEIGHT: String(screenHeight)},
		});
		let launchError;
		child.on('error', error => { launchError = error; });
		for (let attempt = 0; attempt < 100; attempt++) {
			if (launchError) throw launchError;
			if (await stat(socketPath).catch(() => false)) break;
			await delay(50);
		}
		client = debuggerClient(socketPath);
		await once(client.socket, 'connect');
		await client.wait(packet => packet.from === 'root');
		const actors = await client.send('root', 'getRoot');
		const {addon: installed} = await client.send(actors.addonsActor, 'installTemporaryAddon', {addonPath: extension, openDevTools: false});
		const addon = (await client.send('root', 'listAddons')).addons.find(addon => addon.id === installed.id);
		assert.equal(addon.backgroundScriptStatus, 'RUNNING');
		assert.deepEqual(addon.warnings, []);
		const tab = (await client.send('root', 'listTabs')).tabs[0];
		await client.send(tab.actor, 'navigateTo', {url: addon.manifestURL.replace('manifest.json', 'popup.html'), waitForLoad: true});
		const {frame} = await client.send(tab.actor, 'getTarget');
		await evaluateUntil(client, frame.consoleActor, 'document.querySelector(\'#status\')?.textContent', value => typeof value === 'string' && value.length > 0);
		await client.evaluate(frame.consoleActor, `(async () => {
			const background = await browser.runtime.getBackgroundPage();
			const commands = await browser.commands.getAll();
			await browser.storage.sync.set({IsoLanguage: 'en'});
			window.__smoke = {
				status: document.querySelector('#status').textContent,
				width: document.body.clientWidth, height: document.body.clientHeight,
				language: document.querySelector('#box0').value,
				backgroundModule: background.document.querySelector('script')?.type,
				shortcut: commands.find(command => command.name === '_execute_action')?.shortcut,
				storageKeys: Array.isArray(await browser.storage.local.getKeys()),
				savedLanguage: (await browser.storage.sync.get('IsoLanguage')).IsoLanguage,
			};
		})()`);
		const result = await evaluateUntil(client, frame.consoleActor, 'JSON.stringify(window.__smoke)', value => typeof value === 'string');
		assert.deepEqual(JSON.parse(result), {
			status: 'Open a website to look up its entity.', width: 800, height: 600,
			language: 'en', backgroundModule: 'module', shortcut: 'Alt+Shift+E', storageKeys: true,
			savedLanguage: 'en',
		});

		// Inspect the browser-owned panel as well as its extension document: Firefox
		// can clip the panel without updating the document's innerHeight.
		const {processDescriptor} = await client.send('root', 'getProcess', {id: 0});
		const {process: parentTarget} = await client.send(processDescriptor.actor, 'getTarget');
		await client.evaluate(parentTarget.consoleActor, `Services.wm.getMostRecentWindow('navigator:browser').resizeTo(1280, ${Math.min(900, screenHeight)})`);
		await client.evaluate(frame.consoleActor, `browser.action.openPopup().then(() => window.__popupOpened = true, error => window.__popupOpened = String(error))`);
		await evaluateUntil(client, frame.consoleActor, 'window.__popupOpened', value => value === true);
		const panel = JSON.parse(await evaluateUntil(client, parentTarget.consoleActor, `JSON.stringify((() => {
			const win = Services.wm.getMostRecentWindow('navigator:browser');
			const panel = win.document.querySelector('#customizationui-widget-panel');
			const view = panel?.querySelector('panelview');
			if (panel?.state !== 'open' || !view) return null;
			const bounds = view.getBoundingClientRect();
			return {width: bounds.width, height: bounds.height, top: win.mozInnerScreenY + bounds.top};
		})())`, value => typeof value === 'string' && JSON.parse(value)?.height > 100));
		await evaluateUntil(client, frame.consoleActor, `browser.extension.getViews({type: 'popup'}).some(win => win.mozInnerScreenY === ${panel.top})`, value => value === true);
		await client.evaluate(frame.consoleActor, `(() => {
			const win = browser.extension.getViews({type: 'popup'})[0];
			const fixture = win.document.createElement('div');
			fixture.style.height = '1200px';
			const marker = win.document.createElement('p');
			marker.textContent = 'Final result';
			win.document.querySelector('main').append(fixture, marker);
			win.requestAnimationFrame(() => {
				const popup = win.document.querySelector('.popup');
				popup.scrollTop = popup.scrollHeight;
				win.requestAnimationFrame(() => {
					const bounds = popup.getBoundingClientRect();
					window.__popupLayout = {
						width: bounds.width, height: bounds.height,
						bodyWidth: win.document.body.clientWidth, bodyHeight: win.document.body.clientHeight,
						markerTop: marker.getBoundingClientRect().top, markerBottom: marker.getBoundingClientRect().bottom,
						scrollTop: popup.scrollTop,
					};
				});
			});
		})()`);
		const layout = JSON.parse(await evaluateUntil(client, frame.consoleActor, 'JSON.stringify(window.__popupLayout)', value => typeof value === 'string'));
		assert.equal(layout.bodyWidth, 800);
		assert.equal(layout.bodyHeight, 600);
		assert.equal(layout.width, 800);
		assert.ok(layout.height <= panel.height, `Popup layout ${layout.height}px exceeds its visible Firefox panel ${panel.height}px`);
		assert.ok(layout.height >= panel.height - 2, 'Popup uses the available panel height');
		if (screenHeight === 1000) assert.equal(layout.height, 600);
		else assert.ok(layout.height < 600, 'A short screen constrains the visible popup');
		assert.ok(layout.scrollTop > 0, 'Long results scroll');
		assert.ok(layout.markerTop >= 0 && layout.markerBottom <= layout.height, 'The final result remains visible after scrolling');
	} finally {
		client?.socket.destroy();
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			const stopped = once(child, 'exit');
			child.kill();
			await stopped;
		}
		await rm(temp, {recursive: true, force: true});
	}
}

for (const screenHeight of [1000, 600]) {
	test(`Firefox installs manifest.json unchanged and fits its toolbar popup to a 1280×${screenHeight} screen`, {
		skip: process.env.TEST_BROWSER !== 'firefox' || process.platform === 'win32',
	}, () => checkFirefoxPopup(screenHeight));
}
