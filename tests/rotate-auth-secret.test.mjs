import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeSecret } from "../scripts/probe-auth-secret.mjs";
import { SIGNATURE_HEADER, signBody, verifySignature } from "../lib/internal-revalidate.js";

// scripts/rotate-auth-secret.sh: the order of a rotation, that it carries the old value forward without ever printing a value, and that it
// puts the old value back when the new one cannot be set everywhere. `npx` is replaced by a program that records the arguments of each call and a
// fingerprint of what came in on its standard input.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/rotate-auth-secret.sh");
const OLD = "the-old-secret-typed-by-the-owner-0123456789";
const EARLIER = "an-earlier-secret-from-the-rotation-before";
let folder;

const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

before(() => {
	folder = mkdtempSync(join(tmpdir(), "rotate-test-"));
	writeFileSync(
		join(folder, "npx"),
		`#!/bin/bash
input=$(cat)
printf '%s|%s|%s\\n' "$*" "$(printf %s "$input" | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-16)" "\${#input}" >> "$ROTATE_LOG"
if [ -n "\${FAIL_ON:-}" ]; then case "$*" in *"$FAIL_ON"*) echo "ERROR could not do it"; exit 1 ;; esac; fi
echo "Success! Uploaded secret"
`
	);
	chmodSync(join(folder, "npx"), 0o755);
});

after(() => rmSync(folder, { recursive: true, force: true }));

function run(args, { input = "", env = {} } = {}) {
	const log = join(folder, `log-${Math.random().toString(36).slice(2)}`);
	writeFileSync(log, "");
	const result = spawnSync("bash", [SCRIPT, ...args], {
		cwd: ROOT,
		input,
		encoding: "utf8",
		env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, ROTATE_LOG: log, FLOCKSTACK_ROTATE_RETRY_SLEEP: "0", ...env },
	});
	const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => {
		const [command, print, length] = line.split("|");
		return { command: command.trim(), print, length: Number(length) };
	});
	return { ...result, output: `${result.stdout}${result.stderr}`, calls };
}

const answers = (...values) => `${values.join("\n")}\n`;

describe("a rotation", () => {
	test("sets the previous value on the app, the API Worker and the readers Worker, then the new one, in that order", () => {
		const result = run(["us", "--no-probe"], { input: answers(OLD, OLD, "") });
		assert.equal(result.status, 0, result.output);
		const commands = result.calls.map(({ command }) => command);
		assert.deepEqual(commands, [
			"wrangler secret put BETTER_AUTH_SECRET_PREVIOUS",
			"wrangler secret put BETTER_AUTH_SECRET_PREVIOUS --config workers/api/wrangler.jsonc",
			"wrangler secret put BETTER_AUTH_SECRET_PREVIOUS --config workers/readers/wrangler.jsonc",
			"wrangler secret put BETTER_AUTH_SECRET",
			"wrangler secret put BETTER_AUTH_SECRET --config workers/api/wrangler.jsonc",
			"wrangler secret put BETTER_AUTH_SECRET --config workers/readers/wrangler.jsonc",
		]);
		const [previous, current] = [result.calls.slice(0, 3), result.calls.slice(3)];
		assert.ok(previous.every(({ print }) => print === fingerprint(OLD)), "the old value, exactly as typed, everywhere");
		assert.equal(new Set(current.map(({ print }) => print)).size, 1, "one new value for all three");
		assert.notEqual(current[0].print, fingerprint(OLD));
		assert.ok(current[0].length >= 48, "a long random value");
	});

	test("the EU Workers are the ones with --env eu, and earlier previous values are kept after the one typed", () => {
		const result = run(["eu", "--no-probe"], { input: answers(OLD, OLD, EARLIER) });
		assert.equal(result.status, 0, result.output);
		assert.ok(result.calls.every(({ command }) => command.endsWith("--env eu")), result.calls.map(({ command }) => command).join("\n"));
		assert.equal(result.calls[1].command, "wrangler secret put BETTER_AUTH_SECRET_PREVIOUS --config workers/api/wrangler.jsonc --env eu");
		assert.equal(result.calls[0].print, fingerprint(`${OLD},${EARLIER}`));
	});

	test("never prints a value it was given or made", () => {
		const result = run(["us", "--no-probe", "--suppression"], { input: answers(OLD, OLD, EARLIER, "the-old-suppression-key-0123456789abcdef", "the-old-suppression-key-0123456789abcdef", "") });
		assert.equal(result.status, 0, result.output);
		for (const secret of [OLD, EARLIER, "the-old-suppression-key-0123456789abcdef"]) assert.ok(!result.output.includes(secret), "an old value in the output");
		assert.doesNotMatch(result.output, /[A-Za-z0-9+/]{40,}/, "nothing like a generated value in the output");
		assert.equal(result.calls.length, 12);
		assert.deepEqual(result.calls.slice(0, 6).map(({ command }) => command.split(" ")[3]), ["BETTER_AUTH_SECRET_PREVIOUS", "BETTER_AUTH_SECRET_PREVIOUS", "BETTER_AUTH_SECRET_PREVIOUS", "SUPPRESSION_HASH_KEY_PREVIOUS", "SUPPRESSION_HASH_KEY_PREVIOUS", "SUPPRESSION_HASH_KEY_PREVIOUS"]);
		assert.deepEqual(result.calls.slice(6).map(({ command }) => command.split(" ")[3]), ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRET", "SUPPRESSION_HASH_KEY", "SUPPRESSION_HASH_KEY", "SUPPRESSION_HASH_KEY"]);
	});

	test("refuses a value typed twice that differs, and no value at all, before changing anything", () => {
		const different = run(["us", "--no-probe"], { input: answers(OLD, `${OLD}x`) });
		assert.equal(different.status, 1);
		assert.equal(different.calls.length, 0);
		const none = run(["us", "--no-probe"], { input: answers("") });
		assert.equal(none.status, 1);
		assert.equal(none.calls.length, 0);
	});

	test("when the new value cannot be set on the readers Worker, the Workers that got it get the old value back", () => {
		const result = run(["us", "--no-probe"], { input: answers(OLD, OLD, ""), env: { FAIL_ON: "secret put BETTER_AUTH_SECRET --config workers/readers" } });
		assert.equal(result.status, 1);
		const failed = result.calls.findLastIndex(({ command }) => command === "wrangler secret put BETTER_AUTH_SECRET --config workers/readers/wrangler.jsonc");
		assert.equal(failed, 7, "the readers Worker was tried three times, after the previous values and the app and API Worker's new one");
		const last = result.calls.slice(failed + 1);
		assert.deepEqual(last.map(({ command }) => command), ["wrangler secret put BETTER_AUTH_SECRET", "wrangler secret put BETTER_AUTH_SECRET --config workers/api/wrangler.jsonc"]);
		assert.ok(last.every(({ print }) => print === fingerprint(OLD)), "the old value, not the previous list");
		assert.match(result.output, /putting the old value back/);
	});

	test("a previous value that cannot be set stops the rotation before any new value exists", () => {
		const result = run(["us", "--no-probe"], { input: answers(OLD, OLD, ""), env: { FAIL_ON: "BETTER_AUTH_SECRET_PREVIOUS --config workers/api" } });
		assert.equal(result.status, 1);
		assert.ok(result.calls.every(({ command }) => command.includes("_PREVIOUS")));
		assert.match(result.output, /Stopped before any new value was set/);
	});

	test("--no-previous asks for the region to be typed, then sets only the new value", () => {
		assert.equal(run(["us", "--no-previous"], { input: answers("nope") }).calls.length, 0);
		const result = run(["us", "--no-previous"], { input: answers("us") });
		assert.equal(result.status, 0, result.output);
		assert.equal(result.calls.length, 3);
		assert.ok(result.calls.every(({ command }) => !command.includes("_PREVIOUS")));
	});

	test("--finish takes the previous values off all three Workers, and --dry-run touches nothing", () => {
		const finish = run(["eu", "--finish", "--suppression"]);
		assert.equal(finish.status, 0, finish.output);
		assert.deepEqual(finish.calls.map(({ command }) => command.replace(/ --env eu$/, "")), [
			"wrangler secret delete BETTER_AUTH_SECRET_PREVIOUS",
			"wrangler secret delete BETTER_AUTH_SECRET_PREVIOUS --config workers/api/wrangler.jsonc",
			"wrangler secret delete BETTER_AUTH_SECRET_PREVIOUS --config workers/readers/wrangler.jsonc",
			"wrangler secret delete SUPPRESSION_HASH_KEY_PREVIOUS",
			"wrangler secret delete SUPPRESSION_HASH_KEY_PREVIOUS --config workers/api/wrangler.jsonc",
			"wrangler secret delete SUPPRESSION_HASH_KEY_PREVIOUS --config workers/readers/wrangler.jsonc",
		]);
		const dry = run(["us", "--dry-run", "--suppression"]);
		assert.equal(dry.status, 0, dry.output);
		assert.equal(dry.calls.length, 0);
		assert.match(dry.output, /would set BETTER_AUTH_SECRET_PREVIOUS on flockstack\n/);
	});

	test("is valid bash 3.2, refuses an unknown region, and has no bash 4 features", () => {
		const source = readFileSync(SCRIPT, "utf8");
		assert.equal(spawnSync("bash", ["-n", SCRIPT]).status, 0);
		assert.doesNotMatch(source, /mapfile|readarray|declare -A|\$\{[a-z_]+,,\}|\|&/);
		assert.match(source, /printf %s "\$VALUE" \| npx wrangler secret put/);
		assert.doesNotMatch(source, /echo "\$(VALUE|OLD|ANSWER|current|value|earlier)|echo \$(VALUE|OLD|ANSWER)/);
		const result = run(["mars"]);
		assert.equal(result.status, 1);
		assert.match(result.output, /usage: bash scripts\/rotate-auth-secret.sh us\|eu/);
		assert.match(run(["--dry-run"]).output, /region must be us or eu/);
	});
});

describe("asking the live app whether the old value is its own", () => {
	// The app's route (app/api/internal/revalidate/route.js) answers 400 for a signature it accepts and a body it will not act on, 401 for any other.
	const fakeApp = (secret) => async (url, init) => {
		const ok = verifySignature(init.body, new Headers(init.headers).get(SIGNATURE_HEADER), secret);
		return new Response(null, { status: ok ? 400 : 401 });
	};

	test("is accepted for the app's secret, refused for another, unknown when the app cannot be reached", async () => {
		assert.equal(await probeSecret(OLD, "https://app.example.com", fakeApp(OLD)), "accepted");
		assert.equal(await probeSecret(EARLIER, "https://app.example.com", fakeApp(OLD)), "refused");
		assert.equal(await probeSecret(OLD, "https://app.example.com", async () => Response.error()), "unknown");
		assert.equal(await probeSecret(OLD, "https://app.example.com", async () => { throw new Error("offline"); }), "unknown");
		assert.equal(signBody("{}", OLD).length, 64);
	});
});
