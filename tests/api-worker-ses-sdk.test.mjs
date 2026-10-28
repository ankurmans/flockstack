import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApiWorker } from "../scripts/build-api-worker.mjs";

// The lean Workers (API, readers, briefings) bundle the AWS SDK with the `browser` condition, so its packages come in as their
// browser builds, where Node-only exports are placeholders. A client's runtime config must then be its browser one too: the Node
// one calls those placeholders (emitWarningIfUnsupportedVersion is not a function) and every SES call fails. The SDK is bundled
// here with the API Worker's own build settings and a send goes out through a stubbed fetch, as it would on Workers.
let folder;
let bundle;

before(async () => {
	folder = mkdtempSync(join(tmpdir(), "flockstack-ses-sdk-"));
	const entry = fileURLToPath(new URL("./fixtures/ses-sdk-entry.js", import.meta.url));
	const outFile = join(folder, "index.js");
	await buildApiWorker({ entry, outFile, metafile: true });
	bundle = { outFile, meta: JSON.parse(readFileSync(`${outFile}.meta.json`, "utf8")) };
});

after(() => rmSync(folder, { recursive: true, force: true }));

test("the SES client comes in with its browser runtime config, not the Node one", () => {
	const inputs = Object.keys(bundle.meta.inputs).filter((input) => input.includes("@aws-sdk/client-sesv2/"));
	assert.ok(inputs.some((input) => input.endsWith("runtimeConfig.browser.js")), inputs.join("\n"));
	assert.ok(!inputs.some((input) => input.endsWith("/runtimeConfig.js")), inputs.join("\n"));
});

test("a send through the bundled client reaches SES by fetch", async () => {
	const real = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (request, init) => {
		const url = typeof request === "string" ? request : request.url;
		calls.push({ url, method: init?.method ?? request.method });
		return new Response(JSON.stringify({ MessageId: "test-message-id" }), { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		const { sendOne } = await import(pathToFileURL(bundle.outFile).href);
		const answer = await sendOne();
		assert.equal(answer.MessageId, "test-message-id");
	} finally {
		globalThis.fetch = real;
	}
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /^https:\/\/email\.us-east-2\.amazonaws\.com\/v2\/email\/outbound-emails/);
	assert.equal(calls[0].method, "POST");
});
