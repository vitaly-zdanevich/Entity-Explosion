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

test('Firefox installs manifest.json unchanged and initializes its popup and module background', {
	skip: process.env.TEST_BROWSER !== 'firefox' || process.platform === 'win32',
}, async () => {
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
		], {stdio: 'ignore'});
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
		let result;
		for (let attempt = 0; attempt < 100; attempt++) {
			result = await client.evaluate(frame.consoleActor, 'JSON.stringify(window.__smoke)');
			if (typeof result === 'string') break;
			await delay(50);
		}
		assert.deepEqual(JSON.parse(result), {
			status: 'Open a website to look up its entity.', width: 800, height: 600,
			language: 'en', backgroundModule: 'module', shortcut: 'Alt+Shift+E', storageKeys: true,
			savedLanguage: 'en',
		});
	} finally {
		client?.socket.destroy();
		if (child?.pid && child.exitCode === null && child.signalCode === null) {
			const stopped = once(child, 'exit');
			child.kill();
			await stopped;
		}
		await rm(temp, {recursive: true, force: true});
	}
});
