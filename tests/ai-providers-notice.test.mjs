import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, describe } from "node:test";
import {
	AI_PROVIDERS_NOTICE_SENT_ON,
	CHANGE_NOTICE_DAYS,
	getAiProvidersStartDate,
	getAiProvidersStatus,
	getLegalTodos,
	isAiProvidersNoticeOver,
} from "../lib/legal.js";
import { SUBPROCESSORS } from "../lib/subprocessors.js";
import { REGION_DATA, REGION_LEAVES } from "../lib/docs/regions.js";
import { getDirectAiOffReason, getDirectProviders } from "../lib/platform-ai.js";

// Anthropic and Groq are new sub-processors of the text AI, so the terms' 30 days' notice applies as it does to ElevenLabs
// (tests/audio-notice.test.mjs). FlockStack Cloud keeps them off until the owner has sent the notice and set the day in lib/legal.js.

const ROOT = new URL("../", import.meta.url);
const KEYS = ["ANTHROPIC_API_KEY", "GROQ_API_KEY"];

async function readWranglerVars() {
	const text = await readFile(new URL("wrangler.jsonc", ROOT), "utf8");
	const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
	return [["top level", config.vars ?? {}], ...Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}`, env.vars ?? {}])];
}

describe("the Anthropic and Groq sub-processor notice", () => {
	test("no key is committed in wrangler.jsonc", async () => {
		const on = (await readWranglerVars()).filter(([, vars]) => KEYS.some((key) => vars[key])).map(([place]) => place);
		if (on.length === 0) return;
		assert.fail(`A text AI key is set in ${on.join(" and ")}: keys are Worker secrets, never wrangler.jsonc vars (the file is public)`);
	});

	test("the notice day is empty until the owner sets it, or a plain date, never a TODO that would hide the legal pages", () => {
		assert.match(AI_PROVIDERS_NOTICE_SENT_ON, /^(|\d{4}-\d{2}-\d{2})$/);
		assert.ok(!getLegalTodos().some(([name]) => name === "AI_PROVIDERS_NOTICE_SENT_ON"));
	});

	test("the providers may handle data from the notice day plus the notice period, counted in UTC days", () => {
		assert.equal(getAiProvidersStartDate("2026-11-02"), "2026-12-02");
		assert.equal(CHANGE_NOTICE_DAYS, 30);
		for (const bad of ["", "tomorrow", "2026-11-2", undefined]) assert.equal(getAiProvidersStartDate(bad), null, String(bad));
		assert.equal(isAiProvidersNoticeOver(new Date("2026-12-01T23:59:59Z"), "2026-11-02"), false);
		assert.equal(isAiProvidersNoticeOver(new Date("2026-12-02T00:00:00Z"), "2026-11-02"), true);
		assert.equal(isAiProvidersNoticeOver(new Date("2030-01-01T00:00:00Z"), ""), false);
	});

	test("on FlockStack Cloud the keys are ignored until the notice is over, and a self-hosted server uses them at once", () => {
		const keys = { ANTHROPIC_API_KEY: "test-anthropic", GROQ_API_KEY: "test-groq" };
		const cloud = { ...keys, FLOCKSTACK_CLOUD: "true", NODE_ENV: "production" };
		assert.deepEqual(getDirectProviders(cloud, new Date("2026-11-10T00:00:00Z")), []);
		assert.match(getDirectAiOffReason(cloud, new Date("2026-11-10T00:00:00Z")), /notice/);
		assert.deepEqual(getDirectProviders({ ...keys, NODE_ENV: "production" }).map(({ provider }) => provider), ["anthropic", "groq"]);
		assert.deepEqual(getDirectProviders({ ...keys, NODE_ENV: "production", AI_PROVIDERS_DISABLED: "true" }), []);
	});

	test("the sub-processors list names both, what is sent, where, and keeps Briefings' own keys apart", () => {
		for (const name of ["Anthropic", "Groq"]) {
			const entry = SUBPROCESSORS.find((processor) => processor.name === name);
			assert.ok(entry, name);
			assert.match(entry.link, /^https:\/\//);
			assert.match(entry.data, /Never a subscriber's email address|The same text as Anthropic receives/);
			assert.match(entry.data, /FlockStack keeps none of/);
			assert.match(entry.eu, /not in the EU/);
			assert.ok(entry.purpose.endsWith(getAiProvidersStatus()), name);
		}
		assert.match(SUBPROCESSORS.find((processor) => processor.name === "Anthropic").purpose, /never used for a creator's own AI key/i);
	});

	test("Cloudflare's entry no longer claims the text AI as its own once the providers start, and keeps images", () => {
		const cloudflare = SUBPROCESSORS.find((processor) => processor.name === "Cloudflare");
		assert.match(cloudflare.purpose, /image generation on Workers AI/);
		assert.match(cloudflare.purpose, /until the notice for Anthropic and Groq is over/);
	});

	test("the status line promises the notice while the day is empty and gives the dates once it is set", () => {
		assert.match(getAiProvidersStatus(""), /^Not in use yet: until we have emailed account owners and 30 days have passed, these requests are answered by Cloudflare Workers AI\.$/);
		assert.equal(getAiProvidersStatus("2026-11-02"), "We emailed account owners on November 2, 2026. Anthropic and Groq handle these requests from December 2, 2026; before that day Cloudflare Workers AI answered them.");
	});

	test("the regions page names the text AI wherever it used to name Workers AI, apart from images", () => {
		const rows = REGION_DATA.filter(({ what }) => /support assistant|AI writing tools|translations|account-assistant|Reply Rules/.test(what));
		assert.ok(rows.length >= 5);
		for (const row of rows) assert.match(`${row.us} ${row.eu}`, /Anthropic/, row.what);
		const images = REGION_DATA.find(({ what }) => /AI image/.test(what));
		assert.match(images.us, /Workers AI/);
		assert.ok(REGION_LEAVES.some((line) => line.startsWith("The text AI. ")));
	});
});
