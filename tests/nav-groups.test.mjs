import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { default: NavLinks, getGroups } = await import("../components/NavLinks.jsx");

describe("the dashboard's sidebar", () => {
	test("groups its pages by the job being done, each page once", () => {
		const groups = getGroups({ isAdmin: true, hasAudio: true });
		assert.deepEqual(groups.map(({ id }) => id), ["home", "write", "audience", "site", "sell", "manage"]);
		assert.equal(groups[0].label, null, "Overview and Reports sit above the labels");
		const hrefs = groups.flatMap(({ items }) => items.map(({ href }) => href));
		assert.equal(new Set(hrefs).size, hrefs.length);
		assert.ok(hrefs.includes("/admin") && hrefs.includes("/audio"));
		assert.ok(!getGroups({ isAdmin: false, hasAudio: false }).flatMap(({ items }) => items).some(({ href }) => href === "/admin" || href === "/audio"));
	});

	test("puts selling, writing and the audience where a writer looks for them", () => {
		const where = Object.fromEntries(getGroups({ hasAudio: true }).flatMap(({ id, items }) => items.map(({ href }) => [href, id])));
		for (const href of ["/campaigns", "/series", "/automations", "/templates", "/audio"]) assert.equal(where[href], "write", href);
		for (const href of ["/contacts", "/segments", "/forms", "/surveys", "/referrals", "/recommending"]) assert.equal(where[href], "audience", href);
		for (const href of ["/products", "/orders", "/payments"]) assert.equal(where[href], "sell", href);
		assert.equal(where["/newsletters"], "manage");
	});

	test("renders every group open with a labelled, collapsible heading, before any choice is stored", () => {
		const html = renderToStaticMarkup(createElement(NavLinks, { isAdmin: false, hasAudio: false }));
		for (const label of ["Write", "Audience", "Your site", "Sell", "Manage"]) assert.match(html, new RegExp(`aria-expanded="true"[^>]*>${label}`), label);
		assert.doesNotMatch(html, /\bhidden=""/, "nothing is folded on the server");
		assert.match(html, /aria-label="Dashboard"/);
	});
});
