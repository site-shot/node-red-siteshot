'use strict';

// What the tests share: a dummy API key, and small synthetic images that stand
// in for screenshots (made with ImageMagick; not captures of any page).

const fs = require('node:fs');
const path = require('node:path');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));

module.exports = {
    /**
     * Not a real key: lower-case words, which the repository's secret scanner takes for a placeholder.
     * URL-safe, so it reads the same in a request URL and can be found wherever it might leak.
     */
    KEY: 'dummy-api-key-for-tests',
    RED_PNG: fixture('red.png'),
    GREEN_PNG: fixture('green.png'),
    BLUE_PNG: fixture('blue.png'),
    /** Like the image Site-Shot sends with a 403 or 404. */
    PLACEHOLDER_PNG: fixture('placeholder.png'),
    YELLOW_JPEG: fixture('yellow.jpg'),
    PURPLE_WEBP: fixture('purple.webp'),
    PNG: { 'content-type': 'image/png' },
    JPEG: { 'content-type': 'image/jpeg' },
    WEBP: { 'content-type': 'image/webp' },
    settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    /** Waits until `condition()` holds, for at most 3 seconds. */
    async until(condition, what) {
        const deadline = Date.now() + 3000;
        while (!condition()) {
            if (Date.now() > deadline) {
                throw new Error(`timed out waiting for ${what}`);
            }
            await module.exports.settle(5);
        }
    }
};
