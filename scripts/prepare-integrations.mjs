// Local submission inventory only: reads source and writes hashes. No provider login, upload or publication.
// node --import ./tests/setup/register.mjs scripts/prepare-integrations.mjs [--check]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WEBHOOK_EVENTS } from "../lib/webhook-events.js";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const readJson = path => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const make = readJson("integrations/make/makecomapp.json");
const zapier = readJson("integrations/zapier/package.json");
const types = WEBHOOK_EVENTS.map(event => event.type);
const zapierEvents = require("../integrations/zapier/lib/events.js");
const makeEvents = readJson("integrations/make/webhooks/flockstack/parameters.iml.json").find(field => field.name === "event").options;
if (JSON.stringify(types) !== JSON.stringify(zapierEvents.map(event => event.type)) || JSON.stringify(types) !== JSON.stringify(makeEvents.map(event => event.value))) throw new Error("Connector event catalogs differ from the app");
const files = folder => readdirSync(join(ROOT, folder), { withFileTypes: true }).flatMap(entry => {
	if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build") return [];
	const path = `${folder}/${entry.name}`;
	return entry.isDirectory() ? files(path) : /\.(?:js|json|md)$/.test(entry.name) && entry.name !== "submission-manifest.json" ? [path] : [];
});
const makeFiles = [make.generalCodeFiles.base, ...Object.values(make.components).flatMap(group => Object.values(group).flatMap(component => Object.values(component.codeFiles)))].filter(Boolean);
for (const file of makeFiles) readJson(`integrations/make/${file}`);
const inventory = [...files("integrations/zapier"), ...files("integrations/make"), "integrations/SUBMISSION.md"].sort().map(path => {
	const bytes = readFileSync(join(ROOT, path));
	return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const manifest = {
	format: 1,
	providerState: "not_checked",
	submissionAttemptedByThisBuild: false,
	readyToSubmit: false,
	zapier: { version: zapier.version, node: zapier.engines.node, core: zapier.dependencies["zapier-platform-core"], cli: zapier.devDependencies["zapier-platform-cli"], triggerCount: types.length + 1, actions: ["add_subscriber", "update_subscriber", "add_tag"], search: "find_subscriber" },
	make: { manifest: "integrations/make/makecomapp.json", componentFiles: makeFiles.length },
	events: WEBHOOK_EVENTS.map(event => ({ type: event.type, title: event.title })),
	documentation: { api: "https://flockstack.io/docs/api", events: "https://flockstack.io/docs/webhooks", installation: "https://flockstack.io/docs/zapier-make" },
	pending: ["Verify and deploy this source in both Cloud regions before testing directory workflows", "Verify provider ownership and existing app/version state before creating any registration", "Run real US/EU subscribe, receive, retry and unsubscribe workflows with an isolated reviewer account", "Resolve the 55 Zapier D018 title-case publishing tasks against the repository sentence-case copy policy; D026 requires manual custom-domain review", "Review dedicated webhook URL handling and raw signature verification support in both providers; local connector receivers currently filter event type and rely on provider URLs", "Run Make test scenarios and record provider validation results", "Provide owner-approved support contact, reviewer credentials and brand assets through private provider channels", "Review full CLI development dependency audit before provider upload", "Obtain explicit approval before registration, upload, publication, promotion or review submission"],
	files: inventory,
};
const output = `${JSON.stringify(manifest, null, "\t")}\n`;
const target = join(ROOT, "integrations/submission-manifest.json");
if (process.argv.includes("--check")) {
	if (readFileSync(target, "utf8") !== output) throw new Error("Submission inventory is stale: rerun scripts/prepare-integrations.mjs");
} else writeFileSync(target, output);
console.log(`prepare-integrations: ${types.length} events, ${inventory.length} source files; provider state and submission remain unverified`);
