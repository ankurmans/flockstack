import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip.jsx";
import { anonymous, startTestApp } from "./helpers/app.mjs";

// The Briefings guide, "Run a newsletter with an agent" (/docs/briefings): a docs page for people, agents and search engines, listed
// like the others, and saying what the briefing rules say.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		docs: await import("../lib/docs/llms.js"),
		guide: await import("../lib/docs/briefings-guide.js"),
		page: await import("../app/(site)/docs/briefings/page.js"),
		sitemap: (await import("../app/sitemap.js")).default,
		rules: await import("../lib/briefing-rules.js"),
		rank: await import("../lib/briefings/rank.js"),
		languages: await import("../lib/reader-language-copy.js"),
		registry: await import("../lib/actions/registry.js"),
		NavDocs: (await import("../components/NavDocs.jsx")).default,
	};
});

after(() => app?.stop());

const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the Briefings guide", () => {
	test("is listed in the docs nav, the sitemap, llms.txt and llms-full.txt", async () => {
		const entry = m.docs.DOC_PAGES.find(({ href }) => href === "/docs/briefings");
		assert.equal(entry.title, "Briefings: run a newsletter with an agent");
		assert.equal(m.docs.getDocsPageMetadata("/docs/briefings").alternates.canonical, "/docs/briefings");
		assert.match(m.docs.getLlmsIndex("https://flockstack.io"), /- \[Briefings: run a newsletter with an agent\]\(https:\/\/flockstack\.io\/docs\/briefings\): /);
		const full = m.docs.getLlmsFull("https://flockstack.io");
		assert.ok(full.includes("## Briefings: run a newsletter with an agent"));
		assert.ok(full.includes(m.guide.getBriefingsGuideMarkdown()), "the whole guide is in llms-full.txt");
		assert.ok(m.sitemap().some(({ url }) => url.endsWith("/docs/briefings")));
		const nav = renderToStaticMarkup(createElement(m.NavDocs, { pages: m.docs.DOC_PAGES, groups: [] }));
		assert.match(nav, /href="\/docs\/briefings"[^>]*>Briefings: run a newsletter with an agent</);
	});

	test("says what a person or an agent needs to run a briefing", async () => {
		const markup = renderToStaticMarkup(createElement(TooltipProvider, null, await anonymous(async () => m.page.default())));
		const text = textOf(markup);
		for (const phrase of [
			"Run a newsletter with an agent",
			"There is no list of sources to keep up",
			"Each issue waits as a draft until you",
			"topic", "audience", "useful", "examples",
			"Trusted outlets", "Blocked hosts", "whatever their robots.txt allows",
			"AI keys", "never shown again", "under the key holder's own TinyFish account and terms",
			"a different model from the write step",
			"maxItems", "budgetShare", "priority", "left out of the issue, heading included",
			"Lead, Market pulse, Earnings and filings, Headline roundup, Deal flow, Regulation and rates, People moves, Product and tech launches, Coming up",
			"from the last 30 hours", "from the last 72 hours on a Monday",
			"Europe/Paris", "3 manual runs per briefing per local day",
			"$0.25 by default", "stopped_at_budget",
			"keep and a drop link", "works once, for 14 days", "from 30 verdicts on",
			"Every number in the draft is on a page it cites", "No quote is over 25 words", "heldReason",
			"English, Spanish, French, German, Italian and Portuguese", "beta",
			"recorded per run on the run page", "an estimate from the prompts, not a measurement",
			"get_agent_brief", "needsOwner", "apply_editorial_pattern",
			"Sending by itself", "set_briefing_auto_send", "daily_cap", "a pause link", "no blocker and no warning", "only you can turn it on",
		]) {
			assert.ok(text.includes(phrase), phrase);
		}
		assert.match(markup, /<a href="\/ai-keys"[^>]*>AI keys<\/a>/);
		assert.match(markup, /<a href="\/docs\/briefings-bot"/);
		assert.doesNotMatch(text, /cheap/i);
		assert.doesNotMatch(text, /made with ai|ai-generated|written by ai/i);
	});

	test("names every Briefings action, and its numbers are the rules'", () => {
		const markdown = m.guide.getBriefingsGuideMarkdown();
		const names = m.registry.ACTIONS.filter(({ group }) => group === "Briefings").map(({ name }) => name);
		assert.ok(names.length >= 15);
		for (const name of names) assert.ok(markdown.includes(`\`${name}\``), name);
		assert.equal(m.rules.DEFAULT_DISCOVERY.lookbackHours, 30);
		assert.equal(m.rules.DEFAULT_DISCOVERY.mondayLookbackHours, 72);
		assert.equal(m.rank.MIN_VERDICTS, 30, "the guide says the ranker learns from 30 verdicts on");
		assert.deepEqual(m.languages.READER_LANGUAGES, ["en", "es", "fr", "de", "it", "pt"], "the guide lists these languages by name");
		assert.ok(markdown.includes(m.rules.MANUAL_RUNS_PER_DAY + " manual runs"));
	});
});
