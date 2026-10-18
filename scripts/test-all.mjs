// Runs every tests/*.test.mjs in its own process, six at a time, with a time cap per file, and prints only the files
// that fail. Logs land in the directory given: node scripts/test-all.mjs /tmp/logs [name-pattern]
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = process.argv[2];
if (!out) throw new Error("Give a directory for the logs");
mkdirSync(out, { recursive: true });
const pattern = process.argv[3] ? new RegExp(process.argv[3]) : null;
const queue = readdirSync(`${root}tests`)
	.filter((name) => name.endsWith(".test.mjs") && (!pattern || pattern.test(name)))
	.sort();
const results = [];

function runOne(file) {
	return new Promise((resolve) => {
		const child = spawn("node", ["--import", "./tests/setup/register.mjs", "--test", "--test-timeout=120000", `tests/${file}`], { cwd: root });
		let log = "";
		child.stdout.on("data", (chunk) => (log += chunk));
		child.stderr.on("data", (chunk) => (log += chunk));
		const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			writeFileSync(`${out}/${file}.log`, log);
			results.push({
				file,
				pass: Number(/ℹ pass (\d+)/.exec(log)?.[1] ?? 0),
				fail: Number(/ℹ fail (\d+)/.exec(log)?.[1] ?? 0),
				code,
				signal,
			});
			resolve();
		});
	});
}

async function worker() {
	while (queue.length > 0) await runOne(queue.shift());
}

await Promise.all(Array.from({ length: 6 }, worker));
results.sort((a, b) => a.file.localeCompare(b.file));
for (const r of results) if (r.fail || r.code !== 0) console.log(`FAIL ${r.file} pass=${r.pass} fail=${r.fail} code=${r.code} ${r.signal ?? ""}`);
const failing = results.filter((r) => r.fail || r.code !== 0).length;
console.log(`files=${results.length} pass=${results.reduce((n, r) => n + r.pass, 0)} fail=${results.reduce((n, r) => n + r.fail, 0)} filesFailing=${failing}`);
process.exitCode = failing ? 1 : 0;
