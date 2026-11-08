# Developing @site-shot/node-red-siteshot

For maintainers. Users read the [README](README.md) and the node help in the editor.

## Layout

- `nodes/site-shot.js` - the runtime side of both nodes: the `site-shot-account` config node and the `site-shot-screenshot` node.
- `nodes/site-shot.html` - their editor definitions, edit dialogs and help. The help is the reference for settings, message properties and error codes; keep it in step with the code.
- `examples/` - the flows that **Import > Examples** lists for the package. The file name is the menu entry.
- `test/` - tests run with `node:test` and the official `node-red-node-test-helper`. They are not published: `files` in `package.json` limits the package to `nodes/` and `examples/`, besides `package.json`, the README and the LICENSE.

## The capture contract

The node implements the image mode of the published capture API, <https://www.site-shot.com/openapi-capture.json>: `GET https://api.site-shot.com/` with `url`, `userkey`, `format` (`png` or `jpeg`), `response_type=image`, `full_size` (`1` or `0`), and optionally `width` (100 to 8000), `height` and `max_height` (100 to 20000; `max_height` only with `full_size=1`).

- Success is HTTP 200 with an `image/png` or `image/jpeg` body. The node passes an answer on only when it is HTTP 200, its content type is the chosen format's, and its first bytes are that format's signature. It does not decode the image, so a damaged image that starts correctly would pass.
- A failed capture comes with a placeholder image and HTTP 403 or 404; the node discards it. HTTP 401 means an unknown key, and HTTP 429 the plan's limit of captures at the same time.
- The endpoint is fixed in the code: the API key may only go to Site-Shot. There is no setting for another endpoint or a proxy.

## Tests

```sh
npm ci
npm test
```

The tests use Node.js 24.10.0, whose `fetch` is undici 7.16.0, the version pinned in `devDependencies` for the request mock.

The package supports Node-RED 4.0 and later on Node.js 20.3 and later (`AbortSignal.any` is the newest API the node uses). To run the suite against Node-RED 4, for example in the `nodered/node-red:4.1` image (Node.js 20), install `node-red@4.1.12 node-red-node-test-helper@0.3.6 undici@7.16.0` without saving and run `node --require ./test/support/no-network.js --test --test-concurrency=1 test/*.test.js` (Node.js 20 does not expand the quoted glob in `npm test`). Example flows must not use JSONata functions that older Node-RED 4 releases lack, such as `$moment`.

- Nothing in a test run can reach the network. `npm test` preloads `test/support/no-network.js` into every test process: it refuses TCP and TLS connections other than loopback, every DNS query, and UDP. Each test file asserts at the end that it refused nothing, so all requests went to the mock; `test/no-network.test.js` checks that the guard is loaded and works.
- `test/support/site-shot-api.js` answers `https://api.site-shot.com` with an undici `MockAgent` and records every request.
- The images in `test/fixtures/` are synthetic, made with ImageMagick, and the API key in the tests is a dummy.

What the files cover:

- `screenshot.test.js` - the request and its parameters, the output, refusals before any request, HTTP errors, redirects, non-image answers, size and time limits, secrecy of the key, the queue, and stopping and redeploying.
- `examples.test.js` - the example files, and both examples run with the built-in nodes, down to the bytes of the files they write.
- `package.test.js` - the package metadata, the editor definitions and help, and the registration in the runtime.

## Checking the package in a real Node-RED

The tests run the nodes in the runtime, but not the editor's loading of the package. To check that, without capturing anything:

1. `npm pack --pack-destination <tmp>` and look at the file list.
2. Make a throwaway user directory, `npm install --offline <tmp>/site-shot-node-red-siteshot-<version>.tgz` in it, and give it a `settings.js` with `uiHost: '127.0.0.1'`, a test-only `credentialSecret` and `telemetry: { enabled: false }`.
3. Start `node node_modules/node-red/red.js --userDir <dir>` from this package, with `NODE_OPTIONS=--require <path to test/support/no-network.js>` so that it cannot reach the network.
4. Check `GET /nodes` (JSON and HTML), `GET /library/examples/flows/@site-shot/node-red-siteshot/`, and a deploy of the examples with a dummy key: the key must not appear in `GET /flows`, `flows.json` or `flows_cred.json`. Do not click the inject nodes.
5. Stop Node-RED and delete the directory.

## Releasing

Releasing is up to the owner of the Site-Shot npm scope, in this order:

1. Capture a public test page with a real key in a real Node-RED, with both formats, viewport and full page, and an error case. The tests above never contact Site-Shot.
2. Set the version, bring the status and install sections of the README up to date, run `npm test`, check `npm pack --dry-run`, and publish with `npm publish --access public` from an account of the `@site-shot` npm scope, with two-factor authentication.
3. The Node-RED Flow Library does not pick up new packages by itself: submit the package at <https://flows.nodered.org/add/node> and meet the requirements listed there. `package.json` has no `repository` field yet, because the source has no public repository yet.
