import { ACTION_FILES } from "@/lib/actions/groups";
import { ACTION_MANIFEST } from "@/lib/actions/manifest";

// Actions one file at a time. registry.js builds every action of every file as it loads (each one a zod schema and the code that
// the handler pulls in), which a request for one action has no use for: the REST API finds its action from the manifest (name,
// file, method, path, permission) and loads only that file; runAction does the same by name. Anything that needs all of them
// (MCP's tool list, the docs) loads them all with loadAllActions, or imports registry.js as before.

export const ACTION_ENTRIES = ACTION_MANIFEST.map(([name, file, method, path, permission]) => Object.freeze({ name, file, method, path, permission }));
const BY_NAME = new Map(ACTION_ENTRIES.map((entry) => [entry.name, entry]));
const files = new Map();

function loadFile(file) {
	if (!files.has(file)) {
		const { exportName, load } = ACTION_FILES[file];
		files.set(
			file,
			load().then(
				(module) => module[exportName],
				(error) => {
					files.delete(file);
					throw error;
				}
			)
		);
	}
	return files.get(file);
}

export function getActionEntry(name) {
	return BY_NAME.get(name) ?? null;
}

// The action, or null when there is none of that name.
export async function loadAction(name) {
	const entry = BY_NAME.get(name);
	if (!entry) return null;
	return (await loadFile(entry.file)).find((action) => action.name === name) ?? null;
}

// Every action in registry.js's order, once all the files are loaded.
let everything;

export function loadAllActions() {
	everything ??= Promise.all(Object.keys(ACTION_FILES).map(loadFile))
		.then((groups) => {
			const byName = new Map(groups.flat().map((action) => [action.name, action]));
			return ACTION_ENTRIES.map(({ name }) => byName.get(name));
		})
		.catch((error) => {
			everything = undefined;
			throw error;
		});
	return everything;
}
