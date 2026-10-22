'use strict';

// The package metadata, the editor definitions and help in nodes/site-shot.html,
// and the node types as the runtime registers them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, afterEach, describe, it } = require('node:test');
const helper = require('node-red-node-test-helper');
const nodeRed = require('node-red/package.json');
const pkg = require('../package.json');
const siteShotNodes = require('../nodes/site-shot.js');
const { KEY } = require('./support/fixtures.js');
const { refusals } = require('./support/no-network.js');

helper.init(require.resolve('node-red'));

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'nodes', 'site-shot.html'), 'utf8');
const source = fs.readFileSync(path.join(ROOT, 'nodes', 'site-shot.js'), 'utf8');

/** The node definitions the editor script registers, run against a stand-in for the editor's RED. */
function editorDefinitions() {
    const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)[1];
    const definitions = {};
    const RED = {
        nodes: {
            registerType(type, definition) {
                definitions[type] = definition;
            }
        },
        validators: {
            typedInput: (typeField) => ({ typedInputValidatorFor: typeField })
        }
    };
    vm.runInNewContext(script, { RED });
    return definitions;
}

/** Data made in the editor script's context, comparable with data made here. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function block(attribute, type) {
    const match = new RegExp(`<script type="text/html" ${attribute}="${type}">([\\s\\S]*?)</script>`).exec(html);
    assert.ok(match, `${attribute}="${type}"`);
    return match[1];
}

function screenshotFlow(settings) {
    return [
        { id: 'account', type: 'site-shot-account', name: 'Test account' },
        {
            id: 'shot', type: 'site-shot-screenshot', z: 'tab', name: '', account: 'account', url: 'payload', urlType: 'msg',
            format: 'png', fullPage: false, width: '', height: '', maxHeight: '', x: 100, y: 100, wires: [[]], ...settings
        }
    ];
}

afterEach(() => helper.unload());

after(() => {
    assert.deepEqual(refusals, [], 'the network guard refused a connection');
});

describe('package.json', () => {
    it('declares the nodes for Node-RED, and they exist with their editor files', () => {
        assert.equal(pkg.name, '@site-shot/node-red-siteshot');
        assert.ok(pkg.keywords.includes('node-red'));
        const files = Object.values(pkg['node-red'].nodes);
        assert.deepEqual(files, ['nodes/site-shot.js']);
        for (const file of files) {
            assert.ok(fs.existsSync(path.join(ROOT, file)), file);
            assert.ok(fs.existsSync(path.join(ROOT, file.replace(/\.js$/, '.html'))), file);
        }
    });

    it('publishes the nodes and the examples, with no runtime dependencies and exact development ones', () => {
        assert.deepEqual(pkg.files, ['nodes', 'examples']);
        assert.equal(pkg.dependencies, undefined);
        for (const [name, version] of Object.entries(pkg.devDependencies)) {
            assert.match(version, /^\d+\.\d+\.\d+$/, name);
        }
    });

    it('needs Node-RED 5 and the Node.js versions Node-RED 5 itself needs', () => {
        assert.equal(pkg['node-red'].version, '>=5.0.0');
        assert.match(nodeRed.version, /^5\./);
        assert.equal(pkg.engines.node, nodeRed.engines.node);
    });
});

describe('the editor', () => {
    it('defines the account as a config node whose API key is a password credential', () => {
        const account = editorDefinitions()['site-shot-account'];
        assert.equal(account.category, 'config');
        assert.deepEqual(Object.keys(account.defaults), ['name']);
        assert.deepEqual(plain(account.credentials), { apiKey: { type: 'password' } });
        assert.equal(account.label.call({ name: '' }), 'Site-Shot account');
        assert.equal(account.label.call({ name: 'Marketing' }), 'Marketing');
        const template = block('data-template-name', 'site-shot-account');
        assert.match(template, /<input type="text" id="node-config-input-name"/);
        assert.match(template, /<input type="password" id="node-config-input-apiKey"/);
    });

    it('defines the screenshot node with one input, one output and a field for every setting', () => {
        const screenshot = editorDefinitions()['site-shot-screenshot'];
        assert.equal(screenshot.category, 'network');
        assert.equal(screenshot.inputs, 1);
        assert.equal(screenshot.outputs, 1);
        assert.equal(screenshot.label.call({ name: '' }), 'site-shot');
        const { defaults } = screenshot;
        assert.deepEqual(Object.keys(defaults), ['name', 'account', 'url', 'urlType', 'format', 'fullPage', 'width', 'height', 'maxHeight']);
        assert.deepEqual(plain(defaults.account), { value: '', type: 'site-shot-account', required: true });
        assert.deepEqual(plain(defaults.url), { value: 'payload', required: true, validate: { typedInputValidatorFor: 'urlType' } });
        assert.deepEqual([defaults.urlType.value, defaults.format.value, defaults.fullPage.value], ['msg', 'png', false]);
        assert.deepEqual([defaults.width.value, defaults.height.value, defaults.maxHeight.value], ['', '', '']);
        const template = block('data-template-name', 'site-shot-screenshot');
        for (const name of Object.keys(defaults)) {
            assert.match(template, new RegExp(`id="node-input-${name}"`), name);
        }
    });

    it('accepts the same format and sizes as the runtime', async () => {
        const { defaults } = editorDefinitions()['site-shot-screenshot'];
        const values = {
            format: ['png', 'jpeg', 'PNG', 'gif', ''],
            width: ['', ' ', '100', '8000', ' 640 ', '99', '8001', '1.5', '640.5', '1e3', '-100', '0x10', 'wide'],
            height: ['', '100', '20000', '99', '20001', '7.5'],
            maxHeight: ['', '100', '20000', '99', '20001', 'all']
        };
        for (const [field, cases] of Object.entries(values)) {
            for (const value of cases) {
                await helper.load(siteShotNodes, screenshotFlow({ fullPage: true, [field]: value }), { account: { apiKey: KEY } });
                const runtimeAccepts = !helper.log().getCalls().some((call) => call.args[0].level === helper.log().ERROR);
                await helper.unload();
                assert.equal(defaults[field].validate(value), runtimeAccepts, `${field} = ${JSON.stringify(value)}`);
            }
        }
    });

    it('has help for both nodes, and the screenshot node help lists every error code', () => {
        assert.match(block('data-help-name', 'site-shot-account'), /API key/);
        const help = block('data-help-name', 'site-shot-screenshot');
        for (const heading of ['Inputs', 'Outputs', 'Details', 'References']) {
            assert.match(help, new RegExp(`<h3>${heading}</h3>`), heading);
        }
        const codes = new Set(source.match(/SITE_SHOT_[A-Z0-9_]+/g));
        assert.ok(codes.size >= 12, `found ${[...codes]}`);
        for (const code of codes) {
            assert.ok(help.includes(code), code);
        }
    });
});

describe('the runtime', () => {
    it('registers both node types and keeps the API key as a password credential', async () => {
        await helper.load(siteShotNodes, screenshotFlow({}), { account: { apiKey: KEY } });
        assert.equal(helper.getNode('account').type, 'site-shot-account');
        assert.equal(helper.getNode('account').credentials.apiKey, KEY);
        assert.equal(helper.getNode('shot').type, 'site-shot-screenshot');
        assert.deepEqual(helper.credentials.getDefinition('site-shot-account'), { apiKey: { type: 'password' } });
    });
});
