import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);

// QStash is the only caller of a job, so a job that doesn't check its signature is open to anyone.
test("every job route runs only for requests QStash signed", async () => {
	const jobs = (await readdir(new URL("app/api/jobs/", ROOT), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name);
	assert.ok(jobs.includes("run-automations"));
	for (const job of jobs) {
		const source = await readFile(new URL(`app/api/jobs/${job}/route.js`, ROOT), "utf8");
		assert.match(source, /export const POST = withQStashSignature\(/, `${job} checks the signature`);
		assert.doesNotMatch(source, /export (async )?function (GET|PUT|PATCH|DELETE)\b/, `${job} takes POST only`);
	}
});

test("everything an account holds is deleted with it", async () => {
	const { CONTENT_MODELS } = await import("../lib/account-purge.js");
	const { models } = await import("../lib/docdb/model.js");
	for (const file of (await readdir(new URL("models/", ROOT))).filter((name) => name.endsWith(".js"))) {
		await import(pathToFileURL(new URL(`models/${file}`, ROOT).pathname).href);
	}
	// Removed by the purge itself, after what they have at the email provider, in DNS and in storage.
	const removedLater = new Set(["Newsletter", "Domain", "Upload"]);
	const kept = new Set(CONTENT_MODELS.map((model) => model.modelName));
	const missing = Object.values(models)
		.filter((model) => model.schema.accountScoped && !kept.has(model.modelName) && !removedLater.has(model.modelName))
		.map((model) => model.modelName);
	assert.deepEqual(missing, [], "add them to CONTENT_MODELS in lib/account-purge.js");
});
