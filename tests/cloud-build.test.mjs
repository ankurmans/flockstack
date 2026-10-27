import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApiWorker, CLOUD_BUILD_ALIASES, isCloudBuild } from "../scripts/build-api-worker.mjs";
import { getBuildEnv } from "../scripts/deploy-all.mjs";
import * as stub from "../lib/cloud-build/unavailable-storage.js";
import { getImageStorageProblem } from "../lib/image-storage.js";

// The FlockStack Cloud build keeps images in R2, so it leaves out the S3, CloudFront and Vercel Blob clients (about 2.2 MB of the app Worker):
// next.config.mjs and scripts/build-api-worker.mjs put a stub that throws in their place when FLOCKSTACK_CLOUD_BUILD=true, which
// scripts/deploy-all.mjs sets for its builds. Any other build, the open source one included, has the packages.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGES = ["@vercel/blob", "@aws-sdk/client-s3", "@aws-sdk/client-cloudfront"];

function readConfig(flag) {
	const script = `const config = (await import("./next.config.mjs")).default; console.log(JSON.stringify({ alias: config.turbopack.resolveAlias, env: config.env }));`;
	const env = { PATH: process.env.PATH, ...(flag !== undefined && { FLOCKSTACK_CLOUD_BUILD: flag }) };
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8", env });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

describe("the stub", () => {
	test("has every name lib/image-storage.js takes from the three packages", () => {
		const source = readFileSync(join(ROOT, "lib/image-storage.js"), "utf8");
		const taken = [];
		for (const match of source.matchAll(/const \{([^}]+)\} = await (?:import\("(?:@aws-sdk\/client-s3|@aws-sdk\/client-cloudfront)"\)|loadVercelBlob\(\))/g)) {
			taken.push(...match[1].split(",").map((name) => name.trim().split(":")[0].trim()));
		}
		assert.ok(taken.length >= 7 && taken.includes("put") && taken.includes("del"), `found ${taken.join(", ")}`);
		for (const name of taken) assert.equal(typeof stub[name], "function", `${name} is exported`);
		assert.equal(source.match(/import\("@vercel\/blob"\)/g)?.length, 1, "and the one import of Vercel Blob is the one that loadVercelBlob makes");
	});

	test("throws, with the reason, the moment anything uses it", () => {
		assert.throws(() => stub.put(), /images are stored in R2 \(IMAGES_STORAGE=r2\)/);
		assert.throws(() => stub.del(), /no S3, CloudFront or Vercel Blob client/);
		for (const name of ["S3Client", "PutObjectCommand", "DeleteObjectsCommand", "CloudFrontClient", "CreateInvalidationCommand"]) assert.throws(() => new stub[name](), /R2/, name);
	});
});

describe("the builds", () => {
	test("the app build aliases the three packages to the stub only when it is the Cloud build", () => {
		const cloud = readConfig("true");
		for (const name of PACKAGES) assert.equal(cloud.alias[name], "./lib/cloud-build/unavailable-storage.js", name);
		assert.deepEqual(cloud.env, { FLOCKSTACK_CLOUD_BUILD: "true" });
		for (const flag of [undefined, "false", ""]) {
			const plain = readConfig(flag);
			for (const name of PACKAGES) assert.equal(plain.alias[name], undefined, `${name} with ${JSON.stringify(flag)}`);
			assert.deepEqual(plain.env, {});
		}
	});

	test("deploy-all builds as the Cloud build unless told otherwise", () => {
		assert.equal(getBuildEnv({ PATH: "/bin" }).FLOCKSTACK_CLOUD_BUILD, "true");
		assert.equal(getBuildEnv({ FLOCKSTACK_CLOUD_BUILD: "false" }).FLOCKSTACK_CLOUD_BUILD, "false");
		assert.equal(getBuildEnv({ PATH: "/bin" }).PATH, "/bin");
	});

	test("the API Worker build takes the same three packages out, and the plain build keeps them", async () => {
		assert.deepEqual(Object.keys(CLOUD_BUILD_ALIASES).sort(), [...PACKAGES].sort());
		assert.equal(isCloudBuild({ FLOCKSTACK_CLOUD_BUILD: "true" }), true);
		assert.equal(isCloudBuild({}), false);
		const folder = mkdtempSync(join(tmpdir(), "cloud-build-"));
		const original = process.env.FLOCKSTACK_CLOUD_BUILD;
		try {
			delete process.env.FLOCKSTACK_CLOUD_BUILD;
			const plain = await buildApiWorker({ outFile: join(folder, "plain.js") });
			process.env.FLOCKSTACK_CLOUD_BUILD = "true";
			const cloud = await buildApiWorker({ outFile: join(folder, "cloud.js") });
			assert.ok(plain.bytes - cloud.bytes > 800_000, `the Cloud build is ${plain.bytes - cloud.bytes} bytes smaller`);
			const text = readFileSync(join(folder, "cloud.js"), "utf8");
			assert.match(text, /no S3, CloudFront or Vercel Blob client/);
			assert.doesNotMatch(readFileSync(join(folder, "plain.js"), "utf8"), /no S3, CloudFront or Vercel Blob client/);
			assert.ok(statSync(join(folder, "cloud.js")).size < statSync(join(folder, "plain.js")).size);
		} finally {
			if (original === undefined) delete process.env.FLOCKSTACK_CLOUD_BUILD;
			else process.env.FLOCKSTACK_CLOUD_BUILD = original;
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("a Cloud build refuses a storage it has no client for before it reaches the stub", () => {
	const S3 = { IMAGES_S3_BUCKET: "bucket", IMAGES_S3_ACCESS_KEY_ID: "id", IMAGES_S3_SECRET_ACCESS_KEY: "secret", IMAGES_CDN_URL: "https://cdn.example.com" };
	const R2 = { IMAGES_STORAGE: "r2", IMAGES_CDN_URL: "https://images.example.com" };

	test("S3 and Vercel Blob are a configuration problem; R2 is not", () => {
		const cloud = { isCloudBuild: true };
		assert.match(getImageStorageProblem(S3, cloud), /stores images in R2 only: set IMAGES_STORAGE=r2/);
		assert.match(getImageStorageProblem({ BLOB_READ_WRITE_TOKEN: "token" }, cloud), /stores images in R2 only/);
		assert.equal(getImageStorageProblem(R2, cloud), null);
		assert.match(getImageStorageProblem({}, cloud), /Image uploads need an R2 bucket/, "and no storage at all says what is needed, as before");
	});

	test("the other builds are unchanged", () => {
		assert.equal(getImageStorageProblem(S3, { isCloudBuild: false }), null);
		assert.equal(getImageStorageProblem({ BLOB_READ_WRITE_TOKEN: "token" }, { isCloudBuild: false }), null);
		assert.equal(getImageStorageProblem(S3), null, "the build the tests run in has the real clients");
	});
});
