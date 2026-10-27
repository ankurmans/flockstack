import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonc } from "../scripts/bundle-worker.mjs";
import { applyOptionalBindings, collaborationVars, describeOptionalWorkers, hasCollaboration, loadOptionalWorkers, parseOptionalWorkers } from "../scripts/optional-workers.mjs";
import { isAllowedOrigin, isTestOrigin } from "../workers/collaboration/origin.js";

// The optional Workers (realtime editing, inbound replies): what the repository's configurations may name, what a region's setting adds to a
// deploy, and the origins the collaboration Worker accepts. The deploy flow itself is in tests/deploy-all.test.mjs.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readJsonc(readFileSync(join(ROOT, path), "utf8"));
const APP = read("wrangler.jsonc");
const API = read("workers/api/wrangler.jsonc");
const ROUTER = read("workers/router/wrangler.jsonc");
const servicesOf = (config) => (config.services ?? []).map(({ binding }) => binding);

describe("the configurations in the repository", () => {
	test("none of the Workers that run today names an optional Worker or its bindings, so a deploy cannot fail on one that does not exist", () => {
		for (const path of ["wrangler.jsonc", "workers/api/wrangler.jsonc", "workers/readers/wrangler.jsonc", "workers/public/wrangler.jsonc", "workers/router/wrangler.jsonc"]) {
			const text = readFileSync(join(ROOT, path), "utf8");
			assert.doesNotMatch(text, /COLLABORATION_|flockstack-collaboration|flockstack-replies/, path);
		}
	});

	test("the two optional Workers are configured like the others: the account, no workers.dev address, no preview URLs, logs", () => {
		const account = APP.account_id;
		assert.match(account, /^[0-9a-f]{32}$/);
		for (const path of ["workers/collaboration/wrangler.jsonc", "workers/replies/wrangler.jsonc"]) {
			const config = read(path);
			for (const [label, part] of [["top level", config], ["env.eu", config.env.eu]]) {
				assert.equal(part.account_id, account, `${path} ${label} account_id`);
				assert.equal(part.workers_dev, false, `${path} ${label} workers_dev`);
				assert.equal(part.preview_urls, false, `${path} ${label} preview_urls`);
				assert.equal(part.observability?.enabled, true, `${path} ${label} observability`);
			}
		}
	});

	test("the collaboration Worker is off in its file; a flag is set on a deploy, never by editing it", () => {
		const config = read("workers/collaboration/wrangler.jsonc");
		assert.equal(config.vars.COLLABORATION_ENABLED, "false");
		assert.equal(config.env.eu.vars.COLLABORATION_ENABLED, "false");
		assert.equal(config.vars.COLLABORATION_ALLOWED_ORIGINS, undefined);
	});
});

describe("the setting", () => {
	test("nothing set means no optional Worker anywhere", () => {
		for (const text of [undefined, null, "", "  \n"]) {
			const settings = parseOptionalWorkers(text);
			for (const region of ["us", "eu"]) {
				assert.equal(hasCollaboration(settings, region), false);
				assert.equal(settings[region].replies, false);
				assert.deepEqual(collaborationVars(settings, region), []);
				assert.match(describeOptionalWorkers(settings, region), /^none/);
			}
		}
	});

	test("reads each region's collaboration state and replies, as a word or an object", () => {
		const settings = parseOptionalWorkers(JSON.stringify({ us: { collaboration: "enabled", replies: true }, eu: { collaboration: { state: "provisioned", testOrigins: ["https://flockstack-router-eu.example.workers.dev"] } } }));
		assert.equal(settings.us.collaboration.state, "enabled");
		assert.equal(settings.us.replies, true);
		assert.equal(settings.eu.collaboration.state, "provisioned");
		assert.equal(settings.eu.replies, false);
		assert.deepEqual(settings.eu.collaboration.testOrigins, ["https://flockstack-router-eu.example.workers.dev"]);
		assert.match(describeOptionalWorkers(settings, "us"), /collaboration enabled, replies/);
		assert.match(describeOptionalWorkers(settings, "eu"), /collaboration provisioned \(also accepts sockets from https:\/\/flockstack-router-eu\.example\.workers\.dev\)/);
	});

	test("refuses what it does not understand instead of guessing, so a typo never reaches a deploy", () => {
		const bad = [
			["not json", /not JSON/],
			["[]", /object/],
			['{"xx":{}}', /region "xx"/],
			['{"us":{"search":true}}', /"search"/],
			['{"us":{"replies":"yes"}}', /true or false/],
			['{"us":{"collaboration":"on"}}', /"off", "provisioned", "enabled"/],
			['{"us":{"collaboration":{"state":"enabled","extra":1}}}', /extra/],
			['{"us":{"collaboration":{"state":"off","testOrigins":["https://a.example.com"]}}}', /need collaboration provisioned or enabled/],
			['{"us":{"collaboration":{"state":"enabled","testOrigins":["*"]}}}', /exact https origin/],
			['{"us":{"collaboration":{"state":"enabled","testOrigins":["https://a.example.com/path"]}}}', /exact https origin/],
			['{"us":{"collaboration":{"state":"enabled","testOrigins":["http://a.example.com"]}}}', /exact https origin/],
			['{"us":{"collaboration":{"state":"enabled","testOrigins":["https://*.example.com"]}}}', /exact https origin/],
		];
		for (const [text, message] of bad) assert.throws(() => parseOptionalWorkers(text), message, text);
		assert.doesNotThrow(() => parseOptionalWorkers('{"us":{"collaboration":{"state":"enabled","testOrigins":["http://localhost:3000"]}}}'));
	});

	test("the environment wins over the file; neither is needed", () => {
		const folder = mkdtempSync(join(tmpdir(), "optional-workers-"));
		try {
			const file = join(folder, "optional-workers.json");
			assert.equal(loadOptionalWorkers({ env: {}, file }).us.collaboration.state, "off", "no file");
			writeFileSync(file, '{"us":{"collaboration":"provisioned"}}');
			assert.equal(loadOptionalWorkers({ env: {}, file }).us.collaboration.state, "provisioned", "the file");
			assert.equal(loadOptionalWorkers({ env: { FLOCKSTACK_OPTIONAL_WORKERS: '{"us":{"collaboration":"enabled"}}' }, file }).us.collaboration.state, "enabled", "the environment");
			assert.equal(loadOptionalWorkers({ env: { FLOCKSTACK_OPTIONAL_WORKERS: "" }, file }).us.collaboration.state, "off", "an empty environment value says none, whatever the file holds");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("what a region's setting adds to a deploy", () => {
	const none = parseOptionalWorkers("");
	const us = parseOptionalWorkers('{"us":{"collaboration":"provisioned"}}');
	const eu = parseOptionalWorkers('{"eu":{"collaboration":"enabled"}}');

	test("without the Worker, the very configuration comes back and nothing is added", () => {
		for (const [config, kind] of [[APP, "app"], [API, "api"], [ROUTER, "router"]]) {
			for (const region of ["us", "eu"]) {
				const result = applyOptionalBindings(config, kind, region, none);
				assert.equal(result.config, config);
				assert.deepEqual(result.added, []);
			}
		}
		assert.equal(applyOptionalBindings(APP, "app", "eu", us).config, APP, "a US Worker adds nothing in the EU");
	});

	test("the app gets the socket and the storage, the API Worker the storage, the router the socket, all pointing at the region's collaboration Worker", () => {
		const app = applyOptionalBindings(APP, "app", "us", us);
		assert.deepEqual(app.config.services.filter(({ binding }) => binding.startsWith("COLLABORATION_")), [
			{ binding: "COLLABORATION_SOCKET", service: "flockstack-collaboration" },
			{ binding: "COLLABORATION_STORAGE", service: "flockstack-collaboration", entrypoint: "CollaborationStorage" },
		]);
		assert.ok(servicesOf(app.config).includes("WEBSITE"), "what was there stays");
		assert.deepEqual(app.config.env.eu.services, APP.env.eu.services, "the EU environment of the same file is not touched");
		const api = applyOptionalBindings(API, "api", "us", us);
		assert.deepEqual(api.config.services.filter(({ binding }) => binding.startsWith("COLLABORATION_")), [{ binding: "COLLABORATION_STORAGE", service: "flockstack-collaboration", entrypoint: "CollaborationStorage" }]);
		const router = applyOptionalBindings(ROUTER, "router", "us", us);
		for (const part of [router.config, router.config.env.us]) assert.deepEqual(part.services.filter(({ binding }) => binding.startsWith("COLLABORATION_")), [{ binding: "COLLABORATION_SOCKET", service: "flockstack-collaboration" }]);
		assert.deepEqual(servicesOf(router.config.env.eu), servicesOf(ROUTER.env.eu), "the other region's routers are not touched");
		assert.deepEqual(servicesOf(router.config.env["eu-staged"]), servicesOf(ROUTER.env["eu-staged"]));
	});

	test("the EU uses the -eu Worker in both the app's env.eu and the EU routers, and the originals are never changed", () => {
		const before = JSON.stringify([APP, API, ROUTER]);
		const app = applyOptionalBindings(APP, "app", "eu", eu);
		assert.deepEqual(app.config.env.eu.services.filter(({ binding }) => binding.startsWith("COLLABORATION_")).map(({ service }) => service), ["flockstack-collaboration-eu", "flockstack-collaboration-eu"]);
		assert.deepEqual(servicesOf(app.config), servicesOf(APP), "the US part of the file is not touched");
		const router = applyOptionalBindings(ROUTER, "router", "eu", eu);
		for (const name of ["eu", "eu-staged"]) assert.deepEqual(router.config.env[name].services.find(({ binding }) => binding === "COLLABORATION_SOCKET"), { binding: "COLLABORATION_SOCKET", service: "flockstack-collaboration-eu" });
		applyOptionalBindings(API, "api", "eu", eu);
		assert.equal(JSON.stringify([APP, API, ROUTER]), before);
	});

	test("COLLABORATION_ENABLED is never written into the app, API Worker or router: it is a secret there, which a deploy keeps", () => {
		const enabled = parseOptionalWorkers('{"us":{"collaboration":"enabled"},"eu":{"collaboration":"enabled"}}');
		for (const [config, kind] of [[APP, "app"], [API, "api"], [ROUTER, "router"]]) {
			for (const region of ["us", "eu"]) assert.doesNotMatch(JSON.stringify(applyOptionalBindings(config, kind, region, enabled).config), /COLLABORATION_ENABLED/);
		}
	});

	test("a binding already in the configuration is not added twice", () => {
		const once = applyOptionalBindings(APP, "app", "us", us).config;
		const twice = applyOptionalBindings(once, "app", "us", us);
		assert.deepEqual(twice.added, []);
		assert.equal(twice.config, once);
	});

	test("the collaboration Worker's flags: the switch only when enabled, the test origins only when listed", () => {
		assert.deepEqual(collaborationVars(us, "us"), []);
		assert.deepEqual(collaborationVars(eu, "eu"), ["--var", "COLLABORATION_ENABLED:true"]);
		assert.deepEqual(collaborationVars(eu, "us"), []);
		const testing = parseOptionalWorkers('{"us":{"collaboration":{"state":"enabled","testOrigins":["https://a.example.workers.dev","https://b.example.workers.dev"]}}}');
		assert.deepEqual(collaborationVars(testing, "us"), ["--var", "COLLABORATION_ENABLED:true", "--var", "COLLABORATION_ALLOWED_ORIGINS:https://a.example.workers.dev,https://b.example.workers.dev"]);
	});
});

describe("the origins a socket may come from", () => {
	const env = { APP_URL: "https://flockstack.io/", COLLABORATION_ALLOWED_ORIGINS: "https://router.example.workers.dev, http://localhost:3000,*,https://x.example.com/path" };

	test("the dashboard's origin, whatever path APP_URL has, and nothing else without a list", () => {
		assert.equal(isAllowedOrigin("https://flockstack.io", env), true);
		assert.equal(isAllowedOrigin("https://flockstack.io", { APP_URL: "https://flockstack.io/app" }), true);
		for (const origin of ["https://other.example", "http://flockstack.io", "https://flockstack.io.evil.example", "null", "", null, undefined]) assert.equal(isAllowedOrigin(origin, { APP_URL: "https://flockstack.io" }), false, String(origin));
		assert.equal(isAllowedOrigin("https://flockstack.io", {}), false, "no APP_URL, no sockets");
		assert.equal(isAllowedOrigin("https://flockstack.io", { APP_URL: "not a url" }), false);
	});

	test("the listed test origins, exactly, and never a pattern or one with a path", () => {
		assert.equal(isAllowedOrigin("https://router.example.workers.dev", env), true);
		assert.equal(isAllowedOrigin("http://localhost:3000", env), true);
		for (const origin of ["https://other.example.workers.dev", "https://router.example.workers.dev.evil.example", "*", "https://x.example.com", "https://x.example.com/path"]) assert.equal(isAllowedOrigin(origin, env), false, origin);
		assert.equal(isAllowedOrigin("https://router.example.workers.dev", { COLLABORATION_ALLOWED_ORIGINS: "https://router.example.workers.dev" }), false, "the list does not replace APP_URL");
	});

	test("isTestOrigin is the one rule of the deploy script and the Worker", () => {
		assert.equal(isTestOrigin("https://a.example.workers.dev"), true);
		assert.equal(isTestOrigin("http://127.0.0.1:8787"), true);
		for (const value of ["http://a.example.com", "https://a.example.com/", "https://*.example.com", "a.example.com", "", "https://a.example.com:443/x"]) assert.equal(isTestOrigin(value), false, value);
	});
});
