import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, startTestApp } from "./helpers/app.mjs";
import {
	CROP_RATIOS,
	EMAIL_WIDTH,
	MAX_CROP_WIDTH,
	MIN_CROP_SIDE,
	RESIZE_PRESETS,
	canCropImage,
	changeCropRatio,
	dragCropCorner,
	getActivePreset,
	getCropOutput,
	getInitialCrop,
	getResizedSize,
	moveCrop,
} from "../lib/image-edit.js";

// Crop and resize in the editor (parity item W16): the sizes and rectangles the tools work out, and the route that lets the crop
// read one of the account's own pictures.
const SIZE = { width: 1600, height: 900 };
const inside = (rect, size = SIZE) => rect.x >= -1e-6 && rect.y >= -1e-6 && rect.x + rect.width <= size.width + 1e-6 && rect.y + rect.height <= size.height + 1e-6;

describe("resizing", () => {
	test("sets the width from a preset and keeps the picture's shape", () => {
		assert.deepEqual(RESIZE_PRESETS.map(({ width }) => width), [240, 360, 480, EMAIL_WIDTH]);
		assert.deepEqual(getResizedSize(360, { natural: { width: 1600, height: 900 } }), { width: 360, height: 203 });
		assert.deepEqual(getResizedSize(240, { current: { width: 600, height: 300 } }), { width: 240, height: 120 });
		assert.deepEqual(getResizedSize(480, { current: { width: 100, height: 100 }, natural: { width: 800, height: 200 } }), { width: 480, height: 120 }, "the file's own shape wins");
	});

	test("never goes wider than the email or narrower than a thumbnail, and copes with no shape", () => {
		assert.equal(getResizedSize(5000, { natural: SIZE }).width, EMAIL_WIDTH);
		assert.equal(getResizedSize(10, { natural: SIZE }).width, 80);
		assert.deepEqual(getResizedSize(300), { width: 300 });
		assert.deepEqual(getResizedSize("nope", { current: { width: 0, height: 0 } }), { width: EMAIL_WIDTH });
	});

	test("marks the preset whose width the picture has", () => {
		assert.equal(getActivePreset(360), "medium");
		assert.equal(getActivePreset("600"), "full");
		assert.equal(getActivePreset(361), null);
		assert.equal(getActivePreset(undefined), null);
	});
});

describe("the crop rectangle", () => {
	test("starts as the whole picture, or the biggest centered box of a shape", () => {
		assert.deepEqual(getInitialCrop(SIZE), { x: 0, y: 0, width: 1600, height: 900 });
		assert.deepEqual(getInitialCrop(SIZE, 1), { x: 350, y: 0, width: 900, height: 900 });
		const wide = getInitialCrop({ width: 400, height: 1000 }, 16 / 9);
		assert.equal(wide.width, 400);
		assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 1e-9 && inside(wide, { width: 400, height: 1000 }));
		for (const { ratio } of CROP_RATIOS.filter((choice) => choice.ratio)) {
			const rect = getInitialCrop(SIZE, ratio);
			assert.ok(Math.abs(rect.width / rect.height - ratio) < 1e-9 && inside(rect), String(ratio));
		}
	});

	test("moves inside the picture and no further", () => {
		const rect = { x: 100, y: 100, width: 400, height: 300 };
		assert.deepEqual(moveCrop(rect, 50, -20, SIZE), { x: 150, y: 80, width: 400, height: 300 });
		assert.deepEqual(moveCrop(rect, -500, -500, SIZE), { x: 0, y: 0, width: 400, height: 300 });
		assert.deepEqual(moveCrop(rect, 5000, 5000, SIZE), { x: 1200, y: 600, width: 400, height: 300 });
	});

	test("resizes from a corner while the opposite one stays, free or in a shape, inside the picture", () => {
		const rect = { x: 400, y: 200, width: 400, height: 300 };
		const free = dragCropCorner(rect, "se", { x: 1000, y: 600 }, SIZE);
		assert.deepEqual(free, { x: 400, y: 200, width: 600, height: 400 });
		const topLeft = dragCropCorner(rect, "nw", { x: 300, y: 100 }, SIZE);
		assert.deepEqual(topLeft, { x: 300, y: 100, width: 500, height: 400 }, "the bottom right corner stays at 800, 500");
		const square = dragCropCorner(rect, "se", { x: 1000, y: 500 }, SIZE, 1);
		assert.ok(Math.abs(square.width - square.height) < 1e-9 && square.x === 400 && square.y === 200, JSON.stringify(square));
		for (const corner of ["nw", "ne", "sw", "se"]) {
			for (const point of [{ x: -999, y: -999 }, { x: 9999, y: 9999 }, { x: 800, y: 500 }, { x: 0, y: 900 }]) {
				for (const ratio of [null, 1, 16 / 9]) {
					const result = dragCropCorner(rect, corner, point, SIZE, ratio);
					assert.ok(inside(result), `${corner} ${JSON.stringify(point)} ${ratio}: ${JSON.stringify(result)}`);
					assert.ok(result.width >= MIN_CROP_SIDE - 1e-6 && result.height >= MIN_CROP_SIDE - 1e-6, `${corner} ${JSON.stringify(point)} ${ratio}: ${JSON.stringify(result)}`);
					if (ratio) assert.ok(Math.abs(result.width / result.height - ratio) < 1e-6);
				}
			}
		}
	});

	test("keeps its center when the shape changes", () => {
		const rect = { x: 400, y: 200, width: 800, height: 400 };
		const square = changeCropRatio(rect, 1, SIZE);
		assert.deepEqual(square, { x: 600, y: 200, width: 400, height: 400 });
		assert.deepEqual(changeCropRatio(rect, null, SIZE), rect, "free leaves it");
		assert.ok(inside(changeCropRatio({ x: 0, y: 0, width: 1600, height: 900 }, 1, SIZE)));
	});

	test("draws whole pixels of the picture, scaled down when wider than an upload", () => {
		assert.deepEqual(getCropOutput({ x: 10.4, y: 20.6, width: 800.2, height: 400.7 }, SIZE), { sx: 10, sy: 21, sw: 800, sh: 401, width: 800, height: 401 });
		const big = getCropOutput({ x: 0, y: 0, width: 1600, height: 900 }, SIZE);
		assert.deepEqual([big.width, big.height], [MAX_CROP_WIDTH, 675]);
		const edge = getCropOutput({ x: 1599, y: 899, width: 50, height: 50 }, SIZE);
		assert.deepEqual([edge.sx + edge.sw, edge.sy + edge.sh], [1600, 900], "never past the picture");
	});

	test("a GIF is not cropped, anything else is", () => {
		assert.equal(canCropImage("https://cdn.example.com/a.gif"), false);
		assert.equal(canCropImage("https://cdn.example.com/a.GIF?v=2"), false);
		assert.equal(canCropImage("https://cdn.example.com/a.png", "image/gif"), false);
		assert.equal(canCropImage("https://cdn.example.com/a.png"), true);
		assert.equal(canCropImage("https://cdn.example.com/agif.jpg"), true);
	});
});

describe("reading a picture for the crop", () => {
	let app;
	let m;
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

	before(async () => {
		app = await startTestApp();
		m = {
			route: await import("../app/api/uploads/source/route.js"),
			uploads: await import("../app/api/uploads/route.js"),
		};
	});
	after(() => app?.stop());

	async function upload(user) {
		const response = await as(user, () => m.uploads.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { "content-type": "image/png", "x-file-name": "photo" }, body: PNG })));
		assert.equal(response.status, 200);
		return (await response.json()).url;
	}

	function read(user, url, headers = {}) {
		return as(user, () => m.route.GET(new Request(`http://localhost:3000/api/uploads/source?url=${encodeURIComponent(url)}`, { headers })));
	}

	// The image host answers with the picture; any other address is a request the test did not expect.
	async function withHost(answer, run) {
		const original = globalThis.fetch;
		const asked = [];
		globalThis.fetch = async (input) => {
			asked.push(String(input?.url ?? input));
			return answer(String(input?.url ?? input));
		};
		try {
			return await run(asked);
		} finally {
			globalThis.fetch = original;
		}
	}

	test("gives back the bytes of a picture the account uploaded, and asks only for that address", async () => {
		const { signIn, activate } = await import("./helpers/app.mjs");
		const user = await signIn("crop-own@example.com");
		await activate(user);
		const url = await upload(user);
		await withHost(() => new Response(PNG, { headers: { "content-type": "application/octet-stream" } }), async (asked) => {
			const response = await read(user, url);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), "image/png", "the type comes from the bytes");
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
			assert.deepEqual(asked, [url]);
		});
	});

	test("refuses an address the account didn't upload, even another account's picture, and never fetches it", async () => {
		const { signIn, activate } = await import("./helpers/app.mjs");
		const user = await signIn("crop-a@example.com");
		const other = await signIn("crop-b@example.com");
		await activate(user);
		await activate(other);
		const theirs = await upload(other);
		await withHost(() => assert.fail("nothing is fetched"), async (asked) => {
			for (const url of [theirs, "https://evil.example.com/steal.png", "http://169.254.169.254/latest/meta-data", ""]) {
				const response = await read(user, url);
				assert.equal(response.status, 404, url);
				assert.equal((await response.json()).code, "not_found");
			}
			assert.deepEqual(asked, []);
		});
	});

	test("needs a signed-in dashboard page: no session, or a request from another site, gets nothing", async () => {
		const { signIn, activate, anonymous } = await import("./helpers/app.mjs");
		const user = await signIn("crop-auth@example.com");
		await activate(user);
		const url = await upload(user);
		await withHost(() => assert.fail("nothing is fetched"), async () => {
			const anonymousResponse = await anonymous(() => m.route.GET(new Request(`http://localhost:3000/api/uploads/source?url=${encodeURIComponent(url)}`)));
			assert.equal(anonymousResponse.status, 401);
			assert.equal((await read(user, url, { "sec-fetch-site": "cross-site" })).status, 403);
		});
	});

	test("answers an image host that fails, and bytes that aren't a picture", async () => {
		const { signIn, activate } = await import("./helpers/app.mjs");
		const user = await signIn("crop-bad@example.com");
		await activate(user);
		const url = await upload(user);
		await withHost(() => new Response("gone", { status: 404 }), async () => assert.equal((await read(user, url)).status, 503));
		await withHost(() => new Response("<html>not an image</html>"), async () => assert.equal((await read(user, url)).status, 400));
		await withHost(() => {
			throw new Error("network down");
		}, async () => assert.equal((await read(user, url)).status, 503));
	});

	test("is a dashboard-only action: no API route, no tool", async () => {
		const registry = await import("../lib/actions/registry.js");
		assert.ok(registry.DASHBOARD_ONLY_ACTIONS.some(({ name }) => name === "read_image_source"));
		assert.ok(!registry.ACTIONS.some(({ name }) => name === "read_image_source"));
	});
});
