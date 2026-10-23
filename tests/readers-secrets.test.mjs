import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GROUPS, NOT_NEEDED, VARIABLES, listEnvironment, readBundleEnvironment } from "../scripts/readers-env.mjs";
import { buildReadersWorker } from "../scripts/build-readers-worker.mjs";

// scripts/readers-env.mjs and scripts/set-reader-secrets.sh: what the readers Worker needs set, and the script that asks for it. A name the
// bundle starts reading that is in neither list fails here, so the owner's list is never behind the code (tests/readers-worker-build.test.mjs
// drives the endpoints and checks what they really read against VARIABLES).
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(new URL("../scripts/set-reader-secrets.sh", import.meta.url), "utf8");
const questions = /^NAMES="([\s\S]*?)"$/m.exec(script)[1].split("\n").map((line) => line.split("|"));

describe("what the Worker mentions", () => {
	test("every name in the bundle is either one an endpoint reads or one that is known not to be needed", async () => {
		await buildReadersWorker();
		const names = await readBundleEnvironment();
		const unclassified = names.filter((name) => !VARIABLES[name] && !NOT_NEEDED[name]);
		assert.deepEqual(unclassified, [], "classify these in scripts/readers-env.mjs");
		assert.deepEqual(Object.keys(VARIABLES).filter((name) => NOT_NEEDED[name]), [], "a name is one or the other");
	});

	test("every variable names its groups, and the two signing values are required by the endpoints whose links they sign", () => {
		for (const [name, info] of Object.entries(VARIABLES)) {
			assert.ok(info.groups.length > 0 && info.groups.every((group) => GROUPS.includes(group)), name);
			assert.ok(["secret", "plain"].includes(info.kind) && info.why.length > 20, name);
		}
		assert.ok(VARIABLES.BETTER_AUTH_SECRET.required && VARIABLES.BETTER_AUTH_SECRET.groups.includes("tracking") && VARIABLES.BETTER_AUTH_SECRET.groups.includes("unsubscribe"));
		assert.ok(VARIABLES.SUPPRESSION_HASH_KEY.required);
		assert.ok(!VARIABLES.BETTER_AUTH_SECRET.groups.includes("beacons"), "a beacon signs nothing");
	});

	test("names are those of the project code, not of the libraries", () => {
		assert.deepEqual(listEnvironment("process.env.BETTER_AUTH_SECRET; env.APP_URL; process.env.NODE_ENV; process.env.AWS_REGION; env.DB;"), ["APP_URL", "BETTER_AUTH_SECRET"]);
	});
});

describe("the secrets script", () => {
	test("asks for every variable, and the two signing values first, hidden and twice", () => {
		assert.deepEqual(questions.map(([name]) => name).sort(), Object.keys(VARIABLES).sort());
		assert.deepEqual(questions.slice(0, 2).map(([name, kind]) => [name, kind]), [["BETTER_AUTH_SECRET", "pair"], ["SUPPRESSION_HASH_KEY", "pair"]]);
		for (const [name, kind] of questions) {
			if (VARIABLES[name].kind === "secret") assert.notEqual(kind, "plain", `${name} is hidden`);
			if (VARIABLES[name].kind === "plain") assert.equal(kind, "plain", `${name} is shown as it is typed`);
		}
	});

	test("reads each answer from the keyboard, with the list on file descriptor 3, in a way bash 3.2 has, and never prints a value", () => {
		assert.match(script, /read -r -u 3 name kind note/);
		assert.match(script, /done 3<<< "\$NAMES"/);
		assert.match(script, /read -r -s -p/);
		assert.doesNotMatch(script, /mapfile|readarray|declare -A|\$\{[a-z_]+,,\}|\|&/, "no bash 4 features");
		assert.doesNotMatch(script, /echo "\$value"|echo \$value|echo "\$again"|printf '%s\\n' "\$value"/);
	});

	test("is valid bash and refuses a region it does not know", () => {
		execFileSync("bash", ["-n", "scripts/set-reader-secrets.sh"], { cwd: ROOT });
		let failed = false;
		try {
			execFileSync("bash", ["scripts/set-reader-secrets.sh", "mars"], { cwd: ROOT, stdio: "pipe" });
		} catch (error) {
			failed = true;
			assert.match(String(error.stderr), /region must be us or eu/);
		}
		assert.ok(failed);
	});

	test("suggests the region's non-secret defaults", () => {
		for (const expected of ['us:APP_URL) echo "https://flockstack.io"', 'eu:APP_URL) echo "https://eu.flockstack.io"', 'eu:SES_REGION) echo "eu-west-1"', 'us:ARCHIVE_CNAME_TARGET) echo "sites.flockstack.io"', 'eu:ARCHIVE_CNAME_TARGET) echo "sites-eu.flockstack.io"']) assert.ok(script.includes(expected), expected);
	});
});
