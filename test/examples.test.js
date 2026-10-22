'use strict';

// The example flows: safe to share and to import, and they do what their
// comments say when run in the Node-RED runtime with the built-in nodes, against
// the mocked Site-Shot API. Only the debug nodes are swapped for test helper
// nodes, to see what reaches them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, afterEach, beforeEach, describe, it } = require('node:test');
const helper = require('node-red-node-test-helper');
const siteShotNodes = require('../nodes/site-shot.js');
const { BLUE_PNG, KEY, PLACEHOLDER_PNG, PNG, RED_PNG, settle, until } = require('./support/fixtures.js');
const { refusals } = require('./support/no-network.js');
const { SiteShotApi } = require('./support/site-shot-api.js');

helper.init(require.resolve('node-red'));

const CORE = path.join(path.dirname(require.resolve('@node-red/nodes/package.json')), 'core');
const coreNodes = ['common/20-inject.js', 'common/90-comment.js', 'sequence/17-split.js', 'storage/10-file.js']
    .map((file) => require(path.join(CORE, file)));

const EXAMPLES = path.join(__dirname, '..', 'examples');
const examples = fs.readdirSync(EXAMPLES).filter((file) => file.endsWith('.json')).sort()
    .map((file) => ({ file, flow: JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), 'utf8')) }));

const ofType = (flow, type) => flow.filter((node) => node.type === type);
const only = (flow, type) => {
    const nodes = ofType(flow, type);
    assert.equal(nodes.length, 1, type);
    return nodes[0];
};
const wiredFrom = (flow, node) => flow.find((other) => other.id === node.wires[0][0]);

/** Every property name in a value, at any depth. */
function propertyNames(value) {
    if (value === null || typeof value !== 'object') {
        return [];
    }
    return Object.entries(value).flatMap(([name, inner]) => [name, ...propertyNames(inner)]);
}

after(() => {
    assert.deepEqual(refusals, [], 'the network guard refused a connection');
});

describe('the example files', () => {
    it('are the two examples the editor lists for the package', () => {
        assert.deepEqual(examples.map((example) => example.file), ['01 - Capture one page to a file.json', '02 - Capture a list of pages to files.json']);
    });

    it('share one account node, so the API key is entered once', () => {
        const accounts = examples.map(({ flow }) => only(flow, 'site-shot-account'));
        assert.deepEqual(accounts[0], accounts[1]);
        assert.deepEqual(Object.keys(accounts[0]).sort(), ['id', 'name', 'type']);
    });

    for (const { file, flow } of examples) {
        describe(file, () => {
            it('holds no credentials, and only built-in nodes besides the Site-Shot ones', () => {
                const allowed = ['catch', 'comment', 'debug', 'file', 'inject', 'site-shot-account', 'site-shot-screenshot', 'split'];
                for (const node of flow) {
                    assert.ok(allowed.includes(node.type), node.type);
                }
                const names = propertyNames(flow).map((name) => name.toLowerCase());
                for (const secret of ['credentials', 'apikey', 'userkey', 'password']) {
                    assert.equal(names.includes(secret), false, secret);
                }
            });

            it('is one flow whose wires all lead to its own nodes', () => {
                const ids = new Set(flow.map((node) => node.id));
                assert.equal(ids.size, flow.length);
                const flowNodes = flow.filter((node) => node.type !== 'site-shot-account');
                assert.equal(new Set(flowNodes.map((node) => node.z)).size, 1);
                assert.equal(ids.has(flowNodes[0].z), false, 'no tab node: the import goes into the current flow');
                for (const node of flowNodes) {
                    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), node.id);
                    for (const target of node.wires.flat()) {
                        assert.ok(ids.has(target), `${node.id} -> ${target}`);
                    }
                }
            });

            it('runs only when its inject button is clicked', () => {
                for (const inject of ofType(flow, 'inject')) {
                    assert.deepEqual([inject.once, inject.repeat, inject.crontab], [false, '', '']);
                }
            });

            it('sends the screenshot to a file node and the failures to a debug node', () => {
                const account = only(flow, 'site-shot-account');
                const screenshot = only(flow, 'site-shot-screenshot');
                assert.equal(screenshot.account, account.id);
                const file = wiredFrom(flow, screenshot);
                assert.equal(file.type, 'file');
                assert.deepEqual([file.filenameType, file.overwriteFile, file.createDir, file.appendNewline, file.encoding], ['jsonata', 'true', true, false, 'none']);
                assert.equal(wiredFrom(flow, file).type, 'debug');
                const caught = only(flow, 'catch');
                assert.deepEqual(caught.scope, [screenshot.id, file.id]);
                assert.equal(wiredFrom(flow, caught).type, 'debug');
                assert.match(only(flow, 'comment').info, /paid plan/);
            });
        });
    }
});

describe('the examples at work', () => {
    let api;
    let workDir;

    beforeEach(() => {
        api = new SiteShotApi();
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-shot-examples-'));
        helper.settings({ fileWorkingDirectory: workDir });
    });

    afterEach(async () => {
        try {
            await helper.unload();
            helper.settings({});
            await api.close();
        } finally {
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    });

    /** Loads an example with an API key, and collects what reaches its two debug nodes. */
    async function load(flow) {
        const screenshot = only(flow, 'site-shot-screenshot');
        const written = wiredFrom(flow, wiredFrom(flow, screenshot));
        const failed = wiredFrom(flow, only(flow, 'catch'));
        const runnable = flow.map((node) => (node.type === 'debug' ? { id: node.id, type: 'helper', z: node.z, x: node.x, y: node.y } : node));
        await helper.load([siteShotNodes, ...coreNodes], runnable, { [only(flow, 'site-shot-account').id]: { apiKey: KEY } });
        const seen = { written: [], failed: [], events: [] };
        helper.getNode(written.id).on('input', (msg) => seen.written.push(msg));
        helper.getNode(failed.id).on('input', (msg) => seen.failed.push(msg));
        // The order of capture requests and finished messages shows how many captures ran at once.
        api.onRequest = (request) => seen.events.push(`request ${request.url.searchParams.get('url')}`);
        const node = helper.getNode(screenshot.id);
        const complete = node._complete;
        node._complete = function (msg, error) {
            seen.events.push(`done ${msg.siteshot ? msg.siteshot.url : msg.payload}${error ? ` ${error.code}` : ''}`);
            return complete.call(this, msg, error);
        };
        await settle(100);
        assert.equal(api.requests.length, 0, 'nothing runs when the flow is deployed');
        return { seen, inject: helper.getNode(only(flow, 'inject').id) };
    }

    function readScreenshot(msg) {
        assert.match(msg.filename, /^site-shot\/\d{8}-\d{6}-[0-9a-f]{16}\.png$/);
        return fs.readFileSync(path.join(workDir, msg.filename));
    }

    it('one page: every click captures the page into a new file', async () => {
        const { flow } = examples[0];
        const page = only(flow, 'inject').payload;
        const { seen, inject } = await load(flow);
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { times: 2 });
        inject.receive({});
        await until(() => seen.written.length === 1, 'the first file');
        inject.receive({});
        await until(() => seen.written.length === 2, 'the second file');
        assert.deepEqual(api.requests.map((request) => request.url.searchParams.get('url')), [page, page]);
        assert.notEqual(seen.written[0].filename, seen.written[1].filename);
        for (const msg of seen.written) {
            assert.ok(readScreenshot(msg).equals(RED_PNG));
            assert.equal(msg.siteshot.url, page);
        }
        assert.deepEqual(fs.readdirSync(path.join(workDir, 'site-shot')).sort(), seen.written.map((msg) => path.basename(msg.filename)).sort());
        assert.equal(seen.failed.length, 0);
    });

    it('a list: the pages are captured one after another into their own files, and a failure does not stop the rest', async () => {
        const { flow } = examples[1];
        const pages = JSON.parse(only(flow, 'inject').payload);
        assert.equal(pages.length, 3);
        const { seen, inject } = await load(flow);
        const answers = {
            [pages[0]]: { status: 200, body: RED_PNG, headers: PNG },
            [pages[1]]: { status: 404, body: PLACEHOLDER_PNG, headers: PNG },
            [pages[2]]: { status: 200, body: BLUE_PNG, headers: PNG }
        };
        api.reply((request) => answers[request.url.searchParams.get('url')], { delay: 20, times: 3 });
        inject.receive({});
        await until(() => seen.written.length === 2 && seen.failed.length === 1, 'two files and one failure');
        assert.deepEqual(seen.events, [
            `request ${pages[0]}`, `done ${pages[0]}`,
            `request ${pages[1]}`, `done ${pages[1]} SITE_SHOT_HTTP_404`,
            `request ${pages[2]}`, `done ${pages[2]}`
        ]);
        assert.deepEqual(seen.written.map((msg) => [msg.siteshot.url, readScreenshot(msg)]), [[pages[0], RED_PNG], [pages[2], BLUE_PNG]]);
        assert.equal(fs.readdirSync(path.join(workDir, 'site-shot')).length, 2);
        assert.equal(seen.failed[0].payload, pages[1]);
        assert.equal(seen.failed[0].error.code, 'SITE_SHOT_HTTP_404');
    });
});
