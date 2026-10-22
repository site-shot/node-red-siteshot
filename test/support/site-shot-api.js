'use strict';

// Stands in for the Site-Shot API. Global fetch is pointed at an undici
// MockAgent that answers https://api.site-shot.com as each test tells it to and
// fails every other request; every capture request is recorded. No connection
// is ever made, and the network guard (no-network.js) would refuse one anyway.

const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');

const ORIGIN = 'https://api.site-shot.com';

/** Request headers as a plain object with lower-case names; fetch passes them as a flat array. */
function headerObject(headers) {
    const pairs = [];
    if (Array.isArray(headers)) {
        for (let i = 0; i < headers.length; i += 2) {
            pairs.push([headers[i], headers[i + 1]]);
        }
    } else {
        pairs.push(...Object.entries(headers || {}));
    }
    return Object.fromEntries(pairs.map(([name, value]) => [String(name).toLowerCase(), String(value)]));
}

class SiteShotApi {
    constructor() {
        /** Every request made, as { method, url, headers }, in order. */
        this.requests = [];
        /** Called with each request as it arrives. */
        this.onRequest = null;
        this.agent = new MockAgent();
        this.agent.disableNetConnect();
        this.previousDispatcher = getGlobalDispatcher();
        setGlobalDispatcher(this.agent);
    }

    /**
     * Answers the next `times` requests to `origin`. `answer` is { status, body, headers },
     * or { error } to fail the request as a transport error, or a function from the
     * request to one of those. `delay` holds the answer back, in milliseconds.
     */
    reply(answer, { delay = 0, times = 1, origin = ORIGIN } = {}) {
        let answered = 0;
        const scope = this.agent.get(origin)
            // Stops matching once used up; undici does not count the answers that are transport errors.
            .intercept({ path: () => answered < times, method: () => true })
            .reply((options) => {
                answered += 1;
                const request = { method: options.method, url: new URL(options.path, origin), headers: headerObject(options.headers) };
                this.requests.push(request);
                if (this.onRequest) {
                    this.onRequest(request);
                }
                const { status, body = '', headers = {}, error } = typeof answer === 'function' ? answer(request) : answer;
                if (error) {
                    throw error;
                }
                return { statusCode: status, data: body, responseOptions: { headers } };
            });
        scope.times(times);
        if (delay > 0) {
            scope.delay(delay);
        }
    }

    async close() {
        setGlobalDispatcher(this.previousDispatcher);
        await this.agent.close();
    }
}

module.exports = { ORIGIN, SiteShotApi };
