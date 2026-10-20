import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { cleanRichHtml } from "../lib/clean-html.js";
import { renderFootnotes, splitAtPaywall } from "../lib/editor-blocks.js";
import { parseEmbed } from "../lib/embeds.js";
import { renderEmail } from "../lib/render-email.js";
import { TEST_CONTACT_ID, buildRecipientEmail } from "../lib/sending-rules.js";
import { setupAudienceTests } from "./helpers/audience.mjs";

const POLL_ID = "6650f1c2e9b1d4a012345678";
const newsletter = { name: "Field notes", postalAddress: "1 Main St, Paris", accentColor: "#ff5500" };
const email = (html, options = {}) => renderEmail({ format: "rich", html, subject: "Issue", newsletter, ...options });
const body = (html) => html.slice(html.indexOf('class="body"'), html.lastIndexOf("You're receiving this"));

let t;
let archive;

before(async () => {
	t = await setupAudienceTests();
	archive = await import("../lib/archive-content.js");
});

after(() => t?.app.stop());

describe("embeds", () => {
	test("read only links to the services they know, and rebuild the link", () => {
		const cases = {
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x": ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
			"https://youtu.be/dQw4w9WgXcQ?t=4": ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
			"https://youtube.com/shorts/dQw4w9WgXcQ": ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
			"https://twitter.com/jack/status/20": ["x", "https://x.com/jack/status/20"],
			"https://www.instagram.com/p/C0abcDEFg12/": ["instagram", "https://www.instagram.com/p/C0abcDEFg12/"],
			"https://www.tiktok.com/@someone/video/7234567890123456789": ["tiktok", "https://www.tiktok.com/@someone/video/7234567890123456789"],
			"https://bsky.app/profile/someone.bsky.social/post/3kabcdefghi2x": ["bluesky", "https://bsky.app/profile/someone.bsky.social/post/3kabcdefghi2x"],
			"https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk": ["spotify", "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk"],
			"https://podcasts.apple.com/us/podcast/some-show/id1234567?i=1000600000000": ["apple_podcasts", "https://podcasts.apple.com/us/podcast/some-show/id1234567?i=1000600000000"],
		};
		for (const [input, [provider, url]] of Object.entries(cases)) {
			const embed = parseEmbed(input);
			assert.equal(embed?.provider, provider, input);
			assert.equal(embed.url, url, input);
		}
		for (const bad of [
			"javascript:alert(1)",
			"https://youtube.com.example.com/watch?v=dQw4w9WgXcQ",
			"https://www.youtube.com/watch?v=short",
			"https://example.com/video",
			"https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
			"https://x.com/jack/likes",
			"ftp://youtu.be/dQw4w9WgXcQ",
			"",
		]) {
			assert.equal(parseEmbed(bad), null, bad);
		}
		assert.equal(parseEmbed("https://youtu.be/dQw4w9WgXcQ").frame.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
		assert.equal(parseEmbed("https://bsky.app/profile/someone.bsky.social/post/3kabcdefghi2x").frame, null, "a handle gets the card on the web too");
		assert.equal(parseEmbed("https://bsky.app/profile/did:plc:abcd1234/post/3kabcdefghi2x").frame.src, "https://embed.bsky.app/embed/did:plc:abcd1234/app.bsky.feed.post/3kabcdefghi2x");
	});
});

describe("the cleaner", () => {
	test("keeps each block's marker and the one value it needs, checked", () => {
		const cleaned = cleanRichHtml(
			[
				'<div data-button="" onclick="x()"><a href="https://example.com/go" style="color:red">Go</a></div>',
				'<div data-embed="https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=3" data-x="1"></div>',
				'<div data-embed="https://evil.example.com/frame"></div>',
				'<div data-paywall=""></div>',
				'<div data-columns=""><div data-column=""><p>A</p></div><div data-column=""><p>B</p></div></div>',
				'<div data-file="" data-size="1024"><a href="https://cdn.example.com/a.pdf">a.pdf</a></div>',
				'<div data-file="" data-size="1e9"><a href="javascript:alert(1)">bad.pdf</a></div>',
				`<div data-poll="${POLL_ID.toUpperCase()}"><p>Q?</p><ol><li>A</li><li>B</li></ol></div>`,
				'<div data-poll="not-an-id"><p>Q?</p></div>',
				'<p>Text<sup data-footnote="" onmouseover="x()">A <b>note</b></sup></p>',
				"<iframe src=\"https://www.youtube.com/embed/dQw4w9WgXcQ\"></iframe>",
			].join("")
		);
		assert.ok(cleaned.includes('<div data-button=""><a href="https://example.com/go">Go</a></div>'));
		assert.ok(cleaned.includes('<div data-embed="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></div>'));
		assert.ok(!cleaned.includes("evil.example.com"), "an embed of a site it doesn't know loses its link");
		assert.ok(cleaned.includes('<div data-paywall=""></div>'));
		assert.ok(cleaned.includes('<div data-columns=""><div data-column=""><p>A</p></div>'));
		assert.ok(cleaned.includes('<div data-file="" data-size="1024">'));
		assert.ok(cleaned.includes('<div data-file=""><a>bad.pdf</a></div>'), "a size that isn't a number and a javascript: link go");
		assert.ok(cleaned.includes(`<div data-poll="${POLL_ID}">`));
		assert.ok(!cleaned.includes("not-an-id"));
		assert.ok(cleaned.includes('<sup data-footnote="">A <b>note</b></sup>'));
		assert.ok(!/onclick|onmouseover|style=|iframe|data-x/.test(cleaned));
	});

	test("finds the paywall break only outside other blocks", () => {
		assert.deepEqual(splitAtPaywall('<p>Free</p><div data-paywall=""></div><p>Paid</p>'), { before: "<p>Free</p>", after: "<p>Paid</p>", hasBreak: true });
		const nested = '<div data-callout=""><div data-paywall=""></div></div><p>All</p>';
		assert.equal(splitAtPaywall(nested).hasBreak, false);
	});
});

describe("blocks in an email", () => {
	test("a button is a table with the newsletter's accent, readable on it", () => {
		const { html, text } = email('<div data-button=""><a href="https://example.com/go">Read the story</a></div>');
		assert.match(html, /<table role="presentation"[^>]*align="center"[^>]*><tr><td align="center" bgcolor="#ff5500" style="[^"]*background:#ff5500;[^"]*"><a href="https:\/\/example.com\/go"[^>]*color:#09090b;[^>]*>Read the story<\/a>/);
		assert.match(email('<div data-button=""><a href="https://example.com/go">Go</a></div>', { newsletter: { ...newsletter, accentColor: "#1f2937" } }).html, /color:#ffffff;/, "white on a dark accent");
		assert.match(email('<div data-button=""><a href="https://example.com/go">Go</a></div>', { newsletter: { ...newsletter, accentColor: "red" } }).html, /bgcolor="#18181b"/, "a color that isn't #rrggbb falls back");
		assert.ok(text.includes("Read the story (https://example.com/go)"));
	});

	test("a YouTube embed is its thumbnail linked to the video; the others are a card with a link", () => {
		const { html, text } = email('<div data-embed="https://youtu.be/dQw4w9WgXcQ"></div><div data-embed="https://x.com/jack/status/20"></div>');
		assert.ok(html.includes('<img src="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"'));
		assert.ok(html.includes('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'));
		assert.ok(!/<iframe/i.test(html), "no frames in an email");
		assert.ok(text.includes("Watch on YouTube (https://www.youtube.com/watch?v=dQw4w9WgXcQ)"));
		assert.ok(text.includes("View the post on X (https://x.com/jack/status/20)"));
	});

	test("columns sit side by side and stack on a phone, with a table for Outlook", () => {
		const { html, text } = email('<div data-columns=""><div data-column=""><p>Left</p></div><div data-column=""><p>Right</p></div></div>');
		assert.equal(html.match(/display:inline-block;width:100%;max-width:280px/g).length, 2);
		assert.ok(html.includes('<!--[if mso]><table role="presentation" width="100%"'));
		assert.match(text, /Left\n\nRight/);
	});

	test("tables, files and footnotes get inline styles and read well as text", () => {
		const { html, text } = email(
			'<table><tbody><tr><th colspan="1" rowspan="1"><p>Plan</p></th></tr><tr><td colspan="1" rowspan="1"><p>Pro</p></td></tr></tbody></table>' +
				'<div data-file="" data-size="1572864"><a href="https://cdn.example.com/accounts/a/files/report-1.pdf">Report.pdf</a></div>' +
				'<p>One<sup data-footnote="">First &amp; best</sup> two<sup data-footnote="">Second</sup></p>'
		);
		assert.match(html, /<th colspan="1" rowspan="1" style="padding:8px 10px;border:1px solid #e4e4e7;[^"]*"><p style="margin:0;">Plan<\/p>/);
		assert.ok(text.includes("Report.pdf (https://cdn.example.com/accounts/a/files/report-1.pdf)"));
		assert.ok(text.includes("PDF · 1.5 MB · Download"));
		assert.ok(text.includes("One[1] two[2]"));
		assert.ok(text.includes("[1] First & best\n\n[2] Second"));
	});

	test("free readers stop at the paywall break with an upgrade card, paid readers read on, a test shows both", () => {
		const source = '<p>For everyone</p><div data-paywall=""></div><p>Only paid<sup data-footnote="">Paid note</sup></p>';
		const free = email(source, { readerTier: "free", upgradeUrl: "https://news.example.com/subscribe" });
		assert.ok(free.html.includes("For everyone"));
		assert.ok(!free.html.includes("Only paid") && !free.text.includes("Paid note"), "nothing of the paid part");
		assert.ok(free.html.includes("The rest of this issue is for paid subscribers"));
		assert.ok(free.text.includes("Upgrade to keep reading (https://news.example.com/subscribe)"));
		const paid = email(source, { readerTier: "paid" });
		assert.ok(paid.html.includes("Only paid") && !paid.html.includes("upgrade"));
		assert.ok(paid.text.includes("[1] Paid note"));
		const preview = email(source);
		assert.ok(preview.html.includes("Only paid") && preview.html.includes("Paid subscribers read on from here"));
	});

	test("a poll's options are vote links filled in for each reader", () => {
		const { html, text } = email(`<div data-poll="${POLL_ID}"><p>Cats or dogs?</p><ol><li><p>Cats</p></li><li><p>Dogs</p></li></ol></div>`);
		assert.ok(html.includes(`href="{{poll:${POLL_ID}:0}}"`) && html.includes(`href="{{poll:${POLL_ID}:1}}"`));
		assert.ok(text.includes(`Cats ({{poll:${POLL_ID}:0}})`));
		assert.ok(!email(`<div data-poll="${POLL_ID}"><p>Only one?</p><ol><li>Yes</li></ol></div>`).html.includes("{{poll:"), "a poll needs two options");
	});
});

describe("blocks on the archive page", () => {
	const render = (html) => archive.renderIssueBody({ format: "rich", html }, { accent: "#ff5500", pollUrl: (id, index) => `https://news.example.com/poll?p=${id}&o=${index}` });

	test("embeds are frames of the service's own embed address, and nothing else becomes a frame", () => {
		const { html, kind } = render(
			'<div data-embed="https://youtu.be/dQw4w9WgXcQ"></div><div data-embed="https://open.spotify.com/track/4rOoJ6Egrf8K2IrywzwOMk"></div>' +
				'<div data-columns=""><div data-column=""><p>A</p><iframe src="https://evil.example.com"></iframe></div><div data-column=""><p>B<img src="x" onerror="alert(1)"></p></div></div>'
		);
		assert.equal(kind, "article");
		const frames = [...html.matchAll(/<iframe src="([^"]+)"/g)].map(([, src]) => src);
		assert.deepEqual(frames, ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://open.spotify.com/embed/track/4rOoJ6Egrf8K2IrywzwOMk"]);
		assert.ok(html.includes('sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"'));
		assert.ok(html.includes('<div data-columns=""><div data-column=""><p>A</p></div>'));
		assert.ok(!/onerror|evil\.example/.test(html));
	});

	test("buttons, files, polls and footnotes become their markup", () => {
		const { html } = render(
			'<div data-button=""><a href="https://example.com/go">Go</a></div>' +
				'<div data-file="" data-size="2048"><a href="https://cdn.example.com/a.pdf">a.pdf</a></div>' +
				`<div data-poll="${POLL_ID}"><p>Cats or dogs?</p><ol><li>Cats</li><li>Dogs</li></ol></div>` +
				'<p>Text<sup data-footnote="">The note</sup></p>'
		);
		assert.ok(html.includes('<p data-button=""><a href="https://example.com/go" style="background:#ff5500;color:#09090b;">Go</a></p>'));
		assert.ok(html.includes('<a href="https://cdn.example.com/a.pdf" download'));
		assert.ok(html.includes(`<a href="https://news.example.com/poll?p=${POLL_ID}&amp;o=1" rel="nofollow">Dogs</a>`));
		assert.ok(html.includes('<sup id="fnref-1" data-footnote-ref=""><a href="#fn-1"'));
		assert.ok(html.includes('<li id="fn-1">The note <a href="#fnref-1"'));
	});

	test("the paid part after a break isn't on the page, which ends with the upgrade card", () => {
		const page = render('<p>Free part</p><div data-paywall=""></div><p>Paid part</p>');
		assert.equal(page.kind, "paywall");
		assert.equal(page.isPartial, true);
		assert.ok(page.html.includes("Free part") && !page.html.includes("Paid part"));
	});

	test("footnotes number in reading order", () => {
		assert.match(renderFootnotes('<p>a<sup data-footnote="">x</sup>b<sup data-footnote="">y</sup></p>', { mode: "web" }), /fn-1">x .*fn-2">y /);
	});
});

describe("file attachments", () => {
	const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
	const base64 = (bytes) => Buffer.from(bytes).toString("base64");

	test("upload as base64 when their bytes match their name, and stay out of the image library", async () => {
		const user = await t.customer("files-api@example.com");
		const uploaded = await t.api(user.key, "POST", "/files", { base64: base64(PDF), fileName: "Field report.pdf" });
		assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
		assert.equal(uploaded.body.contentType, "application/pdf");
		assert.equal(uploaded.body.name, "Field report.pdf");
		assert.ok(uploaded.body.url.includes(`accounts/${user.accountId}/files/field-report`));
		assert.equal(uploaded.body.html, `<div data-file="" data-size="${PDF.length}"><a href="${uploaded.body.url}">Field report.pdf</a></div>`);
		assert.ok(cleanRichHtml(uploaded.body.html).includes(uploaded.body.url), "the block survives the cleaner");

		assert.equal((await t.api(user.key, "POST", "/files", { base64: base64("hello,world\n1,2\n"), fileName: "data.csv" })).status, 201);
		t.assertError(await t.api(user.key, "POST", "/files", { base64: base64("<script>alert(1)</script>"), fileName: "page.html" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/files", { base64: base64("<svg/>"), fileName: "fake.pdf" }), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/files", { base64: base64(Buffer.from([0, 1, 2])), fileName: "notes.txt" }), 400, "validation_failed");

		const { images } = (await t.api(user.key, "GET", "/images")).body;
		assert.deepEqual(images, [], "files aren't images");
	});
});

describe("the accent color", () => {
	test("is a newsletter setting, as #rrggbb", async () => {
		const user = await t.customer("accent-color@example.com");
		const saved = await t.api(user.key, "PATCH", `/newsletters/${user.slug}`, { accentColor: "#FF5500" });
		assert.equal(saved.body.accentColor, "#ff5500");
		t.assertError(await t.api(user.key, "PATCH", `/newsletters/${user.slug}`, { accentColor: "red" }), 400, "validation_failed");
		assert.equal((await t.api(user.key, "PATCH", `/newsletters/${user.slug}`, { accentColor: "" })).body.accentColor, "");
	});
});

describe("each reader's email", () => {
	test("ends at the paywall break for free readers, and goes on for paid ones and in test emails", () => {
		const campaign = { _id: POLL_ID, format: "rich", subject: "Issue", html: '<p>Free part</p><div data-paywall=""></div><p>Paid part</p>' };
		const site = { _id: "6650f1c2e9b1d4a012345679", name: "Field notes", slug: "field-notes", fromEmail: "hello@field-notes.example.com", postalAddress: "1 Main St" };
		const contactId = "6650f1c2e9b1d4a01234567a";
		const free = buildRecipientEmail({ campaign, newsletter: site, contact: { _id: contactId, email: "free@example.com" } });
		assert.ok(free.html.includes("Free part") && !free.html.includes("Paid part"));
		assert.match(free.html, /href="[^"]*\/subscribe"/, "the upgrade card links to the subscribe page");
		const paid = buildRecipientEmail({
			campaign,
			newsletter: site,
			contact: { _id: contactId, email: "paid@example.com", tier: "paid", paidUntil: new Date(Date.now() + 86_400_000) },
		});
		assert.ok(paid.html.includes("Paid part") && !paid.html.includes("Paid subscribers read on"));
		const lapsed = buildRecipientEmail({ campaign, newsletter: site, contact: { _id: contactId, email: "lapsed@example.com", tier: "paid", paidUntil: new Date(2020, 0, 1) } });
		assert.ok(!lapsed.html.includes("Paid part"), "a paid period that ran out reads as free");
		const testEmail = buildRecipientEmail({ campaign, newsletter: site, contact: { _id: TEST_CONTACT_ID, email: "owner@example.com" } });
		assert.ok(testEmail.html.includes("Paid part") && testEmail.html.includes("Paid subscribers read on from here"));
	});
});
