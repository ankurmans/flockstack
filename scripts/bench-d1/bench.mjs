// Drives the bench Worker (worker.mjs): a fresh account per size, each step checked against the rows it should leave.
//   BENCH_URL=https://... BENCH_SECRET_FILE=path node scripts/bench-d1/bench.mjs 1000 10000 50000
import { readFileSync } from "node:fs";

const url = process.env.BENCH_URL;
const secret = process.env.BENCH_SECRET ?? (process.env.BENCH_SECRET_FILE && readFileSync(process.env.BENCH_SECRET_FILE, "utf8").trim());
if (!url || !secret) throw new Error("Set BENCH_URL and BENCH_SECRET");
const sizes = process.argv.slice(2).map(Number);
const CHUNK = 1000;

async function call(step, params = {}) {
	const query = new URLSearchParams({ step, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value ?? "")])) });
	const start = performance.now();
	const response = await fetch(`${url}/run?${query}`, { method: "POST", headers: { "x-bench-secret": secret } });
	const text = await response.text();
	const clientMs = performance.now() - start;
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
	}
	return { ...body, clientMs };
}

function sum(calls) {
	const total = { requests: calls.length, ms: 0, clientMs: 0, maxRequestMs: 0, statements: 0, maxStatementsPerRequest: 0, calls: 0, maxCallsPerRequest: 0 };
	const maxes = { maxBatch: 0, maxParams: 0, maxSqlBytes: 0, maxParamBytes: 0, maxCallMs: 0 };
	const sums = { rowsRead: 0, rowsWritten: 0, sqlMs: 0 };
	const errors = [];
	for (const call of calls) {
		total.ms += call.ms ?? 0;
		total.clientMs += call.clientMs;
		total.maxRequestMs = Math.max(total.maxRequestMs, call.clientMs);
		total.statements += call.stats?.statements ?? 0;
		total.maxStatementsPerRequest = Math.max(total.maxStatementsPerRequest, call.stats?.statements ?? 0);
		total.calls += call.stats?.calls ?? 0;
		total.maxCallsPerRequest = Math.max(total.maxCallsPerRequest, call.stats?.calls ?? 0);
		for (const key of Object.keys(maxes)) maxes[key] = Math.max(maxes[key], call.stats?.[key] ?? 0);
		for (const key of Object.keys(sums)) sums[key] += call.stats?.[key] ?? 0;
		if (!call.ok) errors.push(call.error);
	}
	return { ...total, ...sums, ...maxes, errors };
}

function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
	return ok;
}

const report = [];
for (const n of sizes) {
	console.log(`\n== ${n} contacts`);
	const setup = await call("setup");
	if (!setup.ok) throw new Error(setup.error);
	const { account, newsletter, tag } = setup.result;
	const steps = {};

	for (const pass of [1, 2]) {
		const calls = [];
		let importId = "";
		for (let start = 0; start < n; start += CHUNK) {
			const result = await call("import", { account, newsletter, tag, start, n: Math.min(CHUNK, n - start), importId, pass });
			calls.push(result);
			if (!result.ok) {
				console.log(`  import error at ${start}: ${result.error}`);
				break;
			}
			importId = result.result.importId;
		}
		steps[pass === 1 ? "import" : "reimport"] = sum(calls);
		const counts = (await call("counts", { account })).result;
		if (pass === 1) {
			check("contacts after import", [counts.contacts, counts.byStatus], [n, { active: n }]);
			check("created", calls.reduce((total, { result }) => total + (result?.created ?? 0), 0), n);
		} else {
			check("contacts after reimport", [counts.contacts, counts.byStatus, counts.tagged], [n, { active: n - n / 10, unsubscribed: n / 10 }, n]);
			check("existing", calls.reduce((total, { result }) => total + (result?.existing ?? 0), 0), n);
		}
	}

	const unsubscribe = await call("unsubscribe", { account, newsletter });
	steps.unsubscribe = sum([unsubscribe]);
	check("unsubscribe modified", unsubscribe.result?.modified, n - n / 10);
	check("statuses after unsubscribe", (await call("counts", { account })).result.byStatus, { unsubscribed: n });

	const suppress = await call("suppress", { tag, start: 0, n });
	steps.suppress = sum([suppress]);
	check("never-email list", (await call("counts", { account })).result.globalSuppressions, n);

	const insertIgnore = await call("insertIgnore", { account, tag, n });
	steps.insertIgnore = sum([insertIgnore]);
	check("insertMany unordered, duplicates", insertIgnore.result, { duplicates: n / 2, total: n + n / 2 });

	// The same chunk twice at once (a retried request): one batch loses on the unique index and redoes its rows one by one.
	// New addresses, past the ones insertIgnore suppressed.
	const race = await Promise.all([1, 2].map(() => call("import", { account, newsletter, tag, start: 2 * n, n: CHUNK, pass: 1 })));
	steps.race = sum(race);
	check("concurrent imports", race.map(({ result }) => result && result.created + result.existing).concat((await call("counts", { account })).result.contacts), [CHUNK, CHUNK, n + CHUNK]);
	check("created once", race.reduce((total, { result }) => total + (result?.created ?? 0), 0), CHUNK);

	const purge = await call("purge", { account });
	steps.purge = sum([purge]);
	check("purged", purge.result?.deleted?.Contact, n + CHUNK);
	const after = (await call("counts", { account })).result;
	check("rows left", [after.contacts, after.suppressions, after.imports], [0, 0, 0]);

	const cleared = await call("clearGlobal");
	steps.clearGlobal = sum([cleared]);
	check("never-email list cleared", cleared.result?.deleted, n);

	for (const [name, step] of Object.entries(steps)) {
		console.log(
			`  ${name.padEnd(12)} ${(step.clientMs / 1000).toFixed(1).padStart(6)} s (worker ${(step.ms / 1000).toFixed(1)} s, D1 SQL ${(step.sqlMs / 1000).toFixed(2)} s) ` +
				`${step.requests} req, max ${(step.maxRequestMs / 1000).toFixed(1)} s/req, ${step.statements} stmts (max ${step.maxStatementsPerRequest}/req), ${step.calls} D1 calls (max ${step.maxCallsPerRequest}/req), ` +
				`read ${step.rowsRead} written ${step.rowsWritten}, max batch ${step.maxBatch}, max params ${step.maxParams}, max SQL ${step.maxSqlBytes} B, max param ${step.maxParamBytes} B, slowest call ${step.maxCallMs} ms` +
				(step.errors.length ? ` ERRORS: ${step.errors.join(" | ")}` : "")
		);
	}
	report.push({ n, steps });
}
console.log(JSON.stringify(report));
