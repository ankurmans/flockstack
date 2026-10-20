import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startTestApp } from "./helpers/app.mjs";
import { SHARED_DOMAIN, createPublisher, importModels } from "./helpers/community.mjs";

// The share images: the docs' card and each newsletter's. A Cloudflare Worker has no files to
// read at run time, so their fonts come from a module (lib/og-fonts.js, written by scripts/make-og-fonts.mjs).
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ROUTES = ["app/(site)/opengraph-image.js", "app/archive/[slug]/og/route.js"];

let app;
let m;

// A PNG's width and height, from its IHDR chunk.
async function pngSize(response) {
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "image/png");
	const bytes = Buffer.from(await response.arrayBuffer());
	assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

before(async () => {
	app = await startTestApp({ SHARED_DOMAIN });
	m = {
		...(await importModels()),
		fonts: await import("../lib/og-fonts.js"),
		docsImage: await import("../app/(site)/opengraph-image.js"),
		archiveImage: await import("../app/archive/[slug]/og/route.js"),
	};
});

after(() => app?.stop());

describe("share images", () => {
	test("read no files at run time", async () => {
		for (const file of ROUTES) assert.doesNotMatch(await readFile(join(ROOT, file), "utf8"), /node:fs|readFile|process\.cwd/, file);
	});

	test("carry the fonts in assets/fonts, byte for byte", async () => {
		assert.deepEqual(Buffer.from(m.fonts.GEIST_REGULAR, "base64"), await readFile(join(ROOT, "assets/fonts/Geist-Regular.ttf")), "run node scripts/make-og-fonts.mjs");
		assert.deepEqual(Buffer.from(m.fonts.GEIST_SEMIBOLD, "base64"), await readFile(join(ROOT, "assets/fonts/Geist-SemiBold.ttf")), "run node scripts/make-og-fonts.mjs");
	});

	test("the docs' card renders at 1200 by 630, on request, so it prints the Worker's own address", async () => {
		const image = m.docsImage;
		assert.equal(image.dynamic, "force-dynamic");
		assert.deepEqual(image.size, { width: 1200, height: 630 });
		assert.equal(image.contentType, "image/png");
		assert.deepEqual(await pngSize(await image.default()), { width: 1200, height: 630 });
	});

	test("a newsletter's card renders for its home and for an issue", async () => {
		const user = await createPublisher(m, "share-images@example.com");
		const get = (query = "") => m.archiveImage.GET(new Request(`http://localhost:3000/archive/${user.slug}/og${query}`), { params: Promise.resolve({ slug: user.slug }) });
		assert.deepEqual(await pngSize(await get()), { width: 1200, height: 630 });
		assert.deepEqual(await pngSize(await get(`?p=${user.issue.archiveSlug}`)), { width: 1200, height: 630 });
		assert.equal((await get("?p=no-such-issue")).status, 404);
	});
});
