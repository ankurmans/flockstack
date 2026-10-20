import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, describe } from "node:test";
import {
	CHANGE_NOTICE_DAYS,
	ELEVENLABS_NOTICE_SENT_ON,
	getElevenLabsStartDate,
	getElevenLabsStatus,
	getLegalTodos,
	isElevenLabsNoticeOver,
} from "../lib/legal.js";
import { SUBPROCESSORS } from "../lib/subprocessors.js";

// The terms promise CHANGE_NOTICE_DAYS days' notice by email before a new sub-processor handles data. Audio versions send
// issue text to ElevenLabs, so FlockStack Cloud keeps them off until the owner has sent that notice and says so in
// lib/legal.js. These tests fail, loudly, when the switch is on without it.

const ROOT = new URL("../", import.meta.url);

async function readWranglerVars() {
	const text = await readFile(new URL("wrangler.jsonc", ROOT), "utf8");
	const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
	return [["top level", config.vars ?? {}], ...Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}`, env.vars ?? {}])];
}

describe("the ElevenLabs sub-processor notice", () => {
	test("AUDIO_ENABLED is not on anywhere without a notice date that is old enough", async () => {
		const places = [["the environment running the tests", process.env], ...(await readWranglerVars())];
		const on = places.filter(([, vars]) => vars.AUDIO_ENABLED === "true").map(([place]) => place);
		if (on.length === 0) return;
		const where = `AUDIO_ENABLED is true in ${on.join(" and ")}`;
		assert.notEqual(ELEVENLABS_NOTICE_SENT_ON, "", `${where}, but ELEVENLABS_NOTICE_SENT_ON in lib/legal.js is empty: the 30 days' notice of ElevenLabs hasn't been sent. Turn the flag off, or send the notice and set the date.`);
		assert.ok(getElevenLabsStartDate(), `${where}, but ELEVENLABS_NOTICE_SENT_ON (${ELEVENLABS_NOTICE_SENT_ON}) is not a date like 2026-11-02`);
		assert.ok(isElevenLabsNoticeOver(), `${where}, but the notice sent on ${ELEVENLABS_NOTICE_SENT_ON} runs until ${getElevenLabsStartDate()}`);
	});

	test("the notice day is empty until the owner sets it, or a plain date, never a TODO that would hide the legal pages", () => {
		assert.match(ELEVENLABS_NOTICE_SENT_ON, /^(|\d{4}-\d{2}-\d{2})$/);
		assert.ok(!getLegalTodos().some(([name]) => name === "ELEVENLABS_NOTICE_SENT_ON"));
	});

	test("ElevenLabs may handle data from the notice day plus the notice period, counted in UTC days", () => {
		assert.equal(CHANGE_NOTICE_DAYS, 30);
		assert.equal(getElevenLabsStartDate("2026-11-02"), "2026-12-02");
		assert.equal(getElevenLabsStartDate("2026-12-15"), "2027-01-14");
		assert.equal(getElevenLabsStartDate("2027-01-31"), "2027-03-02");
		for (const bad of ["", "tomorrow", "2026-13-40", "2026-11-2", "TODO: set the day", undefined]) assert.equal(getElevenLabsStartDate(bad), null, String(bad));

		assert.equal(isElevenLabsNoticeOver(new Date("2026-12-01T23:59:59Z"), "2026-11-02"), false);
		assert.equal(isElevenLabsNoticeOver(new Date("2026-12-02T00:00:00Z"), "2026-11-02"), true);
		assert.equal(isElevenLabsNoticeOver(new Date("2030-01-01T00:00:00Z"), ""), false, "no notice, no start");
	});

	test("the sub-processors list names ElevenLabs, what is sent and where, and when it starts", () => {
		const entry = SUBPROCESSORS.find(({ name }) => name === "ElevenLabs");
		assert.ok(entry);
		assert.match(entry.purpose, /into speech/);
		assert.match(entry.data, /text of the issue a writer chooses to convert/);
		assert.match(entry.data, /Never a subscriber's email address/);
		assert.match(entry.us, /United States/);
		assert.match(entry.eu, /United States, not in the EU/);
		assert.match(entry.link, /^https:\/\/elevenlabs\.io\//);
		assert.ok(entry.purpose.endsWith(getElevenLabsStatus()));
	});

	test("the status line promises the notice while the day is empty and gives the dates once it is set", () => {
		assert.match(getElevenLabsStatus(""), /^Not in use yet\. We email account owners at least 30 days before it starts handling data\.$/);
		assert.equal(getElevenLabsStatus("2026-11-02"), "We emailed account owners on November 2, 2026. It handles data from December 2, 2026.");
	});
});
