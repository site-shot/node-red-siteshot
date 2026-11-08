'use strict';

// The screenshot node in the Node-RED runtime (node-red-node-test-helper),
// against a mocked Site-Shot API. The images are small synthetic fixtures.

const assert = require('node:assert/strict');
const util = require('node:util');
const { after, afterEach, beforeEach, describe, it } = require('node:test');
const helper = require('node-red-node-test-helper');
const NodePrototype = require('@node-red/runtime/lib/nodes/Node').prototype;
const siteShotNodes = require('../nodes/site-shot.js');
const { version } = require('../package.json');
const { BLUE_PNG, GREEN_PNG, JPEG, KEY, PLACEHOLDER_PNG, PNG, RED_PNG, YELLOW_JPEG, settle, until } = require('./support/fixtures.js');
const { refusals } = require('./support/no-network.js');
const { ORIGIN, SiteShotApi } = require('./support/site-shot-api.js');

helper.init(require.resolve('node-red'));

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const PAGE = 'https://www.example.com/';

/**
 * A flow around one screenshot node. Flow nodes need x and y: Node-RED takes nodes without them for config
 * nodes. The Catch and Complete nodes watch two nodes, so a deploy of modified nodes that changes only the
 * screenshot node leaves them running; Node-RED restarts a node whose property equals the id of a changed
 * node, and a one-element scope array does.
 */
function flow(settings) {
    return [
        { id: 'account', type: 'site-shot-account', name: 'Test account' },
        {
            id: 'shot', type: 'site-shot-screenshot', z: 'tab', name: '', account: 'account', url: 'payload', urlType: 'msg',
            format: 'png', fullPage: false, width: '', height: '', maxHeight: '', x: 300, y: 100, wires: [['out']], ...settings
        },
        { id: 'out', type: 'helper', z: 'tab', x: 500, y: 100 },
        { id: 'catch', type: 'catch', z: 'tab', scope: ['shot', 'out'], uncaught: false, x: 100, y: 200, wires: [['caught']] },
        { id: 'caught', type: 'helper', z: 'tab', x: 300, y: 200 },
        { id: 'complete', type: 'complete', z: 'tab', scope: ['shot', 'out'], uncaught: false, x: 100, y: 300, wires: [['completed']] },
        { id: 'completed', type: 'helper', z: 'tab', x: 300, y: 300 }
    ];
}

let api;
/** What the flow of the current test did. */
let run;

/** Records what a screenshot node instance sends and completes, whatever happens to its flow. */
function watch(node) {
    const send = node.send;
    node.send = function (msg) {
        run.sent.push(msg);
        return send.call(this, msg);
    };
    const complete = node._complete;
    node._complete = function (msg, error) {
        run.completions.push({ topic: msg.topic, error });
        if (run.onComplete) {
            run.onComplete(msg, error);
        }
        return complete.call(this, msg, error);
    };
}

async function start(settings = {}, credentials = { account: { apiKey: KEY } }) {
    await helper.load(siteShotNodes, flow(settings), credentials);
    run = { shot: helper.getNode('shot'), outputs: [], errors: [], completed: [], sent: [], completions: [], onComplete: null, stopped: false };
    helper.getNode('out').on('input', (msg) => run.outputs.push(msg));
    helper.getNode('caught').on('input', (msg) => run.errors.push(msg));
    helper.getNode('completed').on('input', (msg) => {
        if (msg.complete.source.id === 'shot') {
            run.completed.push(msg);
        }
    });
    watch(run.shot);
    return run;
}

/** Status calls of the screenshot nodes, from the helper's spies (they also see those made while starting). */
function statuses() {
    return run.stopped ? run.statuses : NodePrototype.status.getCalls().filter((call) => call.thisValue.id === 'shot').map((call) => call.args[0]);
}

function logs() {
    return run.stopped ? run.logs : helper.log().getCalls().map((call) => call.args[0]);
}

async function stop() {
    if (run && !run.stopped) {
        run.statuses = statuses();
        run.logs = logs();
        run.stopped = true;
        await helper.unload();
    }
}

/** Sends one message and waits for its output or its error. */
async function capture(msg) {
    const before = run.outputs.length + run.errors.length;
    run.shot.receive(msg);
    await until(() => run.outputs.length + run.errors.length > before, 'the capture result');
}

function lastError() {
    return run.errors.at(-1).error;
}

const unexpected = [];
process.on('unhandledRejection', (reason) => unexpected.push(reason));
process.on('uncaughtException', (error) => unexpected.push(error));

beforeEach(() => {
    api = new SiteShotApi();
    run = null;
});

afterEach(async () => {
    try {
        await stop();
        if (run) {
            for (const status of statuses()) {
                assert.ok(status.text === undefined || status.text.length < 20, `status text too long: ${status.text}`);
            }
        }
        assert.deepEqual(unexpected.splice(0), []);
    } finally {
        helper.settings({});
        await api.close();
    }
});

after(() => {
    assert.deepEqual(refusals, [], 'the network guard refused a connection');
});

describe('the capture request', () => {
    it('is one GET to the fixed endpoint with the published query parameters', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG });
        await capture({ payload: PAGE });
        assert.equal(api.requests.length, 1);
        const [request] = api.requests;
        assert.equal(request.method, 'GET');
        assert.equal(`${request.url.origin}${request.url.pathname}`, `${ORIGIN}/`);
        assert.deepEqual([...request.url.searchParams], [
            ['url', PAGE], ['userkey', KEY], ['format', 'png'], ['response_type', 'image'], ['full_size', '0']
        ]);
        assert.equal(request.headers['user-agent'], `node-red-siteshot/${version}`);
    });

    it('carries full page, the sizes and max height when they are set', async () => {
        await start({ format: 'jpeg', fullPage: true, width: '1280', height: '800', maxHeight: '5000' });
        api.reply({ status: 200, body: YELLOW_JPEG, headers: JPEG });
        await capture({ payload: PAGE });
        assert.deepEqual(Object.fromEntries(api.requests[0].url.searchParams), {
            url: PAGE, userkey: KEY, format: 'jpeg', response_type: 'image', full_size: '1', width: '1280', height: '800', max_height: '5000'
        });
        const { capturedAt, ...metadata } = run.outputs[0].siteshot;
        assert.deepEqual(metadata, {
            url: PAGE, format: 'jpeg', contentType: 'image/jpeg', fullPage: true, width: 1280, height: 800, maxHeight: 5000, bytes: YELLOW_JPEG.length
        });
    });

    it('leaves max height out of a viewport capture', async () => {
        await start({ width: '640', maxHeight: '5000' });
        api.reply({ status: 200, body: RED_PNG, headers: PNG });
        await capture({ payload: PAGE });
        assert.deepEqual(Object.fromEntries(api.requests[0].url.searchParams), {
            url: PAGE, userkey: KEY, format: 'png', response_type: 'image', full_size: '0', width: '640'
        });
        assert.equal(run.outputs[0].siteshot.width, 640);
        assert.equal('maxHeight' in run.outputs[0].siteshot, false);
    });

    for (const sizes of [{ width: '100', height: '20000', maxHeight: '100' }, { width: '8000', height: '100', maxHeight: '20000' }]) {
        it(`accepts sizes at the published bounds: ${JSON.stringify(sizes)}`, async () => {
            await start({ fullPage: true, ...sizes });
            api.reply({ status: 200, body: RED_PNG, headers: PNG });
            await capture({ payload: PAGE });
            const query = api.requests[0].url.searchParams;
            assert.deepEqual([query.get('width'), query.get('height'), query.get('max_height')], [sizes.width, sizes.height, sizes.maxHeight]);
        });
    }

    it('reads the address from the configured message property', async () => {
        await start({ url: 'target.address' });
        api.reply({ status: 200, body: RED_PNG, headers: PNG });
        await capture({ payload: 'not this', target: { address: 'https://www.example.org/page' } });
        assert.equal(api.requests[0].url.searchParams.get('url'), 'https://www.example.org/page');
    });

    it('uses a fixed address when one is configured', async () => {
        await start({ url: 'https://www.example.net/', urlType: 'str' });
        api.reply({ status: 200, body: RED_PNG, headers: PNG });
        await capture({ payload: PAGE });
        assert.equal(api.requests[0].url.searchParams.get('url'), 'https://www.example.net/');
    });

    it('sends public addresses normalized', async () => {
        const addresses = [
            ['https://www.example.com/path?q=1#top', 'https://www.example.com/path?q=1#top'],
            ['  HTTP://WWW.Example.COM  ', 'http://www.example.com/'],
            ['https://bücher.example/', 'https://xn--bcher-kva.example/'],
            ['https://www.example.com/a b', 'https://www.example.com/a%20b'],
            ['https://www.example.com./', 'https://www.example.com./'],
            ['http://93.184.215.14:8080/', 'http://93.184.215.14:8080/'],
            ['http://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/', 'http://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/']
        ];
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { times: addresses.length });
        for (const [address] of addresses) {
            await capture({ payload: address });
        }
        const expected = addresses.map(([, normalized]) => normalized);
        assert.deepEqual(api.requests.map((request) => request.url.searchParams.get('url')), expected);
        assert.deepEqual(run.outputs.map((msg) => msg.siteshot.url), expected);
    });
});

describe('the output', () => {
    it('is the PNG as a Buffer with metadata, and keeps every other message property', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG });
        const started = Date.now();
        await capture({ _msgid: 'm-1', payload: PAGE, topic: 'home page', correlationId: 'c-42', parts: { id: 'p-1', index: 0, count: 1 } });
        assert.equal(run.outputs.length, 1);
        const [msg] = run.outputs;
        assert.ok(Buffer.isBuffer(msg.payload));
        assert.ok(msg.payload.equals(RED_PNG));
        const { capturedAt, ...metadata } = msg.siteshot;
        assert.deepEqual(metadata, { url: PAGE, format: 'png', contentType: 'image/png', fullPage: false, bytes: RED_PNG.length });
        assert.equal(new Date(capturedAt).toISOString(), capturedAt);
        assert.ok(Date.parse(capturedAt) >= started - 1000 && Date.parse(capturedAt) <= Date.now());
        assert.equal(msg._msgid, 'm-1');
        assert.equal(msg.topic, 'home page');
        assert.equal(msg.correlationId, 'c-42');
        assert.deepEqual(msg.parts, { id: 'p-1', index: 0, count: 1 });
        assert.deepEqual(statuses().at(-1), { fill: 'green', shape: 'dot', text: 'PNG 1 kB' });
    });

    it('is the JPEG when JPEG is chosen, whatever the case and parameters of its content type', async () => {
        await start({ format: 'jpeg' });
        api.reply({ status: 200, body: YELLOW_JPEG, headers: { 'content-type': 'IMAGE/JPEG; charset=binary' } });
        await capture({ payload: PAGE });
        const [msg] = run.outputs;
        assert.ok(msg.payload.equals(YELLOW_JPEG));
        assert.equal(msg.siteshot.format, 'jpeg');
        assert.equal(msg.siteshot.contentType, 'image/jpeg');
        assert.deepEqual(statuses().at(-1), { fill: 'green', shape: 'dot', text: 'JPEG 1 kB' });
    });
});

describe('bad input is refused before any request', () => {
    it('refuses addresses that are not explicit public http(s) addresses', async () => {
        const addresses = [
            ['no scheme', 'www.example.com'],
            ['another scheme', 'ftp://www.example.com/'],
            ['a javascript: address', 'javascript:alert(1)'],
            ['a user name and password', 'https://user:secret@www.example.com/'],
            ['a user name', 'https://user@www.example.com/'],
            ['localhost', 'http://localhost:1880/'],
            ['localhost with a final dot', 'http://LOCALHOST./'],
            ['a .local name', 'https://printer.local/'],
            ['an .internal name', 'https://db.internal/'],
            ['a home.arpa name', 'https://nas.home.arpa/'],
            ['a single-label name', 'https://intranet/'],
            ['a loopback address', 'http://127.0.0.1:8080/'],
            ['a loopback address as a number', 'http://2130706433/'],
            ['a loopback address in hex', 'http://0x7f000001/'],
            ['a 10/8 address', 'http://10.1.2.3/'],
            ['a 172.16/12 address', 'http://172.16.0.1/'],
            ['a 192.168/16 address', 'http://192.168.1.1/'],
            ['a carrier-grade NAT address', 'http://100.64.0.1/'],
            ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
            ['the unspecified address', 'http://0.0.0.0/'],
            ['IPv6 loopback', 'http://[::1]/'],
            ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
            ['IPv6 link-local', 'http://[fe80::1]/'],
            ['IPv6 unique local', 'http://[fd00::1]/'],
            ['an address that does not parse', 'https://exa mple.com/'],
            ['a control character', `${PAGE}\u0000`],
            ['more than 2048 characters', `${PAGE}${'a'.repeat(2048)}`],
            ['more than 2048 characters once encoded', `${PAGE}${'é'.repeat(700)}`],
            ['empty text', ''],
            ['blank text', '   '],
            ['a number', 42],
            ['an object', { url: PAGE }],
            ['a missing property', undefined]
        ];
        await start();
        for (const [what, address] of addresses) {
            await capture({ payload: address });
            assert.equal(lastError().code, 'SITE_SHOT_INVALID_URL', what);
            assert.match(lastError().message, /^Error: The URL to capture \(from msg\.payload\) /, what);
        }
        assert.equal(api.requests.length, 0);
        assert.equal(run.outputs.length, 0);
        assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: 'invalid URL' });
    });

    const invalidSettings = [
        [{ width: '99' }, 'Width must be a whole number from 100 to 8000.'],
        [{ width: '8001' }, 'Width must be a whole number from 100 to 8000.'],
        [{ width: '1.5' }, 'Width must be a whole number from 100 to 8000.'],
        [{ width: '640.5' }, 'Width must be a whole number from 100 to 8000.'],
        [{ width: '1e3' }, 'Width must be a whole number from 100 to 8000.'],
        [{ width: '-100' }, 'Width must be a whole number from 100 to 8000.'],
        [{ height: '20001' }, 'Height must be a whole number from 100 to 20000.'],
        [{ height: 'tall' }, 'Height must be a whole number from 100 to 20000.'],
        [{ fullPage: true, maxHeight: '20001' }, 'Max height must be a whole number from 100 to 20000.'],
        [{ maxHeight: '99' }, 'Max height must be a whole number from 100 to 20000.'],
        [{ format: 'gif' }, 'Format must be PNG or JPEG.'],
        [{ fullPage: 'true' }, 'Full page must be true or false.'],
        [{ urlType: 'jsonata' }, 'URL must be a message property or a fixed address.'],
        [{ url: '' }, 'URL must not be empty.'],
        [{ url: '  ', urlType: 'str' }, 'URL must not be empty.'],
        [{ url: 'a..b' }, 'URL is not a valid message property.']
    ];
    for (const [settings, message] of invalidSettings) {
        it(`refuses to capture with ${JSON.stringify(settings)}`, async () => {
            await start(settings);
            assert.ok(logs().some((log) => log.level === helper.log().ERROR && log.msg === message), 'the problem is logged on start');
            assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: 'invalid settings' });
            await capture({ payload: PAGE });
            assert.equal(lastError().code, 'SITE_SHOT_SETTINGS');
            assert.equal(lastError().message, `Error: ${message}`);
            assert.equal(api.requests.length, 0);
        });
    }

    for (const timeout of [0, -1, 1.5, '1000', 600001]) {
        it(`refuses a siteShotScreenshotTimeout setting of ${JSON.stringify(timeout)}`, async () => {
            helper.settings({ siteShotScreenshotTimeout: timeout });
            await start();
            await capture({ payload: PAGE });
            assert.equal(lastError().code, 'SITE_SHOT_SETTINGS');
            assert.equal(lastError().message, 'Error: siteShotScreenshotTimeout must be a whole number of milliseconds from 1 to 600000.');
            assert.equal(api.requests.length, 0);
        });
    }

    const missingCredentials = [
        ['no account is chosen', { account: '' }, undefined, 'no account', 'Choose a Site-Shot account in this node.'],
        ['the account does not exist', { account: 'deleted' }, undefined, 'no account', 'Choose a Site-Shot account in this node.'],
        ['the account has no credentials', {}, {}, 'no API key', 'The Site-Shot account node has no API key.'],
        ['the account has no API key', {}, { account: {} }, 'no API key', 'The Site-Shot account node has no API key.'],
        ['the API key is blank', {}, { account: { apiKey: '   ' } }, 'no API key', 'The Site-Shot account node has no API key.']
    ];
    for (const [what, settings, credentials, statusText, message] of missingCredentials) {
        it(`refuses to capture when ${what}`, async () => {
            await start(settings, credentials);
            assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: statusText });
            await capture({ payload: PAGE });
            assert.equal(lastError().code, 'SITE_SHOT_SETTINGS');
            assert.equal(lastError().message, `Error: ${message}`);
            assert.equal(api.requests.length, 0);
        });
    }
});

describe('an answer that is not a screenshot is a failure, and is not retried', () => {
    const httpFailures = [
        [401, { body: 'Unauthorized', headers: { 'content-type': 'text/plain' } }],
        [403, { body: PLACEHOLDER_PNG, headers: PNG }],
        [404, { body: PLACEHOLDER_PNG, headers: PNG }],
        [429, { body: '{"message":"API dedicated workers limit exceeded"}', headers: { 'content-type': 'application/json' } }],
        [400, { body: 'Bad Request' }],
        [500, { body: 'Internal Server Error' }],
        [502, { body: '<html>Bad Gateway</html>', headers: { 'content-type': 'text/html' } }],
        [503, { body: '' }],
        [504, { body: '' }]
    ];
    for (const [status, answer] of httpFailures) {
        it(`HTTP ${status} fails with SITE_SHOT_HTTP_${status}`, async () => {
            await start();
            // More answers than needed: a retry would get one.
            api.reply({ status, ...answer }, { times: 3 });
            await capture({ payload: PAGE });
            await settle(50);
            assert.equal(api.requests.length, 1);
            assert.equal(run.outputs.length, 0);
            assert.equal(lastError().code, `SITE_SHOT_HTTP_${status}`);
            assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: `HTTP ${status}` });
            if (status === 404) {
                assert.match(lastError().message, /placeholder image sent with this answer was discarded/);
            }
        });
    }

    const FREE_PLAN_USED_UP = 'Free plan used up: 100 captures this month. It renews on 2026-12-01 (UTC). Paid plans start at $5 a month for 2,000 captures: https://www.site-shot.com/pricing/';
    const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
    const planAnswers = [
        ['the free plan is used up (Kong JSON)', { body: JSON.stringify({ message: FREE_PLAN_USED_UP }), headers: JSON_TYPE }, FREE_PLAN_USED_UP],
        ['the key has no plan (Kong JSON)', { body: '{"message":"No active subscription found"}', headers: JSON_TYPE }, 'No active subscription found'],
        ['the free plan is used up (plain text)', { body: `${FREE_PLAN_USED_UP}\n`, headers: { 'content-type': 'text/plain' } }, FREE_PLAN_USED_UP]
    ];
    for (const [what, answer, explanation] of planAnswers) {
        it(`HTTP 403 when ${what} passes on Site-Shot's explanation`, async () => {
            await start();
            api.reply({ status: 403, ...answer }, { times: 3 });
            await capture({ payload: PAGE });
            await settle(50);
            assert.equal(api.requests.length, 1);
            assert.equal(run.outputs.length, 0);
            assert.equal(lastError().code, 'SITE_SHOT_HTTP_403');
            assert.equal(lastError().message, `Error: Site-Shot refused the capture (HTTP 403): ${explanation}`);
        });
    }

    const otherAnswers = [
        ['an unknown JSON message', { body: '{"message":"Something else"}', headers: JSON_TYPE }],
        ['a message that carries the key', { body: JSON.stringify({ message: `No active subscription found for ${KEY}` }), headers: JSON_TYPE }],
        ['a body that is too long', { body: JSON.stringify({ message: `Free plan used up: ${'x'.repeat(5000)}` }), headers: JSON_TYPE }],
        ['invalid JSON', { body: '{"message":"Free plan used up', headers: JSON_TYPE }],
        ['an HTML page', { body: '<p>Free plan used up</p>', headers: { 'content-type': 'text/html' } }]
    ];
    for (const [what, answer] of otherAnswers) {
        it(`HTTP 403 with ${what} keeps the node's own message`, async () => {
            await start();
            api.reply({ status: 403, ...answer });
            await capture({ payload: PAGE });
            assert.equal(lastError().code, 'SITE_SHOT_HTTP_403');
            assert.match(lastError().message, /^Error: Site-Shot refused the capture \(HTTP 403\): the plan may be inactive/);
            assert.ok(!lastError().message.includes(KEY));
        });
    }

    for (const status of [301, 302, 303, 307, 308]) {
        it(`an HTTP ${status} redirect is not followed`, async () => {
            await start();
            api.reply({ status, headers: { location: 'https://cdn.example.com/shot.png' } }, { times: 3 });
            api.reply({ status: 200, body: RED_PNG, headers: PNG }, { origin: 'https://cdn.example.com', times: 3 });
            await capture({ payload: PAGE });
            await settle(50);
            assert.equal(api.requests.length, 1);
            assert.equal(run.outputs.length, 0);
            assert.equal(lastError().code, `SITE_SHOT_HTTP_${status}`);
        });
    }

    const notImages = [
        ['an HTML page', 'png', { body: '<!doctype html><title>Error</title>', headers: { 'content-type': 'text/html; charset=utf-8' } }],
        ['a JSON envelope', 'png', { body: '{"image":"iVBORw0KGgo="}', headers: { 'content-type': 'application/json' } }],
        ['a PNG without a content type', 'png', { body: RED_PNG }],
        ['an empty PNG', 'png', { body: '', headers: PNG }],
        ['HTML labelled as PNG', 'png', { body: '<html></html>', headers: PNG }],
        ['JPEG data labelled as PNG', 'png', { body: YELLOW_JPEG, headers: PNG }],
        ['a PNG when JPEG was asked for', 'jpeg', { body: RED_PNG, headers: PNG }],
        ['PNG data labelled as JPEG', 'jpeg', { body: RED_PNG, headers: JPEG }]
    ];
    for (const [what, format, answer] of notImages) {
        it(`HTTP 200 with ${what} fails with SITE_SHOT_NOT_AN_IMAGE`, async () => {
            await start({ format });
            api.reply({ status: 200, ...answer }, { times: 3 });
            await capture({ payload: PAGE });
            await settle(50);
            assert.equal(api.requests.length, 1);
            assert.equal(run.outputs.length, 0);
            assert.equal(lastError().code, 'SITE_SHOT_NOT_AN_IMAGE');
            assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: 'not an image' });
        });
    }

    it('a screenshot announced as larger than 64 MiB is refused before it is read', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: { ...PNG, 'content-length': String(MAX_IMAGE_BYTES + 1) } });
        await capture({ payload: PAGE });
        assert.equal(lastError().code, 'SITE_SHOT_TOO_LARGE');
        assert.equal(run.outputs.length, 0);
    });

    it('a screenshot that turns out larger than 64 MiB is refused', async () => {
        await start();
        const image = Buffer.alloc(MAX_IMAGE_BYTES + 1);
        RED_PNG.copy(image);
        api.reply({ status: 200, body: image, headers: PNG });
        await capture({ payload: PAGE });
        assert.equal(lastError().code, 'SITE_SHOT_TOO_LARGE');
        assert.equal(run.outputs.length, 0);
    });

    it('a screenshot of exactly 64 MiB is accepted', async () => {
        await start();
        const image = Buffer.alloc(MAX_IMAGE_BYTES);
        RED_PNG.copy(image);
        api.reply({ status: 200, body: image, headers: PNG });
        await capture({ payload: PAGE });
        assert.equal(run.errors.length, 0);
        assert.equal(run.outputs[0].payload.length, MAX_IMAGE_BYTES);
        assert.equal(run.outputs[0].siteshot.bytes, MAX_IMAGE_BYTES);
    });

    it('a transport failure fails with SITE_SHOT_NETWORK and only its error code', async () => {
        await start();
        const error = Object.assign(new Error(`socket hang up: GET ${ORIGIN}/?userkey=${KEY}`), { code: 'ECONNRESET' });
        api.reply({ error }, { times: 3 });
        await capture({ payload: PAGE });
        await settle(50);
        assert.equal(api.requests.length, 1);
        assert.equal(lastError().code, 'SITE_SHOT_NETWORK');
        assert.equal(lastError().message, 'Error: Could not reach the Site-Shot API (ECONNRESET).');
        assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: 'network error' });
    });

    it('no answer within siteShotScreenshotTimeout fails with SITE_SHOT_TIMEOUT', async () => {
        helper.settings({ siteShotScreenshotTimeout: 100 });
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 400, times: 3 });
        const started = Date.now();
        await capture({ payload: PAGE });
        const waited = Date.now() - started;
        assert.ok(waited >= 90 && waited < 400, `failed after ${waited} ms`);
        assert.equal(lastError().code, 'SITE_SHOT_TIMEOUT');
        assert.match(lastError().message, /within 0\.1 seconds/);
        assert.deepEqual(statuses().at(-1), { fill: 'red', shape: 'ring', text: 'timeout' });
        // The late answer arrives and is ignored.
        await settle(450);
        assert.equal(api.requests.length, 1);
        assert.equal(run.outputs.length, 0);
        assert.equal(run.sent.length, 0);
    });
});

describe('the API key', () => {
    it('is sent to Site-Shot only, and is never in outputs, errors, statuses or logs', async () => {
        await start();
        const leakyError = Object.assign(new Error(`connect failed for ${ORIGIN}/?userkey=${KEY}`), { code: 'ECONNREFUSED' });
        api.reply({ status: 200, body: RED_PNG, headers: PNG });
        api.reply({ status: 401, body: `Invalid user key ${KEY}`, headers: { 'content-type': 'text/plain' } });
        api.reply({ status: 404, body: PLACEHOLDER_PNG, headers: PNG });
        api.reply({ status: 302, headers: { location: `https://cdn.example.com/?userkey=${KEY}` } });
        api.reply({ status: 200, body: `<html>${KEY}</html>`, headers: { 'content-type': 'text/html' } });
        api.reply({ error: leakyError });
        for (let i = 0; i < 7; i += 1) {
            // The last one finds no answer at all: the mock fails it with a message that holds the request URL.
            await capture({ payload: PAGE });
        }
        assert.equal(api.requests.length, 6);
        assert.ok(api.requests.every((request) => request.url.searchParams.get('userkey') === KEY), 'the key went to Site-Shot');
        assert.deepEqual(run.errors.map((msg) => msg.error.code), [
            'SITE_SHOT_HTTP_401', 'SITE_SHOT_HTTP_404', 'SITE_SHOT_HTTP_302', 'SITE_SHOT_NOT_AN_IMAGE', 'SITE_SHOT_NETWORK', 'SITE_SHOT_NETWORK'
        ]);
        assert.equal(run.errors.at(-1).error.message, 'Error: Could not reach the Site-Shot API (UND_MOCK_ERR_MOCK_NOT_MATCHED).');
        const seen = util.inspect({ outputs: run.outputs, errors: run.errors, statuses: statuses(), logs: logs() }, { depth: null, maxArrayLength: null, maxStringLength: null });
        assert.equal(seen.includes(KEY), false);
    });
});

describe('one capture at a time', () => {
    const images = { 'https://red.example.com/': RED_PNG, 'https://green.example.com/': GREEN_PNG, 'https://blue.example.com/': BLUE_PNG };

    function trace() {
        const events = [];
        api.onRequest = (request) => events.push(`request ${request.url.searchParams.get('url')}`);
        run.onComplete = (msg, error) => events.push(`done ${msg.topic}${error ? ` ${error.code}` : ''}`);
        return events;
    }

    it('captures waiting messages one after another, in arrival order', async () => {
        await start();
        const events = trace();
        api.reply((request) => ({ status: 200, body: images[request.url.searchParams.get('url')], headers: PNG }), { delay: 20, times: 3 });
        for (const url of Object.keys(images)) {
            run.shot.receive({ payload: url, topic: url });
        }
        await until(() => run.outputs.length === 3, 'three screenshots');
        assert.deepEqual(events, Object.keys(images).flatMap((url) => [`request ${url}`, `done ${url}`]));
        assert.deepEqual(run.outputs.map((msg) => [msg.topic, msg.payload]), Object.entries(images));
        assert.ok(statuses().some((status) => status.text === 'capturing +2'));
    });

    it('goes on with the next message after a failure', async () => {
        await start();
        const events = trace();
        api.reply((request) => {
            const url = request.url.searchParams.get('url');
            return url === 'https://green.example.com/'
                ? { status: 404, body: PLACEHOLDER_PNG, headers: PNG }
                : { status: 200, body: images[url], headers: PNG };
        }, { times: 3 });
        for (const url of Object.keys(images)) {
            run.shot.receive({ payload: url, topic: url });
        }
        await until(() => run.outputs.length === 2 && run.errors.length === 1, 'two screenshots and one failure');
        assert.deepEqual(events, [
            'request https://red.example.com/', 'done https://red.example.com/',
            'request https://green.example.com/', 'done https://green.example.com/ SITE_SHOT_HTTP_404',
            'request https://blue.example.com/', 'done https://blue.example.com/'
        ]);
        assert.deepEqual(run.outputs.map((msg) => msg.topic), ['https://red.example.com/', 'https://blue.example.com/']);
        assert.equal(run.errors[0].payload, 'https://green.example.com/');
    });

    it('refuses a message when 1000 are already waiting', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 300 });
        for (let i = 0; i <= 1001; i += 1) {
            run.shot.receive({ payload: PAGE, topic: i });
        }
        await until(() => run.errors.length === 1, 'the refusal');
        assert.equal(run.errors[0].topic, 1001);
        assert.equal(lastError().code, 'SITE_SHOT_QUEUE_FULL');
        assert.equal(api.requests.length, 1);
        await stop();
        // The refused message, then the capture in flight and the 1000 waiting, all cancelled.
        const codes = run.completions.map((completion) => completion.error && completion.error.code);
        assert.equal(codes.length, 1002);
        assert.equal(codes[0], 'SITE_SHOT_QUEUE_FULL');
        assert.ok(codes.slice(1).every((code) => code === 'SITE_SHOT_CANCELLED'));
        await settle(350);
        assert.equal(run.sent.length, 0);
        assert.equal(api.requests.length, 1);
    });
});

describe('closing and redeploying', () => {
    /** How each message the screenshot node took ended: its error code, or 'done' for a completion. */
    const endings = () => run.completions.map((completion) => [completion.topic, completion.error ? completion.error.code : 'done']);

    it('cancels the capture in flight when the flow stops, without output', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 300 });
        run.shot.receive({ payload: PAGE, topic: 'in flight' });
        await until(() => api.requests.length === 1, 'the request');
        const closing = Date.now();
        await stop();
        assert.ok(Date.now() - closing < 250, 'the flow waited for the capture instead of cancelling it');
        // Closing finished only once the capture was given up.
        assert.deepEqual(endings(), [['in flight', 'SITE_SHOT_CANCELLED']]);
        await settle(350);
        assert.equal(run.sent.length, 0);
        assert.deepEqual(endings(), [['in flight', 'SITE_SHOT_CANCELLED']]);
    });

    it('closing finishes only once the capture in flight is given up, however long its abort takes', async () => {
        const fetchNow = globalThis.fetch;
        // A fetch whose abort settles 50 ms late; undici's own settles at once.
        globalThis.fetch = (url, options) => fetchNow(url, options).catch(async (error) => {
            await settle(50);
            throw error;
        });
        try {
            await start();
            api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 300 });
            run.shot.receive({ payload: PAGE, topic: 'in flight' });
            await until(() => api.requests.length === 1, 'the request');
            await stop();
            assert.deepEqual(endings(), [['in flight', 'SITE_SHOT_CANCELLED']]);
            await settle(350);
        } finally {
            globalThis.fetch = fetchNow;
        }
    });

    it('cancels the waiting messages when the flow stops', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 300, times: 3 });
        for (const topic of ['in flight', 'waiting 1', 'waiting 2']) {
            run.shot.receive({ payload: PAGE, topic });
        }
        await until(() => api.requests.length === 1, 'the request');
        await stop();
        await settle(350);
        assert.equal(api.requests.length, 1);
        assert.equal(run.sent.length, 0);
        assert.deepEqual(endings().sort(), [
            ['in flight', 'SITE_SHOT_CANCELLED'], ['waiting 1', 'SITE_SHOT_CANCELLED'], ['waiting 2', 'SITE_SHOT_CANCELLED']
        ]);
    });

    it('cancels a message delivered while the node is closing', async () => {
        await start();
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 300, times: 3 });
        run.shot.receive({ payload: PAGE, topic: 'in flight' });
        await until(() => api.requests.length === 1, 'the request');
        const closing = run.shot.close(false);
        run.shot.receive({ payload: PAGE, topic: 'late' });
        await closing;
        await settle(350);
        assert.equal(api.requests.length, 1);
        assert.equal(run.sent.length, 0);
        assert.deepEqual(endings().sort(), [['in flight', 'SITE_SHOT_CANCELLED'], ['late', 'SITE_SHOT_CANCELLED']]);
    });

    it('a partial redeploy cancels the replaced node\'s captures: they reach Catch nodes, never Complete nodes', async () => {
        await start();
        const replaced = run.shot;
        api.reply({ status: 200, body: RED_PNG, headers: PNG }, { delay: 300 });
        for (const topic of ['in flight', 'waiting 1', 'waiting 2']) {
            replaced.receive({ payload: PAGE, topic });
        }
        await until(() => api.requests.length === 1, 'the request');
        // A deploy of modified nodes that changes only the screenshot node: the Catch and Complete nodes stay.
        const complete = helper.getNode('complete');
        const caught = helper.getNode('catch');
        await helper.setFlows(flow({ format: 'jpeg' }), 'nodes', { account: { apiKey: KEY } });
        assert.equal(helper.getNode('complete'), complete);
        assert.equal(helper.getNode('catch'), caught);
        const current = helper.getNode('shot');
        assert.notEqual(current, replaced);
        await settle(350);
        assert.deepEqual(run.completed.map((msg) => msg.topic), [], 'a cancelled capture triggered a Complete node');
        assert.equal(run.sent.length, 0);
        assert.deepEqual(run.errors.map((msg) => [msg.topic, msg.error.code]).sort(), [
            ['in flight', 'SITE_SHOT_CANCELLED'], ['waiting 1', 'SITE_SHOT_CANCELLED'], ['waiting 2', 'SITE_SHOT_CANCELLED']
        ]);
        assert.match(run.errors.find((msg) => msg.topic === 'in flight').error.message, /Site-Shot may still finish it and count it/);
        assert.match(run.errors.find((msg) => msg.topic === 'waiting 1').error.message, /was not captured/);
        // The Complete node that stayed still reports real captures, now by the redeployed node.
        watch(current);
        api.reply({ status: 200, body: YELLOW_JPEG, headers: JPEG });
        current.receive({ payload: PAGE, topic: 'after redeploy' });
        await until(() => run.completed.length === 1, 'the Complete node');
        assert.equal(run.completed[0].topic, 'after redeploy');
        assert.deepEqual(run.outputs.map((msg) => [msg.topic, msg.siteshot.format]), [['after redeploy', 'jpeg']]);
        assert.equal(api.requests.length, 2);
    });
});
