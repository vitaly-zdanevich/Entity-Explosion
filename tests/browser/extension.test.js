import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

/** Evaluate inside Chrome's toolbar popup, which Playwright does not expose as a normal Page. */
async function evaluatePopup(client, targetId, expression) {
	const {sessionId} = await client.send('Target.attachToTarget', {targetId, flatten: false});
	try {
		const response = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Popup evaluation timed out')), 5000);
			const listener = event => {
				const message = JSON.parse(event.message);
				if (event.sessionId === sessionId && message.id === 1) {
					clearTimeout(timer);
					client.off('Target.receivedMessageFromTarget', listener);
					if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)));
					else resolve(message.result.result.value);
				}
			};
			client.on('Target.receivedMessageFromTarget', listener);
		});
		await client.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({
			id: 1, method: 'Runtime.evaluate', params: {expression, returnByValue: true, awaitPromise: true},
		})});
		return await response;
	} finally {
		await client.send('Target.detachFromTarget', {sessionId});
	}
}

for (const screenHeight of [1000, 600]) {
	test('the installed toolbar popup fits a 1280 by ' + screenHeight + ' screen', {skip: process.env.TEST_BROWSER === 'firefox'}, async () => {
		const profile = await mkdtemp(join(tmpdir(), 'entity-explosion-test-'));
		const extension = fileURLToPath(new URL('../../', import.meta.url));
		let context;
		try {
			context = await chromium.launchPersistentContext(profile, {
				headless: true,
				viewport: {width: 1280, height: 1000},
				channel: process.env.BROWSER_EXECUTABLE ? undefined : 'chromium',
				executablePath: process.env.BROWSER_EXECUTABLE || undefined,
				ignoreDefaultArgs: ['--disable-extensions'],
				args: ['--screen-info={1280x' + screenHeight + '}', '--disable-extensions-except=' + extension, '--load-extension=' + extension, '--host-resolver-rules=MAP query.wikidata.org ~NOTFOUND'],
			});
			const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
			const commands = await worker.evaluate(() => chrome.commands.getAll());
			assert.equal(commands.find(command => command.name === '_execute_action')?.shortcut, 'Alt+Shift+E');
			assert.equal(await worker.evaluate(async () => Array.isArray(await chrome.storage.local.getKeys())), true);
			await worker.evaluate(() => chrome.action.openPopup());
			const client = await context.newCDPSession(context.pages()[0]);
			const {targetInfos} = await client.send('Target.getTargets');
			const popup = targetInfos.find(target => target.url.endsWith('/popup.html'));
			assert.ok(popup, 'The browser action must have an actual popup target');
			const dimensions = await evaluatePopup(client, popup.targetId, `
				(async () => {
					// Storage and tab reads can finish after the first two paints on CI.
					const deadline = performance.now() + 3000;
					while (!document.querySelector('#status')?.textContent && performance.now() < deadline) {
						await new Promise(requestAnimationFrame);
					}
					await new Promise(requestAnimationFrame);
					const panel = document.querySelector('.popup').getBoundingClientRect();
					return {
						width: innerWidth, height: innerHeight,
						bodyWidth: document.body.clientWidth, bodyHeight: document.body.clientHeight,
						panelWidth: panel.width, panelHeight: panel.height,
						status: document.querySelector('#status').textContent,
					};
				})()
			`);
			assert.deepEqual(dimensions, {
				width: 800, height: dimensions.height, bodyWidth: 800, bodyHeight: 600,
				panelWidth: 800, panelHeight: dimensions.height,
				status: 'Open a website to look up its entity.',
			});
			if (screenHeight === 1000) assert.equal(dimensions.height, 600);
			else assert.ok(dimensions.height > 300 && dimensions.height < 600, 'The popup must fit below the toolbar on a short screen');
		} finally {
			await context?.close();
			await rm(profile, {recursive: true, force: true});
		}
	});
}
