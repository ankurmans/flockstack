// Which optional Workers (realtime editing, inbound replies) a region has, and what that changes in a deploy. The configurations in the
// repository name neither: a service binding to a Worker that does not exist fails the deploy of the Worker that holds it, so the bindings
// are added by scripts/deploy-all.mjs only for a region that says the Worker is there. docs/OPTIONAL-WORKERS-RUNBOOK.md has the steps.
//
// The setting is JSON, from FLOCKSTACK_OPTIONAL_WORKERS in the environment or, when that is unset, the file optional-workers.json at the
// repository root (git-ignored: it describes one deployment):
//   { "us": { "collaboration": "enabled", "replies": true }, "eu": { "collaboration": "provisioned" } }
// collaboration: "off" (the default), "provisioned" (the Worker exists: the app, API Worker and router get its bindings, the flag stays off)
// or "enabled" (the same, and every deploy of the collaboration Worker keeps COLLABORATION_ENABLED true). The object form
// { "state": "provisioned", "testOrigins": ["https://…workers.dev"] } also lets those exact origins open a socket, to try it before a domain moves.
// replies: true when the replies Worker exists; deploy-all then deploys it with the rest. It needs no binding anywhere else.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTestOrigin } from "../workers/collaboration/origin.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const OPTIONAL_FILE = join(ROOT, "optional-workers.json");
export const COLLABORATION_STATES = ["off", "provisioned", "enabled"];
const REGION_NAMES = ["us", "eu"];

export const collaborationWorkerName = (region) => (region === "eu" ? "flockstack-collaboration-eu" : "flockstack-collaboration");
export const repliesWorkerName = (region) => (region === "eu" ? "flockstack-replies-eu" : "flockstack-replies");

const NONE = () => ({ collaboration: { state: "off", testOrigins: [] }, replies: false });

export function parseOptionalWorkers(text) {
	const settings = { us: NONE(), eu: NONE() };
	if (text === undefined || text === null || String(text).trim() === "") return settings;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('The optional Workers setting is not JSON. Example: {"us":{"collaboration":"provisioned"},"eu":{"replies":true}}.');
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The optional Workers setting is an object with the keys us and eu.");
	for (const [region, entry] of Object.entries(parsed)) {
		if (!REGION_NAMES.includes(region)) throw new Error(`The optional Workers setting has the region "${region}"; it takes us and eu.`);
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`The optional Workers setting for ${region} is an object.`);
		for (const key of Object.keys(entry)) if (!["collaboration", "replies"].includes(key)) throw new Error(`The optional Workers setting for ${region} has "${key}"; it takes collaboration and replies.`);
		if ("replies" in entry) {
			if (typeof entry.replies !== "boolean") throw new Error(`replies for ${region} is true or false.`);
			settings[region].replies = entry.replies;
		}
		if ("collaboration" in entry) settings[region].collaboration = parseCollaboration(region, entry.collaboration);
	}
	return settings;
}

function parseCollaboration(region, value) {
	const { state, testOrigins = [], ...rest } = typeof value === "string" ? { state: value } : (value ?? {});
	if (Object.keys(rest).length > 0) throw new Error(`collaboration for ${region} takes state and testOrigins, not ${Object.keys(rest).join(", ")}.`);
	if (!COLLABORATION_STATES.includes(state)) throw new Error(`collaboration for ${region} is ${COLLABORATION_STATES.map((name) => `"${name}"`).join(", ")}; it was ${JSON.stringify(state)}.`);
	if (!Array.isArray(testOrigins) || testOrigins.length > 5) throw new Error(`testOrigins for ${region} is a list of at most 5 origins.`);
	for (const origin of testOrigins) {
		if (typeof origin !== "string" || !isTestOrigin(origin)) throw new Error(`testOrigins for ${region}: ${JSON.stringify(origin)} is not an exact https origin such as https://example.workers.dev (no path, no wildcard).`);
	}
	if (state === "off" && testOrigins.length > 0) throw new Error(`testOrigins for ${region} need collaboration provisioned or enabled.`);
	return { state, testOrigins: [...testOrigins] };
}

export function loadOptionalWorkers({ env = process.env, file = OPTIONAL_FILE } = {}) {
	if (env.FLOCKSTACK_OPTIONAL_WORKERS !== undefined) return parseOptionalWorkers(env.FLOCKSTACK_OPTIONAL_WORKERS);
	return parseOptionalWorkers(existsSync(file) ? readFileSync(file, "utf8") : "");
}

export const hasCollaboration = (settings, region) => settings[region].collaboration.state !== "off";

// The collaboration Worker's deploy flags for a region: the switch stays true across deploys, and test origins are set only when listed.
export function collaborationVars(settings, region) {
	const { state, testOrigins } = settings[region].collaboration;
	return [...(state === "enabled" ? ["--var", "COLLABORATION_ENABLED:true"] : []), ...(testOrigins.length > 0 ? ["--var", `COLLABORATION_ALLOWED_ORIGINS:${testOrigins.join(",")}`] : [])];
}

// The environments of each configuration that belong to a region: a Worker's top level is the US; the router's top level and env.eu-staged are the staged ones.
const ENVIRONMENTS = {
	app: { us: [null], eu: ["eu"] },
	api: { us: [null], eu: ["eu"] },
	router: { us: [null, "us"], eu: ["eu-staged", "eu"] },
};

// The service bindings each kind of Worker gets when its region has the collaboration Worker.
const bindingsFor = (kind, region) => {
	const service = collaborationWorkerName(region);
	const socket = { binding: "COLLABORATION_SOCKET", service };
	const storage = { binding: "COLLABORATION_STORAGE", service, entrypoint: "CollaborationStorage" };
	return { app: [socket, storage], api: [storage], router: [socket] }[kind];
};

// A copy of a Wrangler configuration with the region's optional bindings added. Returns { config, added }: added names them, empty when
// the region has none, and then config is the one given, untouched. kind: "app" (wrangler.jsonc), "api" or "router". COLLABORATION_ENABLED is
// never written here: on the app and the API Worker it is a secret (scripts/set-optional-worker-secrets.sh), which a deploy keeps, and a
// variable of the same name would clash with it.
export function applyOptionalBindings(config, kind, region, settings) {
	if (!hasCollaboration(settings, region)) return { config, added: [] };
	const copy = structuredClone(config);
	const added = [];
	for (const environment of ENVIRONMENTS[kind][region]) {
		const target = environment === null ? copy : copy.env?.[environment];
		if (!target) continue;
		target.services ??= [];
		for (const binding of bindingsFor(kind, region)) {
			if (target.services.some((existing) => existing.binding === binding.binding)) continue;
			target.services.push(binding);
			added.push(`${environment ?? "top level"}: ${binding.binding} -> ${binding.service}${binding.entrypoint ? `#${binding.entrypoint}` : ""}`);
		}
	}
	return { config: added.length > 0 ? copy : config, added };
}

export function describeOptionalWorkers(settings, region) {
	const parts = [];
	const { state, testOrigins } = settings[region].collaboration;
	if (state !== "off") parts.push(`collaboration ${state}${testOrigins.length > 0 ? ` (also accepts sockets from ${testOrigins.join(", ")})` : ""}`);
	if (settings[region].replies) parts.push("replies");
	return parts.length > 0 ? parts.join(", ") : "none: no configuration names an optional Worker";
}
