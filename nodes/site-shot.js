'use strict';

// Site-Shot nodes. The account node keeps the API key in Node-RED's credential
// store; the screenshot node makes one capture request per message to the
// published capture endpoint (https://www.site-shot.com/openapi-capture.json)
// and passes the image on as a Buffer.

const net = require('node:net');
const { version } = require('../package.json');

/** The only address the API key is ever sent to. Deliberately not configurable. */
const API_ENDPOINT = 'https://api.site-shot.com/';
const USER_AGENT = `node-red-siteshot/${version}`;

const FORMATS = {
    png: { label: 'PNG', contentType: 'image/png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    jpeg: { label: 'JPEG', contentType: 'image/jpeg', signature: Buffer.from([0xff, 0xd8, 0xff]) }
};

/** Optional size settings: the published bounds and the query parameter each one sets. */
const SIZES = {
    width: { label: 'Width', param: 'width', min: 100, max: 8000 },
    height: { label: 'Height', param: 'height', min: 100, max: 20000 },
    maxHeight: { label: 'Max height', param: 'max_height', min: 100, max: 20000 }
};

const MAX_URL_LENGTH = 2048;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_WAITING = 1000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;

/** Addresses that are not on the public internet. IPv4-mapped IPv6 addresses match the IPv4 rules. */
const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) {
    NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
    NON_PUBLIC.addSubnet(address, prefix, 'ipv6');
}
const LOCAL_NAME = /(^|\.)(localhost|local|internal|home\.arpa)$/;

/**
 * A failure that is safe to show and to hand to Catch nodes: the message is
 * our own text, never upstream text, the request URL or the API key. Node-RED
 * copies `code` into `msg.error.code`; `statusText` is for the node status.
 */
class SiteShotError extends Error {
    constructor(code, message, statusText) {
        super(message);
        this.code = code;
        this.statusText = statusText;
    }
}

function settingsError(message) {
    return new SiteShotError('SITE_SHOT_SETTINGS', message, 'invalid settings');
}

function readSize(value, size) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return undefined;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text) || Number(text) < size.min || Number(text) > size.max) {
        throw settingsError(`${size.label} must be a whole number from ${size.min} to ${size.max}.`);
    }
    return Number(text);
}

function readTimeout(value) {
    if (value === undefined) {
        return DEFAULT_TIMEOUT_MS;
    }
    if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
        throw settingsError(`siteShotScreenshotTimeout must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}.`);
    }
    return value;
}

/** The node's settings, checked once when it starts. */
function readSettings(RED, config) {
    if (config.urlType !== 'msg' && config.urlType !== 'str') {
        throw settingsError('URL must be a message property or a fixed address.');
    }
    if (typeof config.url !== 'string' || config.url.trim() === '') {
        throw settingsError('URL must not be empty.');
    }
    if (config.urlType === 'msg') {
        try {
            RED.util.normalisePropertyExpression(config.url);
        } catch (error) {
            throw settingsError('URL is not a valid message property.');
        }
    }
    if (!Object.hasOwn(FORMATS, config.format)) {
        throw settingsError('Format must be PNG or JPEG.');
    }
    if (config.fullPage !== undefined && typeof config.fullPage !== 'boolean') {
        throw settingsError('Full page must be true or false.');
    }
    const fullPage = config.fullPage === true;
    const sizes = {};
    for (const key of Object.keys(SIZES)) {
        const value = readSize(config[key], SIZES[key]);
        // Max height only applies to full page captures, so it is not sent otherwise.
        if (value !== undefined && (key !== 'maxHeight' || fullPage)) {
            sizes[key] = value;
        }
    }
    return {
        format: config.format,
        fullPage,
        sizes,
        source: config.urlType === 'msg' ? `msg.${config.url}` : 'the node settings',
        timeoutMs: readTimeout(RED.settings.siteShotScreenshotTimeout)
    };
}

function isNonPublicHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const family = net.isIP(host);
    if (family !== 0) {
        return NON_PUBLIC.check(host, family === 6 ? 'ipv6' : 'ipv4');
    }
    return !host.includes('.') || LOCAL_NAME.test(host);
}

/** An explicit public http(s) address, normalized, or an error saying what is wrong with it. */
function captureAddress(value, source) {
    const invalid = (problem) => new SiteShotError('SITE_SHOT_INVALID_URL', `The URL to capture (from ${source}) ${problem}.`, 'invalid URL');
    if (typeof value !== 'string') {
        throw invalid('is not text');
    }
    const text = value.trim();
    if (text === '') {
        throw invalid('is empty');
    }
    if (text.length > MAX_URL_LENGTH) {
        throw invalid(`is longer than ${MAX_URL_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/.test(text)) {
        throw invalid('contains control characters');
    }
    if (!/^https?:\/\//i.test(text)) {
        throw invalid('must start with http:// or https://');
    }
    let parsed;
    try {
        parsed = new URL(text);
    } catch (error) {
        throw invalid('is not a valid address');
    }
    if (parsed.username !== '' || parsed.password !== '') {
        throw invalid('must not contain a user name or password');
    }
    if (isNonPublicHost(parsed.hostname)) {
        throw invalid('points to a local or private network address, which Site-Shot cannot reach');
    }
    if (parsed.href.length > MAX_URL_LENGTH) {
        throw invalid(`is longer than ${MAX_URL_LENGTH} characters once encoded`);
    }
    return parsed.href;
}

function httpError(status) {
    const statusText = `HTTP ${status}`;
    if (status >= 300 && status < 400) {
        return new SiteShotError(`SITE_SHOT_HTTP_${status}`, `Site-Shot answered with a redirect (HTTP ${status}), which this node does not follow.`, statusText);
    }
    if (status === 401) {
        return new SiteShotError('SITE_SHOT_HTTP_401', 'Site-Shot did not accept the API key (HTTP 401). Check the key in the Site-Shot account node.', statusText);
    }
    if (status === 403) {
        return new SiteShotError('SITE_SHOT_HTTP_403', 'Site-Shot refused the capture (HTTP 403): the plan may be inactive or out of captures, no capture worker may be free, or the address may not be allowed.', statusText);
    }
    if (status === 404) {
        return new SiteShotError('SITE_SHOT_HTTP_404', 'Site-Shot could not capture the page (HTTP 404): it may not have loaded, or its host name may not resolve. The placeholder image sent with this answer was discarded.', statusText);
    }
    if (status === 429) {
        return new SiteShotError('SITE_SHOT_HTTP_429', 'Site-Shot refused the capture (HTTP 429): the plan\'s limit of captures at the same time was reached, for example by other nodes or apps using the same key. The capture was not retried.', statusText);
    }
    if (status >= 500) {
        return new SiteShotError(`SITE_SHOT_HTTP_${status}`, `Site-Shot or a gateway in front of it failed (HTTP ${status}). The capture was not retried.`, statusText);
    }
    return new SiteShotError(`SITE_SHOT_HTTP_${status}`, `Site-Shot answered with HTTP ${status} instead of a screenshot.`, statusText);
}

function notImage(format, what) {
    return new SiteShotError('SITE_SHOT_NOT_AN_IMAGE', `Site-Shot answered with ${what} instead of a ${FORMATS[format].label} image.`, 'not an image');
}

function tooLarge() {
    return new SiteShotError('SITE_SHOT_TOO_LARGE', `The screenshot is larger than ${MAX_IMAGE_BYTES / 1048576} MiB, the most this node accepts. Use JPEG or a lower Max height. The capture may still count toward your plan.`, 'too large');
}

function timedOut(timeoutMs) {
    return new SiteShotError('SITE_SHOT_TIMEOUT', `Site-Shot did not answer within ${timeoutMs / 1000} seconds. The capture was not retried; Site-Shot may still finish it and count it.`, 'timeout');
}

/**
 * For a message the node gives up because it is stopped or redeployed. An error, not a completion:
 * done() without one would trigger Complete nodes as if the screenshot had been taken.
 */
function cancelled(started) {
    return new SiteShotError('SITE_SHOT_CANCELLED', started
        ? 'The capture was cancelled because the node was stopped or redeployed. Site-Shot may still finish it and count it.'
        : 'The message was not captured because the node was stopped or redeployed.', 'cancelled');
}

/** A transport failure, described by its error code only: error messages can carry request details. */
function unreachable(error) {
    let code = '';
    for (let cause = error, depth = 0; cause && depth < 5 && code === ''; cause = cause.cause, depth += 1) {
        if (typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(cause.code)) {
            code = cause.code;
        }
    }
    return new SiteShotError('SITE_SHOT_NETWORK', `Could not reach the Site-Shot API${code ? ` (${code})` : ''}.`, 'network error');
}

async function readBody(body) {
    const chunks = [];
    let size = 0;
    if (body === null) {
        return Buffer.alloc(0);
    }
    for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > MAX_IMAGE_BYTES) {
            throw tooLarge();
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
}

/**
 * One capture request. Resolves with the body of an HTTP 200 answer that has the content type and the
 * first bytes of the chosen format; rejects on any other answer. The image itself is not decoded.
 */
async function capture(requestUrl, format, signal) {
    const expected = FORMATS[format];
    const response = await fetch(requestUrl, { redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT } });
    try {
        if (response.status !== 200) {
            throw httpError(response.status);
        }
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (contentType !== expected.contentType) {
            throw notImage(format, 'content of another type');
        }
        if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
            throw tooLarge();
        }
        const image = await readBody(response.body);
        // An empty answer fails here too.
        if (!image.subarray(0, expected.signature.length).equals(expected.signature)) {
            throw notImage(format, 'other data');
        }
        return image;
    } catch (error) {
        if (response.body !== null && !response.bodyUsed) {
            // Release the connection. The error being thrown is the one that matters,
            // so a stream that already failed must not replace it.
            await response.body.cancel().catch(() => {});
        }
        throw error;
    }
}

module.exports = function (RED) {
    function SiteShotAccountNode(config) {
        RED.nodes.createNode(this, config);
    }

    RED.nodes.registerType('site-shot-account', SiteShotAccountNode, {
        credentials: {
            apiKey: { type: 'password' }
        }
    });

    function SiteShotScreenshotNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const account = RED.nodes.getNode(config.account);
        const waiting = [];
        let active = null;
        let closed = false;
        let settings = null;
        let settingsProblem = null;

        try {
            settings = readSettings(RED, config);
        } catch (error) {
            settingsProblem = error;
            node.error(error.message);
            node.status({ fill: 'red', shape: 'ring', text: error.statusText });
        }

        function apiKey() {
            const key = account && account.credentials ? account.credentials.apiKey : undefined;
            return typeof key === 'string' ? key.trim() : '';
        }

        if (settings !== null && apiKey() === '') {
            node.status({ fill: 'red', shape: 'ring', text: account ? 'no API key' : 'no account' });
        }

        /** Checks everything that can be checked before a request, and builds the request. */
        function prepare(msg) {
            if (settingsProblem !== null) {
                throw settingsProblem;
            }
            if (!account) {
                throw new SiteShotError('SITE_SHOT_SETTINGS', 'Choose a Site-Shot account in this node.', 'no account');
            }
            const key = apiKey();
            if (key === '') {
                throw new SiteShotError('SITE_SHOT_SETTINGS', 'The Site-Shot account node has no API key.', 'no API key');
            }
            const target = captureAddress(RED.util.evaluateNodeProperty(config.url, config.urlType, node, msg), settings.source);
            const query = new URLSearchParams({
                url: target,
                userkey: key,
                format: settings.format,
                response_type: 'image',
                full_size: settings.fullPage ? '1' : '0'
            });
            for (const [name, value] of Object.entries(settings.sizes)) {
                query.set(SIZES[name].param, String(value));
            }
            return { target, requestUrl: `${API_ENDPOINT}?${query}` };
        }

        function fail(error, done) {
            node.status({ fill: 'red', shape: 'ring', text: error.statusText });
            done(error);
        }

        function busyStatus() {
            node.status({ fill: 'blue', shape: 'dot', text: waiting.length > 0 ? `capturing +${waiting.length}` : 'capturing' });
        }

        async function run(job, cancel) {
            busyStatus();
            const timeout = AbortSignal.timeout(settings.timeoutMs);
            let image;
            try {
                image = await capture(job.requestUrl, settings.format, AbortSignal.any([cancel, timeout]));
            } catch (error) {
                // Closing aborts the capture in flight, so a capture still running when the node closed ends here.
                if (closed) {
                    job.done(cancelled(true));
                } else if (error instanceof SiteShotError) {
                    fail(error, job.done);
                } else {
                    fail(timeout.aborted ? timedOut(settings.timeoutMs) : unreachable(error), job.done);
                }
                return;
            }
            job.msg.payload = image;
            job.msg.siteshot = {
                url: job.target,
                format: settings.format,
                contentType: FORMATS[settings.format].contentType,
                fullPage: settings.fullPage,
                ...settings.sizes,
                bytes: image.length,
                capturedAt: new Date().toISOString()
            };
            node.status({ fill: 'green', shape: 'dot', text: `${FORMATS[settings.format].label} ${Math.ceil(image.length / 1024)} kB` });
            job.send(job.msg);
            job.done();
        }

        /** Captures run one at a time, in arrival order. */
        function next() {
            const job = waiting.shift();
            if (job === undefined) {
                return;
            }
            const cancel = new AbortController();
            active = {
                cancel,
                finished: run(job, cancel.signal).then(() => {
                    active = null;
                    if (!closed) {
                        next();
                    }
                })
            };
        }

        node.on('input', function (msg, send, done) {
            if (closed) {
                // Delivered while the node closes: given up like the messages still waiting, never captured.
                done(cancelled(false));
                return;
            }
            let request;
            try {
                request = prepare(msg);
            } catch (error) {
                fail(error, done);
                return;
            }
            if (waiting.length >= MAX_WAITING) {
                fail(new SiteShotError('SITE_SHOT_QUEUE_FULL', `${MAX_WAITING} captures are already waiting in this node, so this message was not captured.`, 'queue full'), done);
                return;
            }
            waiting.push({ msg, send, done, ...request });
            if (active === null) {
                next();
            } else {
                busyStatus();
            }
        });

        node.on('close', function (removed, done) {
            closed = true;
            for (const job of waiting.splice(0)) {
                job.done(cancelled(false));
            }
            node.status({});
            if (active === null) {
                done();
                return;
            }
            active.cancel.abort();
            active.finished.then(() => done());
        });
    }

    RED.nodes.registerType('site-shot-screenshot', SiteShotScreenshotNode, {
        settings: {
            siteShotScreenshotTimeout: { value: DEFAULT_TIMEOUT_MS, exportable: false }
        }
    });
};
