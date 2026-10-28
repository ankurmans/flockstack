import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/set-optional-worker-secrets.sh: which Worker gets which value for the replies, collaboration and briefings services, in what order, that no value
// is printed, and that a failure stops before the step that switches the feature on. `npx` is replaced by a program that records the arguments of
// each call and a fingerprint of what came in on its standard input.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "scripts/set-optional-worker-secrets.sh");
const TYPED = "a-secret-typed-by-the-owner-0123456789abcdef";
let folder;

const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);

before(() => {
	folder = mkdtempSync(join(tmpdir(), "optional-secrets-"));
	writeFileSync(
		join(folder, "npx"),
		`#!/bin/bash
input=$(cat)
printf '%s|%s|%s\\n' "$*" "$(printf %s "$input" | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-16)" "\${#input}" >> "$OPTIONAL_LOG"
if [ -n "\${FAIL_ON:-}" ]; then case "$*" in *"$FAIL_ON"*) echo "ERROR could not do it"; exit 1 ;; esac; fi
if [ "$2 $3" = "secret list" ]; then
	kind=app; case "$*" in *workers/api/*) kind=api ;; *workers/briefings/*) kind=briefings ;; esac
	case " \${LIST_HAS:-} " in *" $kind "*) echo '[{"name":"OTHER","type":"secret_text"},{"name": "CREDENTIALS_ENCRYPTION_KEY","type":"secret_text"}]' ;; *) echo '[{"name":"OTHER","type":"secret_text"}]' ;; esac
	exit 0
fi
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
		env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, OPTIONAL_LOG: log, FLOCKSTACK_OPTIONAL_RETRY_SLEEP: "0", ...env },
	});
	const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => {
		const [command, print, length] = line.split("|");
		return { command: command.trim(), print, length: Number(length) };
	});
	return { ...result, output: `${result.stdout}${result.stderr}`, calls };
}

const answers = (...values) => `${values.join("\n")}\n`;

describe("replies", () => {
	test("sets the secret on the app, the API Worker and the replies Worker, then the domain on the app and the API Worker", () => {
		const result = run(["replies", "us"], { input: answers("Replies.Example.com", TYPED, TYPED) });
		assert.equal(result.status, 0, result.output);
		assert.deepEqual(result.calls.map(({ command }) => command), [
			"wrangler secret put REPLY_INGEST_SECRET",
			"wrangler secret put REPLY_INGEST_SECRET --config workers/api/wrangler.jsonc",
			"wrangler secret put REPLY_INGEST_SECRET --config workers/replies/wrangler.jsonc",
			"wrangler secret put REPLIES_DOMAIN",
			"wrangler secret put REPLIES_DOMAIN --config workers/api/wrangler.jsonc",
		]);
		assert.ok(result.calls.slice(0, 3).every(({ print }) => print === fingerprint(TYPED)), "the typed value, exactly, on all three");
		assert.ok(result.calls.slice(3).every(({ print }) => print === fingerprint("replies.example.com")), "the domain is lowercased");
		assert.ok(!result.output.includes(TYPED), "the secret is not printed");
	});

	test("Enter makes a random secret nobody sees, the same on all three Workers", () => {
		const result = run(["replies", "us"], { input: answers("replies.example.com", "") });
		assert.equal(result.status, 0, result.output);
		const secrets = result.calls.slice(0, 3);
		assert.equal(new Set(secrets.map(({ print }) => print)).size, 1);
		assert.ok(secrets[0].length >= 48);
		assert.match(result.output, /made a random one/);
	});

	test("the EU Workers are the ones with --env eu", () => {
		const result = run(["replies", "eu"], { input: answers("replies-eu.example.com", "") });
		assert.equal(result.status, 0, result.output);
		assert.equal(result.calls.length, 5);
		assert.ok(result.calls.every(({ command }) => command.endsWith("--env eu")), result.calls.map(({ command }) => command).join("\n"));
		assert.match(result.output, /flockstack-replies-eu/);
	});

	test("refuses a name that is not a domain, the app's own address, and two secrets that differ, before changing anything", () => {
		for (const input of [answers("not a domain", ""), answers("flockstack.io", ""), answers("eu.flockstack.io", ""), answers("replies.example.com", TYPED, `${TYPED}x`)]) {
			const result = run(["replies", "us"], { input });
			assert.equal(result.status, 1, result.output);
			assert.deepEqual(result.calls, []);
			assert.match(result.output, /Nothing is changed/);
		}
	});

	test("a failure on any Worker stops before REPLIES_DOMAIN, the step that switches it on", () => {
		const result = run(["replies", "us"], { input: answers("replies.example.com", ""), env: { FAIL_ON: "workers/replies" } });
		assert.equal(result.status, 1, result.output);
		assert.ok(!result.calls.some(({ command }) => command.includes("REPLIES_DOMAIN")));
		assert.match(result.output, /flockstack-replies does not have it/);
		assert.match(result.output, /Nothing writes reply addresses yet/);
	});

	test("--dry-run asks for nothing and calls nothing; --off deletes both names everywhere", () => {
		const dry = run(["replies", "us", "--dry-run"]);
		assert.equal(dry.status, 0, dry.output);
		assert.deepEqual(dry.calls, []);
		assert.match(dry.output, /would set REPLY_INGEST_SECRET on flockstack-replies/);
		const off = run(["replies", "eu", "--off"]);
		assert.equal(off.status, 0, off.output);
		assert.deepEqual(off.calls.map(({ command }) => command), [
			"wrangler secret delete REPLIES_DOMAIN --env eu",
			"wrangler secret delete REPLIES_DOMAIN --config workers/api/wrangler.jsonc --env eu",
			"wrangler secret delete REPLY_INGEST_SECRET --env eu",
			"wrangler secret delete REPLY_INGEST_SECRET --config workers/api/wrangler.jsonc --env eu",
			"wrangler secret delete REPLY_INGEST_SECRET --config workers/replies/wrangler.jsonc --env eu",
		]);
	});
});

describe("collaboration", () => {
	test("sets COLLABORATION_ENABLED on the app and the API Worker only after the region is typed", () => {
		const refused = run(["collaboration", "us"], { input: answers("yes") });
		assert.equal(refused.status, 1);
		assert.deepEqual(refused.calls, []);
		const result = run(["collaboration", "us"], { input: answers("us") });
		assert.equal(result.status, 0, result.output);
		assert.deepEqual(result.calls.map(({ command }) => command), ["wrangler secret put COLLABORATION_ENABLED --config workers/api/wrangler.jsonc", "wrangler secret put COLLABORATION_ENABLED"], "the API Worker first: the app's flag is what shows the button");
		assert.ok(result.calls.every(({ print }) => print === fingerprint("true")));
	});

	test("EU uses --env eu, a failure says what is left, and --off deletes the app's flag first", () => {
		const eu = run(["collaboration", "eu"], { input: answers("eu") });
		assert.ok(eu.calls.every(({ command }) => command.endsWith("--env eu")));
		const failed = run(["collaboration", "us"], { input: answers("us"), env: { FAIL_ON: "workers/api" } });
		assert.equal(failed.status, 1);
		assert.match(failed.output, /The API Worker does not have it, so the app was not changed/);
		assert.ok(!failed.calls.some(({ command }) => !command.includes("workers/api")), "the app is not touched when the API Worker failed");
		const off = run(["collaboration", "us", "--off"]);
		assert.deepEqual(off.calls.map(({ command }) => command), ["wrangler secret delete COLLABORATION_ENABLED", "wrangler secret delete COLLABORATION_ENABLED --config workers/api/wrangler.jsonc"]);
	});
});

describe("briefings", () => {
	const KEY = "CREDENTIALS_ENCRYPTION_KEY";
	const puts = (calls) => calls.filter(({ command }) => command.startsWith("wrangler secret put"));
	const TYPED_KEY = "q8l3m0Z4dGVzdC1rZXktZm9yLWJyaWVmaW5ncy0xMjM=";

	test("checks the three Workers, then puts one random 32-byte key on the briefings Worker, the API Worker and the app, never printed", () => {
		const result = run(["briefings", "us"]);
		assert.equal(result.status, 0, result.output);
		assert.deepEqual(result.calls.map(({ command }) => command), [
			"wrangler secret list --format json",
			"wrangler secret list --config workers/api/wrangler.jsonc --format json",
			"wrangler secret list --config workers/briefings/wrangler.jsonc --format json",
			`wrangler secret put ${KEY} --config workers/briefings/wrangler.jsonc`,
			`wrangler secret put ${KEY} --config workers/api/wrangler.jsonc`,
			`wrangler secret put ${KEY}`,
		]);
		const values = puts(result.calls);
		assert.equal(new Set(values.map(({ print }) => print)).size, 1, "the same value on all three");
		assert.equal(values[0].length, 44, "32 bytes in base64");
		assert.doesNotMatch(result.output, /[A-Za-z0-9+/]{43}=/, "the value is not printed");
		const again = run(["briefings", "us"]);
		assert.notEqual(puts(again.calls)[0].print, values[0].print, "a new value each time");
	});

	test("refuses when any of them has one already, and changes nothing", () => {
		for (const has of ["app", "api", "briefings", "app api briefings"]) {
			const result = run(["briefings", "eu"], { env: { LIST_HAS: has } });
			assert.equal(result.status, 1, result.output);
			assert.deepEqual(puts(result.calls), [], has);
			assert.match(result.output, /already set on/);
			assert.match(result.output, /Nothing is changed/);
			assert.ok(result.calls.every(({ command }) => command.endsWith("--env eu --format json")), "the EU Workers");
		}
	});

	test("--rotate warns that stored AI keys become unreadable and goes on only once the region is typed", () => {
		const refused = run(["briefings", "us", "--rotate"], { input: answers("yes"), env: { LIST_HAS: "app api briefings" } });
		assert.equal(refused.status, 1);
		assert.deepEqual(puts(refused.calls), []);
		assert.match(refused.output, /WARNING/);
		assert.match(refused.output, /stored AI provider key/);
		const result = run(["briefings", "us", "--rotate"], { input: answers("us"), env: { LIST_HAS: "app api briefings" } });
		assert.equal(result.status, 0, result.output);
		assert.equal(puts(result.calls).length, 3);
		assert.equal(new Set(puts(result.calls).map(({ print }) => print)).size, 1);
	});

	test("--existing copies the app's value, typed twice, to the API Worker and the briefings Worker only", () => {
		const result = run(["briefings", "us", "--existing"], { input: answers(TYPED_KEY, TYPED_KEY), env: { LIST_HAS: "app" } });
		assert.equal(result.status, 0, result.output);
		assert.deepEqual(puts(result.calls).map(({ command }) => command), [`wrangler secret put ${KEY} --config workers/api/wrangler.jsonc`, `wrangler secret put ${KEY} --config workers/briefings/wrangler.jsonc`]);
		assert.ok(puts(result.calls).every(({ print }) => print === fingerprint(TYPED_KEY)));
		assert.ok(!result.output.includes(TYPED_KEY));
		for (const [input, env, message] of [
			[answers(TYPED_KEY, TYPED_KEY), {}, /has no CREDENTIALS_ENCRYPTION_KEY/],
			[answers(TYPED_KEY, `${TYPED_KEY}x`), { LIST_HAS: "app" }, /did not match/],
			[answers("short", "short"), { LIST_HAS: "app" }, /not 32 bytes/],
		]) {
			const refused = run(["briefings", "us", "--existing"], { input, env });
			assert.equal(refused.status, 1, refused.output);
			assert.deepEqual(puts(refused.calls), []);
			assert.match(refused.output, message);
		}
	});

	test("a failure stops at that Worker, and a Worker it cannot list stops it before anything is set", () => {
		const failed = run(["briefings", "us"], { env: { FAIL_ON: "put CREDENTIALS_ENCRYPTION_KEY --config workers/api" } });
		assert.equal(failed.status, 1);
		assert.ok(!puts(failed.calls).some(({ command }) => command === `wrangler secret put ${KEY}`), "the app is not given it");
		assert.match(failed.output, /flockstack-api does not have it/);
		const unlisted = run(["briefings", "us"], { env: { FAIL_ON: "list --config workers/briefings" } });
		assert.equal(unlisted.status, 1);
		assert.deepEqual(puts(unlisted.calls), []);
		assert.match(unlisted.output, /Could not list the secrets of flockstack-briefings/);
	});

	test("--dry-run asks and calls nothing; --off, and --rotate with --existing, are refused", () => {
		const dry = run(["briefings", "eu", "--dry-run"]);
		assert.equal(dry.status, 0, dry.output);
		assert.deepEqual(dry.calls, []);
		assert.match(dry.output, /would make a random 32-byte value and set it on flockstack-briefings-eu, flockstack-api-eu and flockstack-eu/);
		for (const args of [["briefings", "us", "--off"], ["briefings", "us", "--rotate", "--existing"], ["replies", "us", "--rotate"], ["collaboration", "us", "--existing"]]) {
			const result = run(args);
			assert.equal(result.status, 1, args.join(" "));
			assert.match(result.stderr, /usage:/);
			assert.deepEqual(result.calls, []);
		}
	});
});

describe("use", () => {
	test("needs a service and a region, and takes nothing else", () => {
		for (const args of [[], ["replies"], ["us"], ["replies", "us", "--bogus"], ["replies", "mars"]]) {
			const result = run(args);
			assert.equal(result.status, 1, args.join(" "));
			assert.match(result.stderr, /usage: bash scripts\/set-optional-worker-secrets.sh/);
			assert.deepEqual(result.calls, []);
		}
	});

	test("every name it sets is one the code reads and the API Worker's list names", () => {
		const read = (file) => readFileSync(join(ROOT, file), "utf8");
		assert.match(read("lib/reply-address.js"), /process\.env\.REPLIES_DOMAIN/);
		assert.match(read("lib/reply-ingest-auth.js"), /process\.env\.REPLY_INGEST_SECRET/);
		assert.match(read("lib/collaboration-authority.js"), /process\.env\.COLLABORATION_ENABLED/);
		assert.match(read("lib/credentials.js"), /env\.CREDENTIALS_ENCRYPTION_KEY/);
		const listed = spawnSync("node", ["scripts/api-env.mjs"], { cwd: ROOT, encoding: "utf8" }).stdout;
		for (const name of ["REPLIES_DOMAIN", "REPLY_INGEST_SECRET", "COLLABORATION_ENABLED", "CREDENTIALS_ENCRYPTION_KEY"]) assert.match(listed, new RegExp(`^  ${name}$`, "m"), name);
		assert.match(listed, /COLLABORATION_STORAGE/);
	});
});
