import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);

/** Follow local module imports to catch files omitted from either browser package. */
async function checkModule(path, visited = new Set()) {
	if (visited.has(path)) return;
	visited.add(path);
	const url = new URL(path, root);
	const source = await readFile(url, 'utf8');
	for (const match of source.matchAll(/\bfrom\s+'(\.\/[^']+)'/g)) {
		await checkModule(new URL(match[1], url).href, visited);
	}
}

for (const filename of ['manifest.json', 'manifestFF.json']) {
	test(filename + ' ships its popup, background modules and correctly sized icons', async () => {
		const manifest = JSON.parse(await readFile(new URL(filename, root), 'utf8'));
		const popup = await readFile(new URL(manifest.action.default_popup, root), 'utf8');
		for (const match of popup.matchAll(/(?:src|href)='([^']+\.(?:js|css))'/g)) {
			if (match[1].endsWith('.js')) await checkModule(match[1]);
			else await readFile(new URL(match[1], root));
		}
		for (const path of new Set([manifest.background.service_worker, ...(manifest.background.scripts ?? [])].filter(Boolean))) {
			await checkModule(path);
		}
		for (const [size, path] of [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)]) {
			const png = await readFile(new URL(path, root));
			assert.equal(png.toString('ascii', 1, 4), 'PNG');
			assert.equal(png.readUInt32BE(16), Number(size));
			assert.equal(png.readUInt32BE(20), Number(size));
		}
	});
}
