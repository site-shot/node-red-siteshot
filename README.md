# @site-shot/node-red-siteshot

Node-RED nodes that capture a public web page as a PNG or JPEG screenshot with the [Site-Shot](https://www.site-shot.com/) API. The screenshot comes out of the node as a Buffer in `msg.payload`, ready for a **write file** node or any other node that takes binary data.

## Validation and distribution status

Version 0.1.0, as of 2026-10-22:

- **Offline tests:** 98/98 passed independently on both Node.js 22.9.0 and 24.10.0 with Node-RED 5.0.8. These tests use a mocked Site-Shot API.
- **Native editor:** the packed package installs, registers its nodes and imports its examples in Node-RED 5.0.8. API keys use Node-RED credential storage, not exported flow JSON.
- **Live API:** three single manual requests through Node-RED 5.0.8 on Node.js 24.10.0 saved PNG viewport, JPEG viewport and full-page PNG images of `https://example.com/`. All three were decoded and visually inspected. The page was short (1280 x 800 in each result), so this does not demonstrate scrolling or stitching a long page. No retry was used.
- **Distribution:** the package is published on npm as `@site-shot/node-red-siteshot`; source is available under MIT. Node-RED Flow Library listing is a separate step. Publication is not Node-RED certification.

## Requirements

- Node-RED 4.0 or later, including 5.x, on Node.js 20.3 or later.
- A Site-Shot API key: get it at <https://www.site-shot.com/start/>. The key of an account with a confirmed email includes the free plan, 100 API captures a month with no card needed; paid plans start at $5 a month for 2,000 captures ([pricing](https://www.site-shot.com/pricing/)). Every capture counts toward the plan.

## Install

In the Node-RED user directory, usually `~/.node-red`, run:

```sh
npm install @site-shot/node-red-siteshot
```

Then restart Node-RED. Once the package is listed in the Node-RED Flow Library, you can also install it with **Menu > Manage palette > Install**.

To install from source instead, run `npm pack` in this repository, then run `npm install <path to site-shot-node-red-siteshot-0.1.0.tgz>` in your Node-RED user directory and restart Node-RED.

## Get started

1. Drag a **site-shot** node from the network category into a flow. In its **Account** field, add a **Site-Shot account** and paste your API key into it. The key is a Node-RED credential: it is not saved in the flow, never exported with it, and saving it does not contact Site-Shot.
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
- **One capture at a time per node**, in the order messages arrive. Up to 1000 messages wait their turn; more are refused.
- **Limits.** A capture fails without an answer within 120 seconds, and a screenshot larger than 64 MiB is refused.
- **Stopping and redeploying** cancels the capture in flight, which Site-Shot may still finish and count, and the messages still waiting. Each of them fails with `SITE_SHOT_CANCELLED`, so it never triggers a Complete node.
- **The API key** is sent only to `https://api.site-shot.com/`, in the `userkey` query parameter that the capture API requires. It is never part of a message, the node status, an error or a log entry.

To change the time limit, set `siteShotScreenshotTimeout` in the Node-RED settings file, in milliseconds from 1 to 600000:

```js
siteShotScreenshotTimeout: 300000,
```

## License

MIT
