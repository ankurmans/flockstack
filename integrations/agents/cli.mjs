#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const COMMANDS = {
	bootstrap: ["POST", "/api/v1/agent/bootstrap"],
	brief: ["GET", "/api/v1/agent/brief"],
	"send-time": ["GET", "/api/v1/agent/send-time"],
	"reader-settings": ["GET", "/api/v1/reader-settings"],
	replies: ["GET", "/api/v1/replies"],
	"import-paid": ["POST", "/api/v1/payments/import-subscribers"],
	"workspace-create": ["POST", "/api/agent-workspaces"],
	"reader-subscribe": ["POST", "/api/reader-subscriptions"],
};
export async function main(args = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
	const [command, ...rest] = args;
	if (!COMMANDS[command]) throw new Error(`Usage: cli.mjs <${Object.keys(COMMANDS).join("|")}> --input file.json [--output private.json]`);
	const options = {};
	for (let i = 0; i < rest.length; i += 2) {
		if (!["--input", "--output"].includes(rest[i]) || !rest[i + 1]) throw new Error("Use --input and optional --output");
		options[rest[i]] = rest[i + 1];
	}
	const base = new URL(env.FLOCKSTACK_URL ?? "https://flockstack.io");
	if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) throw new Error("FLOCKSTACK_URL must be an HTTPS origin, or local HTTP");
	if (!options["--input"]) throw new Error("Provide --input file.json");
	const input = JSON.parse(await readFile(options["--input"], "utf8"));
	const [method, path] = COMMANDS[command];
	const publicCall = ["workspace-create", "reader-subscribe"].includes(command);
	if (!publicCall && !env.FLOCKSTACK_API_KEY) throw new Error("Set FLOCKSTACK_API_KEY in your environment");
	if (command === "workspace-create" && !options["--output"]) throw new Error("Workspace capabilities must be saved with --output to a new private file");
	if (command === "import-paid" && input.apply) throw new Error("CLI import-paid is preview-only. Apply an explicitly reviewed import in the dashboard or REST API.");
	const url = new URL(path, base);
	if (method === "GET") for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
	const response = await fetchImpl(url, { method, headers: { "content-type": "application/json", ...(!publicCall && { authorization: `Bearer ${env.FLOCKSTACK_API_KEY}` }) }, ...(method !== "GET" && { body: JSON.stringify(input) }), redirect: "error", signal: AbortSignal.timeout(120000) });
	if (!response.ok) throw new Error(`FlockStack returned HTTP ${response.status}. Check the input and account permissions.`);
	const result = await response.json();
	if (options["--output"]) { await writeFile(options["--output"], `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 }); return { saved: true, file: options["--output"] }; }
	return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
