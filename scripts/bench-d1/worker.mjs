// A throwaway Worker that runs FlockStack's bulk write paths against a real D1 database and reports what each one cost:
// time, statements and D1 calls, rows read and written, and the biggest statement, batch and parameter it sent.
// Never point it at a database with customers' data: its steps delete whole tables' rows. In scripts/bench-d1:
//   wrangler d1 create flockstack-bench, then each migrations/*.sql with wrangler d1 execute flockstack-bench --remote --file
//   cp wrangler.example.jsonc wrangler.jsonc, with the database's id
//   wrangler deploy -c wrangler.jsonc, then wrangler secret put BENCH_SECRET -c wrangler.jsonc
//   BENCH_URL=https://flockstack-bench.<subdomain>.workers.dev BENCH_SECRET=... node bench.mjs 1000 10000 50000
//   wrangler delete -c wrangler.jsonc and wrangler d1 delete flockstack-bench when done
import { d1Driver, setDriver } from "../../lib/docdb/driver.js";
import { Types } from "../../lib/docdb/index.js";
import { BULK_LIMITS } from "../../lib/docdb/model.js";
import { scoped } from "../../lib/account-scope.js";
import { importContacts } from "../../lib/contact-import.js";
import { suppressGlobally } from "../../lib/global-suppressions.js";
import Account from "../../models/Account.js";
import Contact from "../../models/Contact.js";
import ContactImport from "../../models/ContactImport.js";
import Event from "../../models/Event.js";
import GlobalSuppression from "../../models/GlobalSuppression.js";
import Message from "../../models/Message.js";
import Newsletter from "../../models/Newsletter.js";
import Suppression from "../../models/Suppression.js";
import Tag from "../../models/Tag.js";

// lib/account-purge.js's CONTENT_MODELS that hold a benchmark account's rows, in its order. Importing that module would
// bundle the storage, auth and email providers it calls first.
const CONTENT_MODELS = [Message, Event, Contact, ContactImport, Suppression, Tag];

function freshStats() {
	return { calls: 0, batches: 0, statements: 0, rowsRead: 0, rowsWritten: 0, sqlMs: 0, maxBatch: 0, maxParams: 0, maxSqlBytes: 0, maxParamBytes: 0, maxCallMs: 0 };
}

let stats = freshStats();
const encoder = new TextEncoder();
const real = new WeakMap();

function note(sql, params) {
	stats.statements++;
	stats.maxParams = Math.max(stats.maxParams, params.length);
	stats.maxSqlBytes = Math.max(stats.maxSqlBytes, encoder.encode(sql).length);
	for (const param of params) if (typeof param === "string") stats.maxParamBytes = Math.max(stats.maxParamBytes, encoder.encode(param).length);
}

// With ?trace=1, each statement's rows read and written and its SQL time, for finding a bad query plan.
let trace = null;

function tally(results, ms, sqls) {
	stats.maxCallMs = Math.max(stats.maxCallMs, ms);
	results.forEach(({ meta }, index) => trace?.push({ sql: sqls[index].slice(0, 220), read: meta?.rows_read, written: meta?.rows_written, ms: meta?.duration }));
	for (const { meta } of results) {
		stats.rowsRead += meta?.rows_read ?? 0;
		stats.rowsWritten += meta?.rows_written ?? 0;
		stats.sqlMs += meta?.duration ?? 0;
	}
}

// The D1 binding, counted: d1Driver only calls prepare(sql).bind(...).all() and batch([...]).
function counted(binding) {
	return {
		prepare(sql) {
			return {
				bind(...params) {
					const statement = binding.prepare(sql).bind(...params);
					const wrapper = {
						async all() {
							note(sql, params);
							stats.calls++;
							const start = Date.now();
							const result = await statement.all();
							tally([result], Date.now() - start, [sql]);
							return result;
						},
					};
					real.set(wrapper, { statement, sql, params });
					return wrapper;
				},
			};
		},
		async batch(wrappers) {
			const inner = wrappers.map((wrapper) => real.get(wrapper));
			for (const { sql, params } of inner) note(sql, params);
			stats.calls++;
			stats.batches++;
			stats.maxBatch = Math.max(stats.maxBatch, wrappers.length);
			const start = Date.now();
			const results = await binding.batch(inner.map(({ statement }) => statement));
			tally(results, Date.now() - start, inner.map(({ sql }) => sql));
			return results;
		},
	};
}

const emailOf = (tag, index) => `reader${index}.${tag}@example.com`;

const STEPS = {
	async setup() {
		const account = await Account.create({ ownerId: new Types.ObjectId() });
		const tag = String(account._id).slice(-8);
		const newsletter = await Newsletter.create({ accountId: account._id, name: "Bench", slug: `bench-${tag}`, fromEmail: "hello@example.com" });
		return { account: String(account._id), newsletter: String(newsletter._id), tag };
	},

	// One chunk of a CSV import, as the dashboard sends it: pass 2 is the same file again, tagged, a tenth unsubscribed.
	async import({ account, newsletter, tag, start, n, importId, pass }) {
		const found = await Account.findById(account).lean();
		const rows = Array.from({ length: n }, (_, offset) => {
			const index = start + offset;
			return pass === 2 ? { email: emailOf(tag, index), status: index % 10 === 0 ? "unsubscribed" : "active" } : { email: emailOf(tag, index), status: "active", fields: {} };
		});
		const result = await importContacts({ account: found, newsletterId: newsletter, rows, consent: true, importId: importId || undefined, tags: pass === 2 ? ["second-file"] : [] });
		if (result.error) throw new Error(result.error);
		return { importId: result.importId, created: result.created, existing: result.existing, dropped: result.dropped };
	},

	async unsubscribe({ account, newsletter }) {
		const { matchedCount, modifiedCount } = await Contact.updateMany(
			{ accountId: account, newsletterId: newsletter, status: "active" },
			{ $set: { status: "unsubscribed", unsubscribedAt: new Date() } }
		);
		return { matched: matchedCount, modified: modifiedCount };
	},

	async suppress({ tag, start, n }) {
		await suppressGlobally({ emails: Array.from({ length: n }, (_, offset) => emailOf(tag, start + offset)), reason: "bounce", detail: "bench" });
		return { emails: n };
	},

	// insertMany unordered, as sends insert their messages: n rows, then n more of which the first half are already there.
	async insertIgnore({ account, tag, n }) {
		const rows = (start) => Array.from({ length: n }, (_, offset) => ({ accountId: account, email: emailOf(tag, start + offset), reason: "manual" }));
		await Suppression.insertMany(rows(0), { ordered: false });
		try {
			await Suppression.insertMany(rows(n / 2), { ordered: false });
			return { duplicates: 0 };
		} catch (error) {
			if (error.code !== 11000) throw error;
			return { duplicates: error.writeErrors.length, total: await Suppression.countDocuments({ accountId: account }) };
		}
	},

	// What purgeAccount's deleteContent deletes by accountId, a chunk a call, then the newsletter and the account.
	async purge({ account }) {
		const scope = scoped({ _id: new Types.ObjectId(account) });
		const deleted = {};
		for (const Model of CONTENT_MODELS) {
			for (;;) {
				const { deletedCount } = await Model.deleteMany(scope).setOptions({ limit: BULK_LIMITS.deleteChunk });
				if (deletedCount > 0) deleted[Model.modelName] = (deleted[Model.modelName] ?? 0) + deletedCount;
				if (deletedCount < BULK_LIMITS.deleteChunk) break;
			}
		}
		await Newsletter.deleteMany(scope);
		await Account.deleteOne({ _id: account });
		return { deleted };
	},

	async clearGlobal() {
		const { deletedCount } = await GlobalSuppression.deleteMany({});
		return { deleted: deletedCount };
	},

	async counts({ account }, env) {
		const one = async (sql, ...params) => (await env.DB.prepare(sql).bind(...params).first()).n;
		const byStatus = await env.DB.prepare("SELECT json_extract(data, '$.status') AS status, COUNT(*) AS n FROM c_contacts WHERE accountId = ? GROUP BY 1")
			.bind(account ?? "")
			.all();
		return {
			contacts: await one("SELECT COUNT(*) AS n FROM c_contacts WHERE accountId = ?", account ?? ""),
			byStatus: Object.fromEntries(byStatus.results.map(({ status, n }) => [status, n])),
			tagged: await one("SELECT COUNT(*) AS n FROM c_contacts WHERE accountId = ? AND EXISTS (SELECT 1 FROM json_each(data, '$.tags') WHERE value = 'second-file')", account ?? ""),
			suppressions: await one("SELECT COUNT(*) AS n FROM c_suppressions WHERE accountId = ?", account ?? ""),
			imports: await one("SELECT COUNT(*) AS n FROM c_contactimports WHERE accountId = ?", account ?? ""),
			globalSuppressions: await one("SELECT COUNT(*) AS n FROM c_globalsuppressions"),
			allContacts: await one("SELECT COUNT(*) AS n FROM c_contacts"),
			accounts: await one("SELECT COUNT(*) AS n FROM c_accounts"),
		};
	},

	// What D1's queries-per-invocation limit counts: n calls of `size` statements each (1: a plain query, more: a batch).
	async probe({ n, size }, env) {
		const each = Number(size) || 1;
		let done = 0;
		try {
			for (; done < n; done++) {
				if (each === 1) await env.DB.prepare("SELECT 1").all();
				else await env.DB.batch(Array.from({ length: each }, () => env.DB.prepare("SELECT 1")));
			}
			return { calls: done, statements: done * each };
		} catch (error) {
			return { failedAtCall: done, statements: done * each, error: String(error?.message ?? error) };
		}
	},

	async plan({ sql }, env) {
		return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results.map(({ detail }) => detail);
	},
};

function constantTimeEqual(a, b) {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let index = 0; index < left.length; index++) diff |= left[index] ^ right[index];
	return diff === 0;
}

const worker = {
	async fetch(request, env) {
		if (!env.BENCH_SECRET || !constantTimeEqual(request.headers.get("x-bench-secret") ?? "", env.BENCH_SECRET)) return new Response("Not found", { status: 404 });
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/run") return new Response("Not found", { status: 404 });
		const step = STEPS[url.searchParams.get("step")];
		if (!step) return Response.json({ error: "unknown step" }, { status: 400 });
		const query = Object.fromEntries(url.searchParams);
		const input = { ...query, start: Number(query.start ?? 0), n: Number(query.n ?? 0), pass: Number(query.pass ?? 1), ...(request.headers.get("content-type") === "application/json" && (await request.json())) };
		setDriver(d1Driver(counted(env.DB)));
		stats = freshStats();
		trace = query.trace ? [] : null;
		const started = Date.now();
		try {
			const result = await step(input, env);
			return Response.json({ ok: true, ms: Date.now() - started, stats, result, ...(trace && { trace }) });
		} catch (error) {
			return Response.json({ ok: false, ms: Date.now() - started, stats, error: String(error?.message ?? error), stack: String(error?.stack ?? "").slice(0, 2000) });
		}
	},
};

export default worker;
