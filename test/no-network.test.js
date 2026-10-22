'use strict';

// The network guard is preloaded into every test process, refuses whatever
// would leave this machine, and still lets loopback through. The refused
// targets are reserved ones (TEST-NET-1, .invalid), so even a broken guard
// would reach nobody.

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { refusals } = require('./support/no-network.js');

const DISABLED = { code: 'ERR_TEST_NETWORK_DISABLED' };

function connectionError(socket) {
    return new Promise((resolve) => socket.once('error', resolve));
}

test('the guard is preloaded into this test process', () => {
    const preloaded = [];
    process.execArgv.forEach((arg, index, all) => {
        if (arg === '--require' || arg === '-r') {
            preloaded.push(all[index + 1]);
        } else if (arg.startsWith('--require=')) {
            preloaded.push(arg.slice('--require='.length));
        }
    });
    const guard = require.resolve('./support/no-network.js');
    assert.ok(preloaded.some((file) => path.resolve(file) === guard), `execArgv: ${process.execArgv.join(' ')}`);
});

test('TCP and TLS connections that would leave this machine are refused', async () => {
    assert.equal((await connectionError(net.connect({ host: '192.0.2.1', port: 443 }))).code, DISABLED.code);
    assert.equal((await connectionError(net.connect(80, 'site-shot-guard.invalid'))).code, DISABLED.code);
    await assert.rejects(fetch('https://192.0.2.1/'), (error) => error.cause && error.cause.code === DISABLED.code);
    await assert.rejects(fetch('https://site-shot-guard.invalid/'), (error) => error.cause && error.cause.code === DISABLED.code);
    assert.ok(refusals.includes('TCP connection to 192.0.2.1:443'));
    assert.ok(refusals.includes('TCP connection to site-shot-guard.invalid:80'));
});

test('DNS queries are refused in their callback, promise and Resolver forms', async () => {
    const callbackError = (query) => new Promise((resolve) => query((error) => resolve(error)));
    assert.equal((await callbackError((done) => dns.lookup('site-shot-guard.invalid', done))).code, DISABLED.code);
    assert.equal((await callbackError((done) => dns.resolve4('site-shot-guard.invalid', done))).code, DISABLED.code);
    assert.equal((await callbackError((done) => dns.reverse('192.0.2.1', done))).code, DISABLED.code);
    assert.equal((await callbackError((done) => new dns.Resolver().resolveTxt('site-shot-guard.invalid', done))).code, DISABLED.code);
    await assert.rejects(dns.promises.lookup('site-shot-guard.invalid'), DISABLED);
    await assert.rejects(dns.promises.resolve('site-shot-guard.invalid'), DISABLED);
    await assert.rejects(new dns.promises.Resolver().resolve6('site-shot-guard.invalid'), DISABLED);
    await assert.rejects(require('node:dns/promises').lookupService('192.0.2.1', 80), DISABLED);
    // An IP address is given back as it is, without a query.
    assert.deepEqual(await dns.promises.lookup('127.0.0.1'), { address: '127.0.0.1', family: 4 });
});

test('UDP datagrams are refused', () => {
    const socket = dgram.createSocket('udp4');
    try {
        assert.throws(() => socket.send(Buffer.from('x'), 53, '192.0.2.1'), DISABLED);
    } finally {
        socket.close();
    }
});

test('loopback connections still work', async () => {
    const server = net.createServer((socket) => socket.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const reply = await new Promise((resolve, reject) => {
            const socket = net.connect(server.address().port, '127.0.0.1');
            let data = '';
            socket.on('data', (chunk) => {
                data += chunk;
            });
            socket.on('end', () => resolve(data));
            socket.on('error', reject);
        });
        assert.equal(reply, 'ok');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
