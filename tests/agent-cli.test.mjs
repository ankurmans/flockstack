import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../integrations/agents/cli.mjs";

test("CLI rejects unsafe origins and paid apply before making a request", async () => {
	const folder = await mkdtemp(join(tmpdir(), "flockstack-cli-test-"));
	const input = join(folder, "input.json"); await writeFile(input, '{"apply":true}');
	let calls = 0; const fetcher = async () => { calls++; return Response.json({}); };
	await assert.rejects(main(["brief", "--input", input], { FLOCKSTACK_URL: "http://example.com", FLOCKSTACK_API_KEY: "private" }, fetcher), /HTTPS/);
	await assert.rejects(main(["import-paid", "--input", input], { FLOCKSTACK_API_KEY: "private" }, fetcher), /preview-only/);
	await assert.rejects(main(["workspace-create", "--input", input], {}, fetcher), /private file/);
	assert.equal(calls, 0);
});
test("CLI refuses redirects and keeps public workspace capabilities in a new private file", async () => {
	const folder = await mkdtemp(join(tmpdir(), "flockstack-cli-test-"));
	const input = join(folder, "input.json"); const output = join(folder, "private.json"); await writeFile(input, '{"name":"Example"}');
	let request;
	const result = await main(["workspace-create", "--input", input, "--output", output], { FLOCKSTACK_API_KEY: "must-not-send" }, async (url, init) => { request = { url, ...init }; return Response.json({ draftToken: "private-capability", claimUrl: "https://example.com/claim#token=private" }); });
	assert.equal(request.redirect, "error"); assert.equal(request.headers.authorization, undefined);
	assert.equal((await stat(output)).mode & 0o777, 0o600); assert.match(await readFile(output, "utf8"), /private-capability/);
	assert.doesNotMatch(JSON.stringify(result), /private-capability|claimUrl/);
	await assert.rejects(main(["workspace-create", "--input", input, "--output", output], {}, async () => Response.json({})), /EEXIST/);
});
