import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
	DEFAULT_AUDIO_FORMAT,
	DEFAULT_AUDIO_MODEL,
	findVoice,
	getAudioFormat,
	getAudioModel,
	getAudioOffReason,
	getAudioUrl,
	getBytesPerSecond,
	getModelInfo,
	getVoices,
	isAudioEnabled,
	parseVoices,
} from "../lib/audio-config.js";
import { AUDIO_COST, AUDIO_CHARACTERS_PER_MONTH, FREE_PLAN, PLANS, getAudioLimit } from "../lib/plans.js";

const VOICES = JSON.stringify([
	{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Calm, clear", previewUrl: "https://example.com/rachel.mp3" },
	{ id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", description: "Strong", preview_url: "https://example.com/domi.mp3" },
]);
const CLOUD = { FLOCKSTACK_CLOUD: "true", ELEVENLABS_VOICES: VOICES };

describe("the voices the owner sets", () => {
	test("are read from ELEVENLABS_VOICES in the order written, with a preview URL each", () => {
		const voices = getVoices({ ELEVENLABS_VOICES: VOICES });
		assert.deepEqual(
			voices.map(({ id, name, description, previewUrl }) => ({ id, name, description, previewUrl })),
			[
				{ id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", description: "Calm, clear", previewUrl: "https://example.com/rachel.mp3" },
				{ id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", description: "Strong", previewUrl: "https://example.com/domi.mp3" },
			]
		);
		assert.equal(findVoice("AZnzlk1XvdvUeBnXmlld", { ELEVENLABS_VOICES: VOICES }).name, "Domi");
		assert.equal(findVoice("nobody", { ELEVENLABS_VOICES: VOICES }), null);
	});

	test("leave out an entry without a usable id or name, repeats and a preview that isn't https", () => {
		const voices = parseVoices(
			JSON.stringify([
				{ id: "short", name: "Bad id" },
				{ id: "validvoiceid01", name: "" },
				{ id: "validvoiceid02", name: "Good", previewUrl: "http://example.com/a.mp3" },
				{ id: "validvoiceid02", name: "Again" },
				"text",
				null,
			])
		);
		assert.deepEqual(voices, [{ id: "validvoiceid02", name: "Good", description: "", previewUrl: null }]);
	});

	test("are none when the variable is unset, empty, not JSON or not a list", () => {
		for (const value of [undefined, "", "   ", "not json", "{}", '"x"']) assert.deepEqual(parseVoices(value), [], String(value));
	});
});

describe("the model and format come from the environment", () => {
	test("default to Multilingual v2 and 128 kbps MP3 at 44.1 kHz", () => {
		assert.equal(DEFAULT_AUDIO_MODEL, "eleven_multilingual_v2");
		assert.equal(getAudioModel({}), "eleven_multilingual_v2");
		assert.equal(getAudioFormat({}), "mp3_44100_128");
		assert.equal(DEFAULT_AUDIO_FORMAT, "mp3_44100_128");
	});

	test("take ELEVENLABS_MODEL and an MP3 ELEVENLABS_OUTPUT_FORMAT, and ignore a format the parts couldn't be joined in", () => {
		assert.equal(getAudioModel({ ELEVENLABS_MODEL: " eleven_flash_v2_5 " }), "eleven_flash_v2_5");
		assert.equal(getAudioFormat({ ELEVENLABS_OUTPUT_FORMAT: "mp3_44100_64" }), "mp3_44100_64");
		for (const format of ["pcm_44100", "opus_48000_128", "wav_44100", "mp3_nonsense"]) assert.equal(getAudioFormat({ ELEVENLABS_OUTPUT_FORMAT: format }), "mp3_44100_128", format);
	});

	test("know each model's characters per request and whether it stitches, from ElevenLabs' docs", () => {
		assert.deepEqual(getModelInfo("eleven_multilingual_v2"), { maxChars: 10_000, stitching: true });
		assert.deepEqual(getModelInfo("eleven_flash_v2_5"), { maxChars: 40_000, stitching: true });
		assert.deepEqual(getModelInfo("eleven_v3"), { maxChars: 5_000, stitching: false });
		assert.deepEqual(getModelInfo("a_model_from_next_year"), { maxChars: 5_000, stitching: true });
	});

	test("a file's length comes from its size at the bit rate", () => {
		assert.equal(getBytesPerSecond("mp3_44100_128"), 16_000);
		assert.equal(getBytesPerSecond("mp3_44100_64"), 8_000);
	});
});

describe("audio versions are off until everything is in place", () => {
	const OVER = new Date("2027-01-01T00:00:00Z");

	test("hidden without voices", () => {
		assert.equal(isAudioEnabled({ FLOCKSTACK_CLOUD: "true", AUDIO_ENABLED: "true", NODE_ENV: "test", ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-10-01" }, OVER), false);
		assert.match(getAudioOffReason({ FLOCKSTACK_CLOUD: "false" }), /ELEVENLABS_VOICES/);
	});

	test("on FlockStack Cloud they need AUDIO_ENABLED=true", () => {
		const env = { ...CLOUD, NODE_ENV: "test", ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-10-01" };
		assert.equal(isAudioEnabled(env, OVER), false);
		assert.match(getAudioOffReason(env, OVER), /AUDIO_ENABLED/);
		for (const value of ["TRUE", "1", "yes", "false"]) assert.equal(isAudioEnabled({ ...env, AUDIO_ENABLED: value }, OVER), false, value);
		assert.equal(isAudioEnabled({ ...env, AUDIO_ENABLED: "true" }, OVER), true);
	});

	test("on FlockStack Cloud the flag alone is not enough: the 30 days' notice has to be over", () => {
		const env = { ...CLOUD, AUDIO_ENABLED: "true", NODE_ENV: "test" };
		// The real notice date is the owner's to set in lib/legal.js and is empty here, so the flag does nothing.
		assert.equal(isAudioEnabled({ ...env, NODE_ENV: "production" }, OVER), false);
		assert.match(getAudioOffReason({ ...env, NODE_ENV: "production" }, OVER), /notice/);
		// A day set for a test counts only while testing.
		assert.equal(isAudioEnabled({ ...env, ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-10-01" }, new Date("2026-10-30T23:59:59Z")), false);
		assert.equal(isAudioEnabled({ ...env, ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-10-01" }, new Date("2026-10-31T00:00:00Z")), true);
		assert.equal(isAudioEnabled({ ...env, NODE_ENV: "production", ELEVENLABS_NOTICE_SENT_ON_TEST: "2026-10-01" }, OVER), false);
	});

	test("a self-hosted server needs only its voices", () => {
		assert.equal(isAudioEnabled({ ELEVENLABS_VOICES: VOICES }), true);
		assert.equal(isAudioEnabled({ FLOCKSTACK_CLOUD: "false", ELEVENLABS_VOICES: VOICES, AUDIO_ENABLED: "false" }), true);
	});
});

describe("addresses of the audio", () => {
	test("an issue's file is /audio/<slug>.mp3 on the newsletter's host with the file's version, a feed's enclosure without", () => {
		const urls = { absoluteAudio: (slug) => `https://news.example.com/audio/${slug}.mp3` };
		const file = { readyAt: new Date("2026-10-20T07:10:00Z") };
		assert.equal(getAudioUrl(urls, "issue-12", file), "https://news.example.com/audio/issue-12.mp3?v=1792480200000");
		assert.equal(getAudioUrl(urls, "issue-12", file, { versioned: false }), "https://news.example.com/audio/issue-12.mp3");
	});
});

describe("the quota of each plan", () => {
	test("is one constant per plan, none for an account without a plan, an admin's number over the plan's, no limit self-hosted", () => {
		assert.deepEqual(Object.keys(AUDIO_CHARACTERS_PER_MONTH), ["free", ...PLANS.map(({ id }) => id)]);
		const previous = process.env.FLOCKSTACK_CLOUD;
		try {
			process.env.FLOCKSTACK_CLOUD = "true";
			assert.equal(getAudioLimit({ plan: "starter", subscriptionStatus: "active" }), 11_000);
			assert.equal(getAudioLimit({ plan: "max", subscriptionStatus: "active" }), 373_000);
			assert.equal(getAudioLimit({ plan: "max", subscriptionStatus: "active", limitOverrides: { audioCharactersPerMonth: 5 } }), 5);
			assert.equal(getAudioLimit({ plan: "max", subscriptionStatus: "active", limitOverrides: { audioCharactersPerMonth: 0 } }), 0);
			assert.equal(getAudioLimit({ subscriptionStatus: "canceled" }), 0, "a lapsed plan is the Free plan");
			assert.equal(getAudioLimit({}), 0);
			assert.equal(AUDIO_CHARACTERS_PER_MONTH.free, 0);
			assert.equal(FREE_PLAN.id, "free");
			process.env.FLOCKSTACK_CLOUD = "false";
			assert.equal(getAudioLimit({ plan: "starter", subscriptionStatus: "active" }), null);
		} finally {
			if (previous === undefined) delete process.env.FLOCKSTACK_CLOUD;
			else process.env.FLOCKSTACK_CLOUD = previous;
		}
	});

	test("costs the owner at most about 10% of the plan's monthly price at ElevenLabs' dearest API rate", () => {
		assert.equal(AUDIO_COST.pricePerThousandCharacters, 0.08);
		for (const { id, name, monthlyPrice } of PLANS) {
			const cost = (AUDIO_CHARACTERS_PER_MONTH[id] / 1000) * AUDIO_COST.pricePerThousandCharacters;
			assert.ok(cost <= monthlyPrice * AUDIO_COST.shareOfPlanPrice, `${name} costs $${cost.toFixed(2)} of $${monthlyPrice}`);
			assert.ok(cost >= monthlyPrice * 0.095, `${name} leaves its share unused: $${cost.toFixed(2)} of $${monthlyPrice}`);
		}
	});
});
