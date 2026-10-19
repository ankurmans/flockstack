// Times the bulk paths on a local SQLite file, and counts the statements each sends (what D1 bills and limits):
//   node --import ./tests/setup/register.mjs scripts/bench-bulk.mjs [contacts] [file]
// The tests' stubs stand in for every outside service (tests/setup), so nothing reaches the network.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const total = Number(process.argv[2] ?? 50_000);
const file = process.argv[3] ?? join(tmpdir(), `flockstack-bench-${process.pid}.sqlite`);
const CHUNK = 1000;

Object.assign(process.env, {
	NODE_ENV: "test",
	FLOCKSTACK_CLOUD: "true",
	BETTER_AUTH_SECRET: "bench-secret-for-local-runs-0123456789abcdef",
	SUPPRESSION_HASH_KEY: "bench-suppression-hash-key-0123456789abcdef",
	APP_URL: "http://localhost:3000",
});

const { setDriver, sqliteDriver } = await import("../lib/docdb/driver.js");
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
const inner = await sqliteDriver(file);
const counts = { statements: 0 };
setDriver({
	...inner,
	query: (sql, params) => {
		counts.statements++;
		return inner.query(sql, params);
	},
	batch: (statements) => {
		counts.statements += statements.length;
		return inner.batch(statements);
	},
});

const { Types } = await import("../lib/docdb/index.js");
const { importContacts } = await import("../lib/contact-import.js");
const { suppressGlobally } = await import("../lib/global-suppressions.js");
const Account = (await import("../models/Account.js")).default;
const Contact = (await import("../models/Contact.js")).default;
const Newsletter = (await import("../models/Newsletter.js")).default;

const account = await Account.create({ ownerId: new Types.ObjectId() });
const newsletter = await Newsletter.create({ accountId: account._id, name: "Bench", slug: "bench", fromEmail: "hello@example.com" });
const emails = Array.from({ length: total }, (_, index) => `reader${index}@example.com`);
const results = [];

async function measure(name, run) {
	const before = counts.statements;
	const start = performance.now();
	const outcome = await run();
	const ms = performance.now() - start;
	results.push({ name, seconds: (ms / 1000).toFixed(2), statements: counts.statements - before, outcome });
	console.log(`${name}: ${(ms / 1000).toFixed(2)} s, ${counts.statements - before} statements ${JSON.stringify(outcome)}`);
}

async function importAll(rowFor, tags = []) {
	let created = 0;
	let existing = 0;
	let importId;
	for (let start = 0; start < total; start += CHUNK) {
		const rows = emails.slice(start, start + CHUNK).map(rowFor);
		const result = await importContacts({ account, newsletterId: String(newsletter._id), rows, consent: true, importId, tags });
		if (result.error) throw new Error(result.error);
		importId = result.importId;
		created += result.created;
		existing += result.existing;
	}
	return { created, existing };
}

await measure(`Import ${total} new contacts`, () => importAll((email) => ({ email, status: "active", fields: {} })));
await measure(`Import them again, tagged, a tenth unsubscribed`, () =>
	importAll((email, index) => ({ email, status: index % 10 === 0 ? "unsubscribed" : "active" }), ["second-file"])
);
await measure("Unsubscribe every active contact", async () => {
	const { modifiedCount } = await Contact.updateMany(
		{ accountId: account._id, newsletterId: newsletter._id, status: "active" },
		{ $set: { status: "unsubscribed", unsubscribedAt: new Date() } }
	);
	return { modified: modifiedCount };
});
await measure("Put 5,000 addresses on the never-email list", async () => {
	await suppressGlobally({ emails: emails.slice(0, 5000), reason: "bounce", detail: "bench" });
	return { emails: 5000 };
});
await measure("Delete the account's contacts", async () => {
	const { deletedCount } = await Contact.deleteMany({ accountId: account._id });
	return { deleted: deletedCount };
});

inner.close();
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
console.log(JSON.stringify(results));
