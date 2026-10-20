import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { ElevenLabsError, synthesizeSpeech } from "../lib/elevenlabs.js";

// The real client against a fake network: the request ElevenLabs' text-to-speech reference describes (endpoint, key header,
// output_format in the query, previous_request_ids up to 3, previous_text only without ids, next_text), and what each answer
// becomes. The key is read from the environment and never shows up in an error.

const KEY = "xi-test-key-never-print-0123456789";
const ENV = { ELEVENLABS_API_KEY: KEY };
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);

function fakeFetch(answer) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url: String(url), init, body: JSON.parse(init.body) });
		return typeof answer === "function" ? answer(calls.length) : answer.clone();
	};
	return { calls, fetchImpl };
}

const audio = (id = "req_abc") => new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg", ...(id && { "request-id": id }) } });
const params = { voiceId: "21m00Tcm4TlvDq8ikWAM", text: "Hello there.", modelId: "eleven_multilingual_v2", outputFormat: "mp3_44100_128" };

describe("the request", () => {
	test("posts the text to the voice's text-to-speech endpoint with the key in xi-api-key and the format in the query", async () => {
		const { calls, fetchImpl } = fakeFetch(audio());
		const result = await synthesizeSpeech(params, { env: ENV, fetchImpl });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128");
		assert.equal(calls[0].init.method, "POST");
		assert.equal(calls[0].init.headers["xi-api-key"], KEY);
		assert.equal(calls[0].init.headers["content-type"], "application/json");
		assert.deepEqual(calls[0].body, { text: "Hello there.", model_id: "eleven_multilingual_v2" });
		assert.deepEqual([...result.bytes], [...MP3]);
		assert.equal(result.requestId, "req_abc");
	});

	test("ties a part to the ones before it with request ids, the last three, oldest first, and then ignores previous_text", async () => {
		const { calls, fetchImpl } = fakeFetch(audio());
		await synthesizeSpeech({ ...params, previousRequestIds: ["r1", "r2", "r3", "r4"], previousText: "Words before.", nextText: "Words after." }, { env: ENV, fetchImpl });
		assert.deepEqual(calls[0].body, {
			text: "Hello there.",
			model_id: "eleven_multilingual_v2",
			previous_request_ids: ["r2", "r3", "r4"],
			next_text: "Words after.",
		});
	});

	test("without request ids it sends the text before, and sends neither for a part that starts the audio", async () => {
		const { calls, fetchImpl } = fakeFetch(audio());
		await synthesizeSpeech({ ...params, previousText: "Words before.", nextText: "Words after." }, { env: ENV, fetchImpl });
		await synthesizeSpeech(params, { env: ENV, fetchImpl });
		assert.deepEqual(calls[0].body, { text: "Hello there.", model_id: "eleven_multilingual_v2", previous_text: "Words before.", next_text: "Words after." });
		assert.deepEqual(Object.keys(calls[1].body), ["text", "model_id"]);
	});

	test("goes to ELEVENLABS_API_BASE when the owner sets one, and encodes the voice", async () => {
		const { calls, fetchImpl } = fakeFetch(audio());
		await synthesizeSpeech({ ...params, voiceId: "a/b c" }, { env: { ...ENV, ELEVENLABS_API_BASE: "https://api.us.elevenlabs.io/" }, fetchImpl });
		assert.equal(calls[0].url, "https://api.us.elevenlabs.io/v1/text-to-speech/a%2Fb%20c?output_format=mp3_44100_128");
	});

	test("a missing key is a setup problem and sends nothing", async () => {
		const { calls, fetchImpl } = fakeFetch(audio());
		await assert.rejects(synthesizeSpeech(params, { env: {}, fetchImpl }), (error) => error instanceof ElevenLabsError && error.setup && !error.retryable);
		assert.equal(calls.length, 0);
	});
});

describe("the answers", () => {
	async function failure(response, env = ENV) {
		const { fetchImpl } = fakeFetch(response);
		try {
			await synthesizeSpeech(params, { env, fetchImpl });
		} catch (error) {
			return error;
		}
		assert.fail("it should have failed");
	}

	test("a busy service (429) and its own errors (5xx) are worth trying again", async () => {
		for (const status of [429, 500, 502, 503]) {
			const error = await failure(new Response(JSON.stringify({ detail: { status: "too_many_concurrent_requests", message: "slow down" } }), { status }));
			assert.ok(error instanceof ElevenLabsError);
			assert.equal(error.retryable, true, String(status));
			assert.equal(error.setup, false);
			assert.equal(error.status, status);
		}
	});

	test("a refused key, no credit left and a missing voice are the owner's to fix, and no retry changes them", async () => {
		for (const [status, detail] of [[401, { status: "invalid_api_key", message: "bad key" }], [403, { message: "no" }], [401, { status: "quota_exceeded", message: "out" }], [402, "pay"], [404, { status: "voice_not_found" }]]) {
			const error = await failure(new Response(JSON.stringify({ detail }), { status }));
			assert.equal(error.setup, true, `${status}`);
			assert.equal(error.retryable, false);
		}
	});

	test("text the service refuses (400, 422) fails for good, with its reason", async () => {
		const error = await failure(new Response(JSON.stringify({ detail: [{ loc: ["body", "text"], msg: "too long", type: "value_error" }] }), { status: 422 }));
		assert.equal(error.retryable, false);
		assert.equal(error.setup, false);
		assert.match(error.message, /refused this text/);
	});

	test("an empty answer and a network failure are tried again; a timeout says so", async () => {
		const empty = await failure(new Response(new Uint8Array(), { status: 200 }));
		assert.equal(empty.retryable, true);
		const { fetchImpl } = fakeFetch(() => {
			throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
		});
		await assert.rejects(synthesizeSpeech(params, { env: ENV, fetchImpl }), (error) => error.retryable && /couldn't be reached/.test(error.message));
		const timeout = fakeFetch(() => {
			throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
		});
		await assert.rejects(synthesizeSpeech(params, { env: ENV, fetchImpl: timeout.fetchImpl }), (error) => error.retryable && /took too long/.test(error.message));
	});

	test("no answer names the key or the vendor, so nothing of either reaches a customer or a log", async () => {
		for (const status of [401, 422, 429, 500]) {
			const error = await failure(new Response(JSON.stringify({ detail: { message: "whatever" } }), { status }));
			assert.ok(!error.message.includes(KEY));
			assert.ok(!JSON.stringify(error).includes(KEY));
			assert.doesNotMatch(error.message, /eleven/i);
		}
	});
});
