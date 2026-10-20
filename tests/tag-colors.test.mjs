import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { TAG_COLORS, getTagPillClasses, getTagSwatchClasses, isTagColor } from "../lib/tag-colors.js";

// Tag colors: set through the API and the dashboard, listed with each tag, and drawn on the contacts page.
let t;
let n = 0;

before(async () => {
	t = await setupAudienceTests();
});

after(() => t?.app.stop());

const customer = () => t.customer(`tagcolors${++n}@example.com`);

async function withTags(user, tags) {
	await t.importReaders(user, 1, { tags: () => tags });
}

describe("the colors", () => {
	test("are nine, each with classes written out whole and a swatch, and gray for none", () => {
		assert.equal(TAG_COLORS.length, 9);
		for (const color of TAG_COLORS) {
			assert.ok(isTagColor(color));
			assert.match(getTagPillClasses(color), new RegExp(`bg-\\w+-500/\\d+ text-\\w+-\\d+ dark:text-\\w+-\\d+`), color);
			assert.match(getTagSwatchClasses(color), /^bg-\w+-500$/, color);
		}
		assert.equal(getTagPillClasses(null), "bg-muted text-muted-foreground");
		assert.equal(getTagPillClasses("chartreuse"), "bg-muted text-muted-foreground");
		assert.equal(isTagColor("chartreuse"), false);
	});
});

describe("set_tag_color", () => {
	test("colors a tag, lists it with its color and goes back to none", async () => {
		const user = await customer();
		await withTags(user, ["vip", "beta"]);
		assert.deepEqual((await t.api(user.key, "GET", "/tags")).body.tags.map(({ name, color }) => [name, color]), [["beta", null], ["vip", null]]);

		const set = await t.api(user.key, "PATCH", "/tags", { tag: "  VIP ", color: "violet" });
		assert.deepEqual(set.body, { tag: "vip", color: "violet" }, JSON.stringify(set.body));
		assert.deepEqual((await t.api(user.key, "GET", "/tags")).body.tags.map(({ name, color }) => [name, color]), [["beta", null], ["vip", "violet"]]);

		assert.deepEqual((await t.api(user.key, "PATCH", "/tags", { tag: "vip", color: null })).body, { tag: "vip", color: null });
		assert.equal((await t.api(user.key, "GET", "/tags")).body.tags.find(({ name }) => name === "vip").color, null);
	});

	test("refuses a color it doesn't have, a tag that isn't there and another account's tag", async () => {
		const user = await customer();
		const other = await customer();
		await withTags(user, ["vip"]);
		await withTags(other, ["theirs"]);
		t.assertError(await t.api(user.key, "PATCH", "/tags", { tag: "vip", color: "chartreuse" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "PATCH", "/tags", { tag: "vip" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "PATCH", "/tags", { tag: "nothing", color: "red" }), 404, "not_found");
		t.assertError(await t.api(user.key, "PATCH", "/tags", { tag: "theirs", color: "red" }), 404, "not_found");
		assert.equal((await t.api(other.key, "GET", "/tags")).body.tags[0].color, null, "the other account's tag is untouched");
	});

	test("keeps the color when the tag is added to more contacts and drops it with the tag", async () => {
		const user = await customer();
		await withTags(user, ["vip"]);
		await t.api(user.key, "PATCH", "/tags", { tag: "vip", color: "red" });
		const [contact] = (await t.api(user.key, "GET", "/contacts")).body.contacts;
		await t.api(user.key, "POST", `/contacts/${contact.id}/tags`, { tag: "vip" });
		assert.equal((await t.api(user.key, "GET", "/tags")).body.tags[0].color, "red");
		await t.api(user.key, "DELETE", "/tags?tag=vip");
		await withTags(user, ["vip"]);
		assert.equal((await t.api(user.key, "GET", "/tags")).body.tags[0].color, null, "a tag made again starts plain");
	});
});

describe("the contacts page", () => {
	test("draws a tag in its color, and the dashboard action sets one", async () => {
		const user = await customer();
		await withTags(user, ["vip", "beta"]);
		const page = (await import("../app/(app)/contacts/page.js")).default;
		const actions = await import("../app/(app)/contacts/actions.js");
		const html = async () => renderToStaticMarkup(await as(user, async () => page({ searchParams: Promise.resolve({}) })));

		assert.match(await html(), /bg-muted text-muted-foreground[^>]*>(vip|beta)</, "plain at first");
		assert.deepEqual(await as(user, () => actions.setTagColor(user.newsletterId, "vip", "violet")), { ok: true });
		const colored = await html();
		assert.match(colored, new RegExp(`${getTagPillClasses("violet").replace(/[/]/g, "\\/")}[^>]*>vip<`));
		assert.match(colored, /bg-muted text-muted-foreground[^>]*>beta</, "the other tag is still plain");
		assert.match((await as(user, () => actions.setTagColor(user.newsletterId, "vip", "chartreuse"))).error, /color/i);
		assert.deepEqual(await as(user, () => actions.setTagColor(user.newsletterId, "vip", "")), { ok: true });
	});
});
