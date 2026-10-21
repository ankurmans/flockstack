import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildManifestRows, renderManifest } from "../scripts/build-action-manifest.mjs";
import { ACTION_FILES } from "../lib/actions/groups.js";
import { ACTION_ENTRIES, getActionEntry, loadAction, loadAllActions } from "../lib/actions/lazy.js";
import { ACTIONS, DASHBOARD_ONLY_ACTIONS } from "../lib/actions/registry.js";

// lib/actions/manifest.js and groups.js let the REST API and runAction load one file of actions instead of the 42 registry.js loads.
// They have to say what registry.js says. After changing an action's name, method, path or permission, or adding a file of actions:
//   node --import ./tests/setup/register.mjs scripts/build-action-manifest.mjs
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("the manifest is what registry.js's actions are, in the same order", async () => {
	const written = readFileSync(`${ROOT}lib/actions/manifest.js`, "utf8");
	assert.equal(written, renderManifest(await buildManifestRows()), "lib/actions/manifest.js is out of date: run scripts/build-action-manifest.mjs (see the top of this test)");
	assert.deepEqual(ACTION_ENTRIES.map(({ name }) => name), [...ACTIONS, ...DASHBOARD_ONLY_ACTIONS].map(({ name }) => name));
	assert.deepEqual(ACTION_ENTRIES.filter(({ dashboardOnly }) => dashboardOnly).map(({ name }) => name), DASHBOARD_ONLY_ACTIONS.map(({ name }) => name));
});

test("every file registry.js imports is in groups.js, and nothing else is", () => {
	const registry = readFileSync(`${ROOT}lib/actions/registry.js`, "utf8");
	const imported = [...registry.matchAll(/import \{ (\w+) \} from "@\/lib\/actions\/([a-z-]+)";/g)].map(([, exportName, file]) => [file, exportName]);
	assert.deepEqual(Object.entries(ACTION_FILES).map(([file, { exportName }]) => [file, exportName]).sort(), imported.sort());
});

test("an action loads alone, by name, and is the registry's own object", async () => {
	for (const action of ACTIONS.filter((_, index) => index % 17 === 0)) {
		assert.equal(await loadAction(action.name), action);
		assert.equal(getActionEntry(action.name).path, action.http.path);
	}
	for (const action of DASHBOARD_ONLY_ACTIONS) assert.equal(await loadAction(action.name), action, "runAction loads a dashboard-only action by name");
	assert.equal(await loadAction("nothing_like_it"), null);
	assert.equal(getActionEntry("nothing_like_it"), null);
	assert.deepEqual((await loadAllActions()).map(({ name }) => name), ACTIONS.map(({ name }) => name));
	assert.deepEqual(await loadAllActions(), ACTIONS);
});
