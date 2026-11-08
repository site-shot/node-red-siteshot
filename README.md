# @site-shot/node-red-siteshot

Node-RED nodes that capture a public web page as a PNG, JPEG or WebP screenshot with the [Site-Shot](https://www.site-shot.com/) API. The screenshot comes out of the node as a Buffer in `msg.payload`, ready for a **write file** node or any other node that takes binary data.

## Requirements

- Node-RED 4.0 or later, including 5.x, on Node.js 20.3 or later.
- A Site-Shot API key: get it at <https://www.site-shot.com/start/>. The key of an account with a confirmed email includes the free plan, 100 API captures a month with no card needed; paid plans start at $5 a month for 2,000 captures ([pricing](https://www.site-shot.com/pricing/)). Every capture counts toward the plan.

## Install

In the Node-RED editor, open **Menu > Manage palette > Install**, search for `site-shot` and install **@site-shot/node-red-siteshot**.

Or, in the Node-RED user directory, usually `~/.node-red`, run the following and restart Node-RED:

```sh
npm install @site-shot/node-red-siteshot
```

To install from source instead, run `npm pack` in this repository, then run `npm install <path to site-shot-node-red-siteshot-0.1.0.tgz>` in your Node-RED user directory and restart Node-RED.

## Get started

1. Drag a **site-shot** node from the network category into a flow. In its **Account** field, add a **Site-Shot account** and paste your API key into it; you find the key at <https://www.site-shot.com/start/>. The key is a Node-RED credential: it is not saved in the flow, never exported with it, and saving it does not contact Site-Shot.
2. Send the node a message whose `msg.payload` is the address of a public page, such as `https://www.example.com/`. The node can also read the address from another message property, or use a fixed one.
3. Wire the node's output to a **write file** node, or to any node that takes a Buffer.

The node's help in the editor describes its settings, the properties of the message it sends, and the error codes it reports.

## Examples

Import them with **Menu > Import > Examples > @site-shot/node-red-siteshot**:

- **01 - Capture one page to a file**: one click captures one page and writes it to a new file.
- **02 - Capture a list of pages to files**: one click captures every page in a list, one after another, each into its own file.

Both write into a `site-shot` folder in the Node-RED working directory (the `fileWorkingDirectory` setting, or else the directory Node-RED was started from), under a new name for every screenshot, and show failures in the debug sidebar. In the official Docker image that directory is `/usr/src/node-red` inside the container, not the `/data` volume, so the files are lost when the container is recreated; set `fileWorkingDirectory: '/data'` in `settings.js` to keep them in `/data/site-shot`. Neither runs when it is deployed or when Node-RED starts: they capture only when their inject button is clicked. To capture on a schedule, set **Repeat** in the inject node; every run is more captures from your plan.

## Behaviour to know

- **One message, one capture.** A failed capture is reported to Catch nodes and is not retried, because every attempt can count toward the plan. Redirects are not followed.
- **Public pages only.** An address must start with `http://` or `https://`. Addresses with a user name or password, and addresses on a local or private network such as `localhost` or `192.168.1.10`, are refused before anything is sent. The node does not resolve host names; Site-Shot refuses an address it must not capture.
- **Page options.** Besides the format and the size, the node can remove cookie banners, block ads and wait a set delay after the page has loaded. WebP images are at most 16,383 pixels tall.
- **One capture at a time per node**, in the order messages arrive. Up to 1000 messages wait their turn; more are refused.
- **Limits.** A capture fails without an answer within 120 seconds, though Site-Shot may still finish it and count it, and a screenshot larger than 64 MiB is refused.
- **Behind an HTTP proxy**, start Node-RED with the environment variable `NODE_USE_ENV_PROXY=1`, so that `HTTPS_PROXY` and `NO_PROXY` apply to the node's requests. This works on Node.js 24 and recent Node.js 22 releases, not on Node.js 20. The requests still go only to `https://api.site-shot.com/`.
- **Stopping and redeploying** cancels the capture in flight, which Site-Shot may still finish and count, and the messages still waiting. Each of them fails with `SITE_SHOT_CANCELLED`, so it never triggers a Complete node.
- **The API key** is sent only to `https://api.site-shot.com/`, in the `userkey` query parameter that the capture API requires. It is never part of a message, the node status, an error or a log entry.

To change the time limit, set `siteShotScreenshotTimeout` in the Node-RED settings file, in milliseconds from 1 to 600000:

```js
siteShotScreenshotTimeout: 300000,
```

## License

MIT
