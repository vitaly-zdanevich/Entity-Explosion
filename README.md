# Entity Explosion
A browser extension for Chrome/Chromium and Firefox.

This is a fork of [99of9/Entity-Explosion](https://github.com/99of9/Entity-Explosion),
originally created by Toby Hudson. As of October 2026, upstream has gone more than
two years without a code update: its
[latest commit was on May 22, 2024](https://github.com/99of9/Entity-Explosion/commit/d2cbff9dba3afcb6099b8583c58f6b39e56703ff).
This fork addresses existing problems, including responses from older requests
overwriting newer selections, incorrect formatter handling, and the cost of
loading legacy UI libraries. It also adds automated tests and improvements for
current Chrome/Chromium and Firefox releases.

The following store listings and demo refer to the original project:

Available free for Chrome: https://chrome.google.com/webstore/detail/entity-explosion/bbcffeclligkmfiocanodamdjclgejcn
and for Firefox: https://addons.mozilla.org/en-US/firefox/addon/entity-explosion/

Further information and demo video: https://www.wikidata.org/wiki/Wikidata:Entity_Explosion

This fork uses native JavaScript modules and a small local stylesheet. It targets
current Chrome/Chromium and Firefox releases, with no jQuery, Bootstrap, or icon
font.

The popup renders its controls before network requests complete. Cached results
avoid repeated Wikidata requests; uncached results still depend on the service's
response time. The extension caches:

| Data | Freshness / lifetime | Storage |
| --- | --- | --- |
| Page-to-entity matches, including confirmed empty results, per language | 5 minutes | Local, persistent |
| Entity details, per language | 5 minutes | Local, persistent |
| URL matching rules and language translations | 7 days, checked when the background starts | Local, persistent |
| Toolbar match calculations | Until background shutdown or metadata refresh; at most 128 URLs | Memory |
| Selected language | Until changed or extension data is cleared | Browser settings storage |

Page matches and entity details share a limit of 24 entries, each at most
200,000 UTF-8 bytes. Expired results are ignored and removed on subsequent cache
writes. Incomplete or failed responses are not cached as complete results.
**Refresh** bypasses the five-minute result cache. The background retains stale
matching metadata if its refresh fails. Images use the browser's HTTP cache;
the extension does not set their expiration time.

The toolbar uses a grayscale Wikidata icon for unrecognized pages and a color
icon for likely matches; opening the popup updates it with the lookup result.

Press **Alt+Shift+E** to open the popup. You can change this shortcut at
`chrome://extensions/shortcuts` or Firefox's **Manage Extension Shortcuts** menu.
See the [Firefox shortcut instructions](https://support.mozilla.org/en-US/kb/manage-extension-shortcuts-firefox).

The following upstream reports are covered by regression tests in this fork:

| Report | Change |
| --- | --- |
| [#42](https://github.com/99of9/Entity-Explosion/issues/42) | Configurable popup shortcut in Chrome and Firefox |
| [#40](https://github.com/99of9/Entity-Explosion/issues/40) | Lutris formatter matching with anchored identifier expressions |
| [#38](https://github.com/99of9/Entity-Explosion/issues/38) | Clickable Wikidata tracklist entries and available listening links; nested Yandex track URLs resolve their album |
| [#37](https://github.com/99of9/Entity-Explosion/issues/37), [#30](https://github.com/99of9/Entity-Explosion/issues/30) | Official-site URL variants, including trailing slashes, and combined lookup results |
| [#35](https://github.com/99of9/Entity-Explosion/issues/35) | CrazyGames URLs stored as statement qualifiers |
| [#31](https://github.com/99of9/Entity-Explosion/issues/31) | Normal-rank YouTube IDs remain searchable when preferred IDs also exist |
| [#29](https://github.com/99of9/Entity-Explosion/issues/29) | Instagram URL patterns and optional trailing slashes |
| [#28](https://github.com/99of9/Entity-Explosion/issues/28), [#27](https://github.com/99of9/Entity-Explosion/issues/27) | Stack Overflow / Stack Exchange profile URLs with display-name suffixes |
| [#24](https://github.com/99of9/Entity-Explosion/issues/24), [#22](https://github.com/99of9/Entity-Explosion/issues/22) | MobyGames and MyAbandonware identifier extraction from Wikidata URL patterns |

Tracklist links depend on identifiers and URLs present in Wikidata. A track
without a Yandex identifier still links to its Wikidata item and other available
sites. URL matching uses [P8966](https://www.wikidata.org/wiki/Property:P8966)
and its [P8967](https://www.wikidata.org/wiki/Property:P8967) capture replacements,
alongside formatter URLs. Rules are indexed by domain and compiled on demand.

Dark mode follows `prefers-color-scheme`, using `#000` backgrounds and `#bbb`
text. Entity images use the full popup width while keeping their aspect ratio.
The popup requests the browser's maximum 800 × 600 pixel size, with controls and
results scrolling together. Smaller screens or Firefox's overflow menu can limit
the available space; see the [popup sizing documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups).

For local development, load this directory as an unpacked Chrome extension.
For Firefox, open `about:debugging#/runtime/this-firefox`, click **Load Temporary
Add-on**, and select this directory's `manifest.json`. Both browsers use the same
manifest; no file replacement or build step is needed.
See the [Chrome extension loading instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
and [Firefox temporary installation instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).
The shared manifest declares both supported
[background entry points](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background#cross-browser_manifest_v3_background_scripts).

Run the tests with Node.js 24 or later:

```sh
npm ci
npm run test:coverage
npx playwright install --with-deps chromium firefox
npm run test:browser
TEST_BROWSER=firefox npm run test:browser
```

Unit tests cover query escaping, URL matching, formatter selection, caching and
background events. Browser tests use mocked extension APIs and Wikidata data to
check rendering, cancellation, caching, dark mode, images and error handling.
Chromium also loads the unpacked extension and checks its real toolbar popup on
large and small screens. On Linux/macOS, Firefox installs the same `manifest.json`
unchanged and checks popup initialization, saved preferences, and its module background through a local
debugging socket. Package checks follow module imports and validate the icon
files referenced by both manifests.
GitHub Actions runs these checks on pushes and pull requests using Node.js 24.
See the [Playwright browser documentation](https://playwright.dev/docs/browsers)
and [Node.js test runner documentation](https://nodejs.org/api/test.html).

The toolbar artwork is derived from the
[Wikidata logo](https://commons.wikimedia.org/wiki/File:Wikidata-logo.svg).
Editable SVG sources and generated PNG sizes are in `images/`. To regenerate:

```sh
for variant in color gray; do
	for size in 16 32 48 128; do
		rsvg-convert -w "$size" -h "$size" "images/wikidata-$variant.svg" -o "images/wikidata-$variant-$size.png"
	done
done
```
