import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setupAudienceTests } from "./helpers/audience.mjs";

// The media library: folders on uploads, search by name, moving, renaming, and the page that shows them.
let t;
let m;
let n = 0;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
const PDF = Buffer.from("%PDF-1.4\n%test\n").toString("base64");

before(async () => {
	t = await setupAudienceTests();
	m = {
		rules: await import("../lib/media-rules.js"),
		Upload: (await import("../models/Upload.js")).default,
	};
});

after(() => t?.app.stop());

const customer = () => t.customer(`media${++n}@example.com`);
const image = (user, fileName, folder) => t.api(user.key, "POST", "/images", { base64: PNG, fileName, ...(folder !== undefined && { folder }) });
const file = (user, fileName, folder) => t.api(user.key, "POST", "/files", { base64: PDF, fileName, ...(folder !== undefined && { folder }) });
const media = async (user, query = "") => (await t.api(user.key, "GET", `/media${query}`)).body.media;
const names = (items) => items.map(({ name }) => name).toSorted();

describe("folder names", () => {
	test("are one level of plain names, spaces collapsed", () => {
		const { normalizeFolder } = m.rules;
		assert.equal(normalizeFolder("  Cover   images "), "Cover images");
		assert.equal(normalizeFolder("2026 (drafts) & more"), "2026 (drafts) & more");
		assert.equal(normalizeFolder("Café"), "Café");
		assert.equal(normalizeFolder(""), "");
		assert.equal(normalizeFolder(null), "");
		for (const bad of ["a/b", "../x", "<b>", "-start", "a".repeat(61)]) assert.equal(normalizeFolder(bad), null, bad);
	});
});

describe("uploading and listing", () => {
	test("an upload goes into the folder it names, or none, and lists newest first with its kind and name", async () => {
		const user = await customer();
		const first = await image(user, "Spring cover.png", "Covers");
		assert.equal(first.status, 201, JSON.stringify(first.body));
		assert.equal(first.body.folder, "Covers");
		assert.equal((await image(user, "loose.png")).body.folder, null);
		const pdf = await file(user, "Press kit.pdf", "  Covers ");
		assert.equal(pdf.body.folder, "Covers", "spaces trimmed");

		const all = await media(user);
		assert.equal(all.length, 3);
		assert.deepEqual(all.map(({ kind }) => kind), ["file", "image", "image"], "newest first");
		assert.equal(all[0].name, "Press kit.pdf");
		assert.equal(all[2].name, "spring-cover.png");
		t.assertError(await image(user, "x.png", "a/b"), 400, "validation_failed");
		assert.equal((await t.api(user.key, "GET", "/images")).body.images.length, 2, "list_images still lists images only");
	});

	test("filter by folder, by no folder, by kind and by a search of the name", async () => {
		const user = await customer();
		await image(user, "Spring cover.png", "Covers");
		await image(user, "Winter cover.png", "Covers");
		await image(user, "logo.png", "Brand");
		await image(user, "unfiled.png");
		await file(user, "Spring report.pdf", "Brand");

		assert.deepEqual(names(await media(user, "?folder=Covers")), ["spring-cover.png", "winter-cover.png"]);
		assert.deepEqual(names(await media(user, "?folder=")), ["unfiled.png"], "an empty folder is no folder");
		assert.deepEqual(names(await media(user, "?kind=file")), ["Spring report.pdf"]);
		assert.deepEqual(names(await media(user, "?kind=image&folder=Brand")), ["logo.png"]);
		assert.deepEqual(names(await media(user, "?search=SPRING")), ["Spring report.pdf", "spring-cover.png"], "ignoring case, over images and files");
		assert.deepEqual(names(await media(user, "?search=spring%20cover")), ["spring-cover.png"], "a name written with spaces finds its slug");
		assert.deepEqual(await media(user, "?search=images"), [], "the folder in the stored path isn't a name");
		assert.deepEqual(names(await media(user, "?search=report&folder=Brand")), ["Spring report.pdf"]);
		assert.deepEqual(await media(user, "?search=nothing"), []);
	});

	test("find an older upload by the name in its path when it has none, and page with a cursor", async () => {
		const user = await customer();
		for (const name of ["a", "b", "c"]) await image(user, `${name}.png`);
		await m.Upload.create({ accountId: user.accountId, url: "https://cdn.example.com/old.png", pathname: `accounts/${user.accountId}/images/old-banner.png`, contentType: "image/png", bytes: 12, createdAt: new Date(0) });
		assert.deepEqual(names(await media(user, "?search=banner")), ["old-banner.png"]);

		const first = (await t.api(user.key, "GET", "/media?limit=2")).body;
		assert.equal(first.media.length, 2);
		assert.ok(first.nextCursor);
		const second = (await t.api(user.key, "GET", `/media?limit=2&cursor=${first.nextCursor}`)).body;
		assert.equal(second.media.length, 2);
		assert.equal(second.nextCursor, null);
		assert.deepEqual(names([...first.media, ...second.media]), ["a.png", "b.png", "c.png", "old-banner.png"]);
	});
});

describe("folders", () => {
	test("exist while an upload is in them, counted, with the unfiled ones", async () => {
		const user = await customer();
		const first = (await image(user, "one.png", "Zebra")).body;
		await image(user, "two.png", "Alpha");
		await image(user, "three.png", "Alpha");
		await image(user, "four.png");
		assert.deepEqual((await t.api(user.key, "GET", "/media/folders")).body, { folders: [{ name: "Alpha", count: 2 }, { name: "Zebra", count: 1 }], unfiled: 1 });

		const moved = await t.api(user.key, "POST", "/media/move", { ids: [first.id], folder: "" });
		assert.deepEqual(moved.body, { moved: 1, folder: null });
		assert.deepEqual((await t.api(user.key, "GET", "/media/folders")).body, { folders: [{ name: "Alpha", count: 2 }], unfiled: 2 }, "an emptied folder is gone");
	});

	test("move uploads in and out without touching their links, only the account's own", async () => {
		const user = await customer();
		const other = await customer();
		const a = (await image(user, "a.png")).body;
		const b = (await file(user, "b.pdf")).body;
		const theirs = (await image(other, "theirs.png")).body;

		const moved = await t.api(user.key, "POST", "/media/move", { ids: [a.id, b.id], folder: "  New   folder " });
		assert.deepEqual(moved.body, { moved: 2, folder: "New folder" });
		const after = await media(user, "?folder=New%20folder");
		assert.deepEqual(after.map(({ url }) => url).toSorted(), [a.url, b.url].toSorted(), "the URLs are what they were");

		t.assertError(await t.api(user.key, "POST", "/media/move", { ids: [a.id, theirs.id], folder: "X" }), 404, "not_found");
		assert.equal((await media(other))[0].folder, null, "the other account's upload didn't move");
		t.assertError(await t.api(user.key, "POST", "/media/move", { ids: ["nope"], folder: "X" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/media/move", { ids: [a.id], folder: "a/b" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/media/move", { ids: [], folder: "X" }), 400, "validation_failed");
	});

	test("an account has up to 50 of them", async () => {
		const user = await customer();
		const upload = (await image(user, "x.png")).body;
		for (let index = 0; index < 50; index++) {
			await m.Upload.create({ accountId: user.accountId, url: `https://cdn.example.com/${index}.png`, pathname: `accounts/${user.accountId}/images/f${index}.png`, contentType: "image/png", bytes: 1, folder: `Folder ${index}` });
		}
		t.assertError(await t.api(user.key, "POST", "/media/move", { ids: [upload.id], folder: "One too many" }), 400, "validation_failed");
		assert.equal((await t.api(user.key, "POST", "/media/move", { ids: [upload.id], folder: "Folder 7" })).status, 200, "an existing one is fine");
	});

	test("rename, join another or empty", async () => {
		const user = await customer();
		await image(user, "a.png", "Old");
		await image(user, "b.png", "Other");
		const renamed = await t.api(user.key, "PATCH", "/media/folders", { folder: "Old", name: "New name" });
		assert.deepEqual(renamed.body, { moved: 1, folder: "New name" });
		await t.api(user.key, "PATCH", "/media/folders", { folder: "New name", name: "Other" });
		assert.deepEqual((await t.api(user.key, "GET", "/media/folders")).body.folders, [{ name: "Other", count: 2 }], "joined");
		assert.deepEqual((await t.api(user.key, "PATCH", "/media/folders", { folder: "Other", name: "" })).body, { moved: 2, folder: null });
		t.assertError(await t.api(user.key, "PATCH", "/media/folders", { folder: "Missing", name: "X" }), 404, "not_found");
	});
});

describe("the page", () => {
	test("lists the uploads with their folders, filters by ?folder and ?q, and the dashboard action moves them", async () => {
		const user = await customer();
		await image(user, "Spring cover.png", "Covers");
		await image(user, "logo.png", "Brand");
		const { as } = await import("./helpers/app.mjs");
		const page = (await import("../app/(app)/media/page.js")).default;
		const actions = await import("../app/(app)/media/actions.js");
		const text = async (searchParams) => renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve(searchParams) }))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

		const all = await text({});
		assert.match(all, /spring-cover\.png/);
		assert.match(all, /logo\.png/);
		assert.match(all, /Covers 1/);
		assert.match(all, /Brand 1/);
		const covers = await text({ folder: "Covers" });
		assert.match(covers, /spring-cover\.png/);
		assert.doesNotMatch(covers, /logo\.png/);
		assert.match(await text({ q: "logo" }), /logo\.png/);
		assert.match(await text({ q: "zzz" }), /Nothing named &quot;zzz&quot;/);

		const [logo] = await media(user, "?search=logo");
		const result = await as(user, () => actions.moveMedia([logo.id], "Covers"));
		assert.deepEqual(result, { ok: true, moved: 1 });
		assert.deepEqual(names(await media(user, "?folder=Covers")), ["logo.png", "spring-cover.png"]);
		assert.match((await as(user, () => actions.moveMedia([logo.id], "a/b"))).error, /Folder/i);
	});
});
