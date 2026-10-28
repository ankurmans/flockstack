import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Aggregator as FullAggregator, Query as FullQuery } from "mingo";
import { Aggregator, OPERATORS, Query } from "../lib/docdb/mingo-engine.js";
import nextConfig from "../next.config.mjs";
import { buildApiWorker } from "../scripts/build-api-worker.mjs";

// lib/docdb/mingo-engine.js registers only the operators of mingo the source names, and lib/docdb/model.js loads it only where SQL can't answer.
// An operator the engine lacks fails when the query or the pipeline runs, so the source is read for every `$operator` and each one mingo has is
// asked for; and the narrowed engine answers like the whole library on the shapes the app sends.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));

// Where `$name` is a word of the source: queries, updates and pipelines are written out, never assembled from parts, apart from the
// comparison names in lib/segment-rules.js and the Better Auth adapter, which are in the list because their literals are.
function sourceFiles() {
	const files = [];
	const skip = new Set(["node_modules", "dist", ".next", ".open-next", ".worker", ".wrangler"]);
	const walk = (path) => {
		if (statSync(path).isDirectory()) {
			for (const name of readdirSync(path)) if (!skip.has(name)) walk(join(path, name));
		}
		else if (/\.(js|jsx|mjs)$/.test(path)) files.push(path);
	};
	for (const folder of ["lib", "app", "models", "components", "scripts", "workers"]) walk(join(ROOT, folder));
	for (const file of ["proxy.js", "worker-entry.mjs"]) files.push(join(ROOT, file));
	return files.filter((path) => !path.endsWith("lib/docdb/mingo-engine.js"));
}

// Used with the update operators and by SQL, which lib/docdb runs itself, so mingo never sees them: a pipeline stage mingo has is only ever
// run for $lookup by lib/docdb/model.js, and the projection operators only inside $project, which the app writes as field lists.
const NOT_SENT_TO_MINGO = { pipeline: ["$lookup"], projection: ["$elemMatch", "$slice"], window: null };

describe("the operators of the source", () => {
	const words = new Set();
	for (const file of sourceFiles()) for (const match of readFileSync(file, "utf8").matchAll(/\$[a-zA-Z]+/g)) words.add(match[0]);

	test("the source names a good many, so the scan is reading something", () => {
		for (const word of ["$match", "$group", "$sum", "$in", "$regex", "$dateToString", "$hour", "$expr"]) assert.ok(words.has(word), word);
	});

	for (const type of ["accumulator", "expression", "pipeline", "projection", "query", "window"]) {
		test(`every ${type} operator of mingo that the source names is registered`, () => {
			const known = Object.keys(require(`mingo/operators/${type}`)).filter((name) => name.startsWith("$"));
			const wanted = known.filter((name) => words.has(name) && !(NOT_SENT_TO_MINGO[type] ?? known).includes(name));
			const registered = Object.keys(OPERATORS[type] ?? {});
			assert.deepEqual(wanted.filter((name) => !registered.includes(name)), [], `add them to lib/docdb/mingo-engine.js (${type})`);
		});
	}

	test("what is registered is named by the source: no operator is carried for nothing", () => {
		const unused = Object.entries(OPERATORS).flatMap(([type, operators]) => Object.keys(operators).filter((name) => !words.has(name)).map((name) => `${type} ${name}`));
		assert.deepEqual(unused, []);
	});
});

const rows = [
	{ _id: "1", status: "active", email: "Ann@Example.com", score: 3, tags: ["a", "b"], fields: { plan: "pro" }, createdAt: new Date("2026-09-01T10:00:00Z"), unsubscribedAt: new Date("2026-09-02T10:00:00Z"), sentAt: new Date("2026-09-03T13:30:00Z"), newsletterId: "n1" },
	{ _id: "2", status: "active", email: "bob@example.org", score: 7, tags: ["b"], fields: { plan: "free" }, createdAt: new Date("2026-09-02T10:00:00Z"), sentAt: new Date("2026-09-03T01:15:00Z"), newsletterId: "n1" },
	{ _id: "3", status: "unsubscribed", email: "cy@example.com", tags: [], createdAt: new Date("2026-09-03T10:00:00Z"), unsubscribedAt: new Date("2026-12-30T10:00:00Z"), newsletterId: "n2" },
	{ _id: "4", status: "bounced", email: "di@example.net", score: 0, tags: ["c", "a"], fields: {}, createdAt: new Date("2026-09-04T10:00:00Z"), sentAt: new Date("2026-09-05T23:59:00Z"), newsletterId: "n2" },
];

const filters = [
	{ status: "active" },
	{ status: { $in: ["active", "bounced"] } },
	{ status: { $nin: ["active"] } },
	{ status: { $ne: "active" } },
	{ score: { $exists: false } },
	{ score: { $exists: true } },
	{ score: { $gt: 0, $lte: 3 } },
	{ score: { $gte: 3, $lt: 7 } },
	{ score: { $type: "number" } },
	{ email: { $regex: "^ann@", $options: "i" } },
	{ email: { $regex: "example\\.com$" } },
	{ $or: [{ status: "bounced" }, { score: 7 }] },
	{ $and: [{ status: "active" }, { tags: "b" }] },
	{ $nor: [{ status: "active" }] },
	{ status: { $not: { $in: ["active"] } } },
	{ tags: { $all: ["a", "b"] } },
	{ tags: { $elemMatch: { $eq: "c" } } },
	{ "fields.plan": { $in: ["pro"] } },
	{ $expr: { $gt: ["$unsubscribedAt", { $add: ["$createdAt", 90 * 86_400_000] }] } },
	{ $expr: { $and: [{ $lte: ["$score", 3] }, { $ne: ["$status", "bounced"] }] } },
	{ $expr: { $or: [{ $eq: ["$status", "bounced"] }, { $in: ["$score", [7]] }] } },
	{ $expr: { $not: [{ $gte: ["$score", 3] }] } },
];

const pipelines = [
	[{ $match: { status: "active" } }, { $count: "count" }],
	[{ $group: { _id: "$status", n: { $sum: 1 }, best: { $max: "$score" }, worst: { $min: "$score" }, emails: { $addToSet: "$email" }, first: { $first: "$email" }, all: { $push: "$score" } } }, { $sort: { _id: 1 } }],
	[{ $group: { _id: "$newsletterId", opened: { $sum: { $cond: [{ $ifNull: ["$sentAt", false] }, 1, 0] } }, spread: { $sum: { $subtract: ["$score", 1] } } } }, { $sort: { _id: 1 } }],
	[{ $match: { sentAt: { $exists: true } } }, { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$sentAt", timezone: "+00:00" } }, hour: { $hour: { date: "$sentAt", timezone: "+00:00" } } }, n: { $sum: 1 } } }, { $sort: { "_id.day": 1, "_id.hour": 1 } }],
	[{ $match: { sentAt: { $exists: true } } }, { $project: { email: 1, newsletterId: 1 } }, { $sort: { email: -1 } }, { $limit: 2 }],
	[{ $addFields: { delta: { $abs: { $subtract: [{ $ifNull: ["$score", 0] }, 5] } } } }, { $project: { delta: 1 } }, { $sort: { _id: 1 } }],
	[{ $unwind: "$tags" }, { $group: { _id: "$tags", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
	[{ $set: { score: { $add: [{ $ifNull: ["$score", 0] }, 1] } } }, { $unset: "tags" }, { $project: { score: 1, tags: 1 } }, { $sort: { _id: 1 } }],
	[{ $group: { _id: null, all: { $addToSet: { $type: "$score" } } } }],
	[{ $group: { _id: "$status", has: { $first: { $in: ["a", { $ifNull: ["$tags", []] }] } } } }, { $sort: { _id: 1 } }],
];

describe("the narrowed engine answers like the whole library", () => {
	test("filters", () => {
		for (const filter of filters) {
			const narrowed = rows.filter((row) => new Query(filter).test(row)).map(({ _id }) => _id);
			const whole = rows.filter((row) => new FullQuery(filter).test(row)).map(({ _id }) => _id);
			assert.deepEqual(narrowed, whole, JSON.stringify(filter));
		}
	});

	test("pipelines", () => {
		for (const pipeline of pipelines) {
			const narrowed = new Aggregator(pipeline).run(structuredClone(rows));
			const whole = new FullAggregator(pipeline).run(structuredClone(rows));
			assert.deepEqual(narrowed, whole, JSON.stringify(pipeline));
		}
	});

	test("an update given as a pipeline, as lib/docdb/model.js runs one", () => {
		const update = [{ $set: { score: { $add: [{ $ifNull: ["$score", 0] }, 1] }, status: "active" } }];
		assert.deepEqual(new Aggregator(update).run([structuredClone(rows[2])])[0], new FullAggregator(update).run([structuredClone(rows[2])])[0]);
	});

	test("an operator that is not registered fails where it is used, not silently", () => {
		assert.throws(() => new Query({ score: { $mod: [2, 1] } }), /\$mod/);
		assert.throws(() => new Aggregator([{ $project: { x: { $multiply: [2, 3] } } }]).run([{ a: 1 }]), /\$multiply/);
	});
});

describe("mingo is loaded where SQL can't answer, not before", () => {
	test("model.js has no static import of mingo; the engine is the one place that names it", () => {
		const model = readFileSync(join(ROOT, "lib/docdb/model.js"), "utf8");
		assert.doesNotMatch(model, /from "mingo/);
		assert.match(model, /import\("\.\/mingo-engine\.js"\)/);
		const others = sourceFiles().filter((path) => /from "mingo/.test(readFileSync(path, "utf8")));
		assert.deepEqual(others.map((path) => path.slice(ROOT.length)), []);
	});

	// A query SQL answers (an equality, a range, a sort) never loads it; one SQL can't, and an aggregation, do.
	const probe = `
		import { createRequire } from "node:module";
		import mongoose from "./lib/docdb/index.js";
		import { setDriver, sqliteDriver } from "./lib/docdb/driver.js";
		const loaded = () => Object.keys(createRequire(import.meta.url).cache).some((path) => path.includes("/node_modules/mingo/"));
		setDriver(await sqliteDriver(":memory:"));
		const Thing = mongoose.model("MingoProbe", new mongoose.Schema({ name: String, n: Number, tags: [String] }));
		await Thing.init();
		await Thing.create([{ name: "a", n: 1, tags: ["x"] }, { name: "b", n: 2, tags: ["y"] }]);
		const steps = [];
		const step = async (label, run) => { await run(); steps.push([label, loaded()]); };
		await step("equality", () => Thing.find({ name: "a" }).lean());
		await step("range and sort", () => Thing.find({ n: { $gte: 1 } }).sort({ n: -1 }).limit(5).lean());
		await step("in", () => Thing.find({ name: { $in: ["a", "b"] } }).lean());
		await step("count", () => Thing.countDocuments({ n: { $lt: 5 } }));
		await step("update", () => Thing.updateOne({ name: "a" }, { $set: { n: 5 }, $inc: { n: 1 } }));
		await step("upsert", () => Thing.updateOne({ name: "c" }, { $set: { n: 9 } }, { upsert: true }));
		await step("pipeline update", () => Thing.updateOne({ name: "a" }, [{ $set: { n: { $add: ["$n", 1] } } }]));
		await step("aggregate", () => Thing.aggregate([{ $match: { n: { $gt: 0 } } }, { $group: { _id: "$name", total: { $sum: "$n" } } }]));
		console.log(JSON.stringify(steps));
	`;
	test("equalities, ranges, sorts, counts and ordinary updates never load it; a pipeline does", () => {
		const result = spawnSync(process.execPath, ["--import", "./tests/setup/register.mjs", "--input-type=module", "-e", probe], { cwd: ROOT, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const steps = JSON.parse(result.stdout.trim().split("\n").at(-1));
		assert.deepEqual(steps, [["equality", false], ["range and sort", false], ["in", false], ["count", false], ["update", false], ["upsert", false], ["pipeline update", true], ["aggregate", true]]);
	});
});

// Node runs the tests on mingo's CommonJS build, which no bundler can tree-shake; the Workers and the app's layers are given its ESM build
// (scripts/mingo-esm.mjs), where only what the engine names is kept. Same library, two builds: the bundled engine is asked the same things.
describe("the bundles take mingo's ESM build", () => {
	const subpaths = [...readFileSync(join(ROOT, "lib/docdb/mingo-engine.js"), "utf8").matchAll(/from "(mingo\/[^"]+)"/g)].map((match) => match[1]);

	test("the app's Turbopack aliases send every subpath the engine imports to the ESM build", () => {
		assert.ok(subpaths.length >= 5, subpaths.join());
		for (const name of subpaths) assert.match(nextConfig.turbopack.resolveAlias[name] ?? "", /^\.\/node_modules\/mingo\/esm\/.+\.js$/, name);
	});

	test("the Workers' bundle of the engine has no CommonJS mingo, is a fraction of the package and answers like the whole library", async () => {
		const folder = mkdtempSync(join(tmpdir(), "mingo-esm-"));
		try {
			const outFile = join(folder, "engine.mjs");
			const { bytes } = await buildApiWorker({ entry: join(ROOT, "lib/docdb/mingo-engine.js"), outFile, metafile: true });
			const inputs = Object.keys(JSON.parse(readFileSync(`${outFile}.meta.json`, "utf8")).inputs).filter((path) => path.includes("node_modules/mingo/"));
			assert.ok(inputs.length > 0);
			assert.deepEqual(inputs.filter((path) => !path.includes("node_modules/mingo/esm/")), []);
			assert.ok(bytes < 150_000, `${bytes} bytes`);
			const bundled = await import(pathToFileURL(outFile).href);
			for (const filter of filters) {
				const narrowed = rows.filter((row) => new bundled.Query(filter).test(row)).map(({ _id }) => _id);
				assert.deepEqual(narrowed, rows.filter((row) => new FullQuery(filter).test(row)).map(({ _id }) => _id), JSON.stringify(filter));
			}
			for (const pipeline of pipelines) assert.deepEqual(new bundled.Aggregator(pipeline).run(structuredClone(rows)), new FullAggregator(pipeline).run(structuredClone(rows)), JSON.stringify(pipeline));
			assert.throws(() => new bundled.Query({ score: { $mod: [2, 1] } }), /\$mod/);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
