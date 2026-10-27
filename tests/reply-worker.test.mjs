import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { anonymous, startTestApp, withEnv } from "./helpers/app.mjs";
import worker from "../workers/replies/index.js";
let app;
before(async () => { app = await startTestApp(); });
after(() => app?.stop());
test("the inbound service binding reaches the app middleware and signs the envelope and plain text", async () => {
	const { proxy } = await import("../proxy.js"); const { NextRequest } = await import("next/server");
	const { verifyReplyIngest } = await import("../lib/reply-ingest-auth.js");
	const raw = "From: Forged <header@example.com>\r\nTo: reply@example.com\r\nMessage-ID: <synthetic@example.com>\r\nSubject: Re: Issue\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA private reply.";
	let delivered = 0;
	await withEnv({ REPLY_INGEST_SECRET: "synthetic-ingest-test-secret" }, () => worker.email({ raw: new Blob([raw]).stream(), rawSize: raw.length, to: "reply@example.com", from: "reader@example.com", setReject(reason) { assert.fail(reason); } }, {
		REPLY_INGEST_SECRET: "synthetic-ingest-test-secret",
		APP: { async fetch(url, options) {
			assert.equal(new URL(url).hostname, "localhost");
			const request = new NextRequest(url, options);
			assert.equal((await anonymous(() => proxy(request))).headers.get("x-middleware-next"), "1");
			assert.equal(verifyReplyIngest(request.headers.get("x-flockstack-reply"), options.body), true);
			const body = JSON.parse(options.body); assert.equal(body.from, "reader@example.com"); assert.equal(body.text.trim(), "A private reply.");
			delivered++; return new Response(null, { status: 204 });
		} },
	}));
	assert.equal(delivered, 1);
});
test("capability and consent endpoints reach their own guards without an owner session", async () => {
	const { proxy } = await import("../proxy.js"); const { NextRequest } = await import("next/server");
	for (const path of ["/api/agent-workspaces", "/api/agent-workspaces/synthetic", "/api/reader-subscriptions", "/api/inbound-replies"]) {
		const response = await anonymous(() => proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { host: "localhost:3000" } })));
		assert.equal(response.headers.get("x-middleware-next"), "1", path);
	}
});
