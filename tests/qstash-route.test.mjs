import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SignJWT } from "jose";
import { withQStashSignature } from "../lib/qstash-route.js";

// The jobs' signature check with QStash's own verifier, which every other test stubs out: signed requests run their
// job, anything else answers 403 without running it.
const { verifySignatureAppRouter } = await import(new URL("../node_modules/@upstash/qstash/nextjs.mjs", import.meta.url).href);

const JOB_URL = "https://mailcheap.ai/api/jobs/send-batch";
const KEYS = { QSTASH_CURRENT_SIGNING_KEY: "test-current-signing-key-0123456789", QSTASH_NEXT_SIGNING_KEY: "test-next-signing-key-0123456789" };
const BODY = JSON.stringify({ accountId: "6a0000000000000000000001", messageIds: ["6a0000000000000000000002"] });
const saved = {};

// What QStash sends: an HS256 JWT from Upstash, with the destination and the body's SHA-256.
async function sign({ body = BODY, key = KEYS.QSTASH_CURRENT_SIGNING_KEY } = {}) {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ body: createHash("sha256").update(body).digest("base64url") })
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuer("Upstash")
		.setSubject(JOB_URL)
		.setIssuedAt(now)
		.setNotBefore(now)
		.setExpirationTime(now + 300)
		.setJti("test-message")
		.sign(new TextEncoder().encode(key));
}

function post(signature, body = BODY) {
	return new Request(JOB_URL, {
		method: "POST",
		headers: { "content-type": "application/json", ...(signature && { "upstash-signature": signature }) },
		body,
	});
}

function route(job = async () => Response.json({ ok: true })) {
	const runs = [];
	const POST = withQStashSignature(
		async (request) => {
			runs.push(await request.clone().text());
			return job(request);
		},
		{ verify: verifySignatureAppRouter }
	);
	return { POST, runs };
}

describe("QStash job signatures", () => {
	beforeEach(() => {
		for (const name of [...Object.keys(KEYS), "QSTASH_DEV"]) saved[name] = process.env[name];
		Object.assign(process.env, KEYS);
		delete process.env.QSTASH_DEV;
	});

	afterEach(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	test("a request QStash signed runs its job", async () => {
		const { POST, runs } = route();
		const response = await POST(post(await sign()));
		assert.equal(response.status, 200);
		assert.deepEqual(runs, [BODY]);
	});

	test("the next signing key works too, for QStash's key rotation", async () => {
		const { POST, runs } = route();
		assert.equal((await POST(post(await sign({ key: KEYS.QSTASH_NEXT_SIGNING_KEY })))).status, 200);
		assert.equal(runs.length, 1);
	});

	test("a signature that doesn't verify answers 403 and runs nothing, instead of a server error", async () => {
		const { POST, runs } = route();
		const forged = [
			undefined,
			"not-a-jwt",
			await sign({ key: "someone-elses-signing-key-0123456789" }),
			await sign({ body: JSON.stringify({ accountId: "6a0000000000000000000009", messageIds: [] }) }),
		];
		for (const signature of forged) assert.equal((await POST(post(signature))).status, 403, String(signature).slice(0, 20));
		assert.deepEqual(runs, []);
	});

	test("QSTASH_DEV can't swap the signing keys for QStash's public development ones", async () => {
		process.env.QSTASH_DEV = "true";
		const { POST, runs } = route();
		assert.equal((await POST(post(await sign()))).status, 200);
		assert.equal(runs.length, 1);
	});

	test("a job that fails still fails the request, so QStash retries it", async () => {
		const { POST } = route(async () => {
			throw new Error("The database is down");
		});
		await assert.rejects(POST(post(await sign())), /The database is down/);
	});

	test("without signing keys, jobs answer 503", async () => {
		delete process.env.QSTASH_NEXT_SIGNING_KEY;
		const { POST, runs } = route();
		assert.equal((await POST(post(await sign()))).status, 503);
		assert.deepEqual(runs, []);
	});
});
