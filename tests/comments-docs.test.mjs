import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { anonymous, startTestApp } from "./helpers/app.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		docs: await import("../lib/docs/llms.js"),
		page: await import("../app/(site)/docs/comments/page.js"),
		robots: (await import("../app/robots.js")).default,
		reference: await import("../lib/docs/reference.js"),
	};
});

after(() => app?.stop());

const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the comments docs", () => {
	test("are a docs page for people, agents and search engines, and say what matters", async () => {
		const entry = m.docs.DOC_PAGES.find(({ href }) => href === "/docs/comments");
		assert.equal(entry.title, "Comments");
		assert.equal(m.docs.getDocsPageMetadata("/docs/comments").alternates.canonical, "/docs/comments");
		assert.match(m.docs.getLlmsIndex("https://flockstack.io"), /\[Comments\]\(https:\/\/flockstack\.io\/docs\/comments\)/);

		const text = textOf(renderToStaticMarkup(createElement(TooltipProvider, null, await anonymous(async () => m.page.default()))));
		for (const phrase of [
			"no account and no password",
			"other readers never see their email",
			"{{comment_link}}",
			"the same for every address",
			"A reason is required",
			"The author always sees the reason",
			"Deleted reader",
			"set_comment_settings",
			"15 minutes",
			"at most three a day",
		]) {
			assert.ok(text.includes(phrase), phrase);
		}
		assert.doesNotMatch(text, /cheap/i);
	});

	test("the API reference has a Comments group with all eight public actions", () => {
		assert.ok(m.reference.GROUP_DESCRIPTIONS.Comments);
		const names = m.reference.getEndpointGroups("https://flockstack.io").find(({ group }) => group === "Comments");
		assert.equal(names.endpoints.length, 8);
	});

	test("robots.txt keeps crawlers off the dashboard page and the reader's links", () => {
		const { rules } = m.robots();
		assert.ok(rules.disallow.includes("/comments"));
		assert.ok(rules.disallow.includes("/reader/"));
	});

	test("the README and the port plan describe them", async () => {
		const readme = await readFile(join(ROOT, "README.md"), "utf8");
		assert.match(readme, /\*\*Comments from your subscribers\*\*/);
		assert.match(readme, /^### Comments$/m);
		assert.match(readme, /0008_community\.sql/);
		const plan = await readFile(join(ROOT, "PORT-PLAN.md"), "utf8");
		assert.match(plan, /^## Comments and community/m);
	});
});
