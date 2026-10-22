'use strict';

// Preloaded with `node --require` by the `test` script, before any other module
// of a test run: every connection that would leave this machine is refused, and
// so is every DNS query and UDP datagram. This is independent of the request
// mocks, so a test that misses its mock fails instead of reaching the internet.

const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');

/** What was refused, in order; tests read it to prove nothing tried to leave. */
const refusals = [];

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function refused(what) {
    refusals.push(what);
    const error = new Error(`Network access is disabled in tests: ${what}`);
    error.code = 'ERR_TEST_NETWORK_DISABLED';
    return error;
}

function isLoopback(host) {
    const family = net.isIP(String(host));
    return family !== 0 && LOOPBACK.check(String(host), family === 6 ? 'ipv6' : 'ipv4');
}

// TCP, and TLS on top of it: only local IPC paths and loopback addresses. Host
// names are refused too, because connecting to one starts with a DNS query.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    // The argument forms of net.Socket#connect; net.connect() passes its normalized arguments as an array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let options;
    if (first !== null && typeof first === 'object') {
        options = first;
    } else if (typeof first === 'string' && !(Number(first) >= 0)) {
        options = { path: first };
    } else {
        options = { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
    }
    if (typeof options.path === 'string' || isLoopback(options.host)) {
        return connect.apply(this, args);
    }
    const error = refused(`TCP connection to ${options.host}:${options.port}`);
    process.nextTick(() => this.destroy(error));
    return this;
};

// DNS, in its callback, promise and Resolver forms.
const QUERIES = /^(lookup|lookupService|resolve\w*|reverse)$/;

function refuseQueries(target, promises) {
    for (const name of Object.getOwnPropertyNames(target)) {
        const original = target[name];
        if (!QUERIES.test(name) || typeof original !== 'function') {
            continue;
        }
        target[name] = function (query, ...rest) {
            // Looking up an IP address gives it back as it is, without a query (net.Server#listen does this).
            if (name === 'lookup' && net.isIP(String(query)) !== 0) {
                return original.call(this, query, ...rest);
            }
            const error = refused(`DNS ${name} ${query}`);
            if (promises) {
                return Promise.reject(error);
            }
            const callback = rest.at(-1);
            if (typeof callback !== 'function') {
                throw error;
            }
            process.nextTick(callback, error);
        };
    }
}

refuseQueries(dns, false);
refuseQueries(dns.Resolver.prototype, false);
refuseQueries(dns.promises, true);
refuseQueries(dns.promises.Resolver.prototype, true);

// UDP: nothing in these tests uses it.
for (const name of ['connect', 'send']) {
    dgram.Socket.prototype[name] = function () {
        throw refused(`UDP ${name}`);
    };
}

module.exports = { refusals };
