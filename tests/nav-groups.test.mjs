import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: NavLinks, getGroups } = await import("../components/NavLinks.jsx");

describe("the dashboard's sidebar", () => {
	test("groups its pages by the job being done, each page once", () => {
		const groups = getGroups({ hasAudio: true });
		assert.deepEqual(groups.map(({ id }) => id), ["home", "write", "audience", "site", "sell", "settings"]);
		assert.equal(groups[0].label, null, "Overview and Reports sit above the labels");
		assert.equal(groups.at(-1).label, null, "Settings stands alone at the end");
		const hrefs = groups.flatMap(({ items }) => items.map(({ href }) => href));
		assert.equal(new Set(hrefs).size, hrefs.length);
		assert.ok(hrefs.includes("/audio"));
		assert.ok(!getGroups({ hasAudio: false }).flatMap(({ items }) => items).some(({ href }) => href === "/audio"));
		for (const href of ["/media", "/domains", "/api-keys", "/webhooks", "/admin", "/billing", "/account"]) assert.ok(!hrefs.includes(href), `${href} is in the user menu, not the sidebar`);
	});

	test("puts selling, writing and the audience where a writer looks for them", () => {
		const where = Object.fromEntries(getGroups({ hasAudio: true }).flatMap(({ id, items }) => items.map(({ href }) => [href, id])));
		for (const href of ["/campaigns", "/series", "/automations", "/templates", "/audio"]) assert.equal(where[href], "write", href);
		for (const href of ["/contacts", "/segments", "/forms", "/surveys", "/referrals", "/recommending"]) assert.equal(where[href], "audience", href);
		for (const href of ["/products", "/orders", "/payments"]) assert.equal(where[href], "sell", href);
		assert.equal(where["/newsletters"], "settings");
	});

	test("renders Write and Audience open and the less used groups folded, each with a labelled heading, before any choice is stored", () => {
		const html = renderToStaticMarkup(createElement(NavLinks, { hasAudio: false }));
		for (const label of ["Write", "Audience"]) assert.match(html, new RegExp(`aria-expanded="true"[^>]*>${label}`), label);
		for (const label of ["Your site", "Sell"]) assert.match(html, new RegExp(`aria-expanded="false"[^>]*>${label}`), label);
		assert.equal((html.match(/\bhidden=""/g) ?? []).length, 2, "two groups are folded on the server");
		assert.match(html, /aria-label="Dashboard"/);
	});
});
