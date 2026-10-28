import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { SHARED_DOMAIN, callApi, createPublisher, importModels } from "./helpers/community.mjs";
import { images } from "./stubs/opennext-cloudflare.mjs";
import { remoteImages } from "./stubs/remote-image.mjs";

// The visuals of issues and briefings (docs/VISUALS-DESIGN.md): the section icons, the stored share card and its hashed address
// in the tags, the icon PNGs, the card and icons in the email, and the grotesk pair's fonts. Nothing reaches the network.
const BRIEFING = await readFile(new URL("./fixtures/briefing-underwritten.md", import.meta.url), "utf8");
const SECTION_TITLES = ["Lead", "Market pulse", "Earnings and filings", "Headline roundup", "Deal flow", "Regulation and rates", "People moves", "Product and tech launches", "Coming up"];
const ACCENT = "#c33e00";

let app;
let m;

before(async () => {
	app = await startTestApp({ IMAGES_STORAGE: "r2", IMAGES_CDN_URL: "https://img.example.com" });
	m = {
		...(await importModels()),
		proxy: (await import("../proxy.js")).proxy,
		og: await import("../app/archive/[slug]/og/route.js"),
		icon: await import("../app/archive/[slug]/icon/[file]/route.js"),
		icons: await import("../lib/section-icons.js"),
		card: await import("../lib/share-card.js"),
		issueCard: await import("../lib/issue-card.js"),
		seo: await import("../lib/archive-seo.js"),
		mountRules: await import("../lib/mount-rules.js"),
		renderEmail: await import("../lib/render-email.js"),
		webIssue: await import("../lib/web-issue.js"),
		siteThemes: await import("../lib/site-themes.js"),
		fonts: await import("../lib/archive-fonts.js"),
		StyleSite: (await import("../components/StyleSite.jsx")).default,
	};
});

after(() => app?.stop());

// A PNG's size and its pixels as RGBA rows (8-bit RGBA, the five filters undone), enough to read the color resvg drew.
function readPng(bytes) {
	const buffer = Buffer.from(bytes);
	assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	const chunks = [];
	for (let offset = 8; offset < buffer.length; ) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
		offset += length + 12;
	}
	const colorType = buffer[25];
	if (colorType !== 6) return { width, height, pixels: null };
	const raw = inflateSync(Buffer.concat(chunks));
	const stride = width * 4;
	const pixels = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y += 1) {
		const filter = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x += 1) {
			const value = raw[y * (stride + 1) + 1 + x];
			const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
			const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
			const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
			const paeth = () => {
				const p = left + up - upLeft;
				const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
				return a <= b && a <= c ? left : b <= c ? up : upLeft;
			};
			const predictor = [0, left, up, (left + up) >> 1, paeth()][filter];
			pixels[y * stride + x] = (value + predictor) & 0xff;
		}
	}
	return { width, height, pixels };
}

function opaqueColors(pixels) {
	const colors = new Set();
	for (let index = 0; index < pixels.length; index += 4) {
		if (pixels[index + 3] === 255) colors.add(`#${[0, 1, 2].map((channel) => pixels[index + channel].toString(16).padStart(2, "0")).join("")}`);
	}
	return colors;
}

const ogFor = (slug, query = "") => m.og.GET(new Request(`http://localhost:3000/archive/${slug}/og${query}`), { params: Promise.resolve({ slug }) });
const iconFor = (slug, file, query = "") => m.icon.GET(new Request(`http://localhost:3000/archive/${slug}/icon/${file}${query}`), { params: Promise.resolve({ slug, file }) });

async function briefingPublisher(name, newsletter = {}) {
	const user = await createPublisher(m, `${name}@example.com`, {
		issue: { subject: "Coastal rates climb as inland capacity loosens", format: "markdown", markdown: BRIEFING, html: "", startedAt: new Date("2026-10-28T09:00:00Z"), source: "briefing" },
	});
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { accentColor: ACCENT, brand: { publisher: "by QuoteSweep", fontPair: "grotesk", ...newsletter } } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	user.issue = await m.Campaign.findOne({ accountId: user.accountId, _id: user.issue._id }).lean();
	return user;
}

describe("section icons", () => {
	test("are lucide's own drawings, one per key", async () => {
		const strip = (nodes) => nodes.map(([element, { key: _key, ...attributes }]) => [element, attributes]);
		for (const key of m.icons.SECTION_ICON_KEYS) {
			// bar-chart-3 is lucide's old name of chart-column, whose file has the drawing.
			const name = { "bar-chart-3": "chart-column" }[m.icons.SECTION_ICON_NAMES[key]] ?? m.icons.SECTION_ICON_NAMES[key];
			const { __iconData } = await import(`../node_modules/lucide-react/dist/esm/icons/${name}.mjs`);
			assert.deepEqual(m.icons.SECTION_ICON_NODES[key], strip(__iconData.node), key);
		}
	});

	test("a section's icon is its own, else its id's, else its title's, else generic", () => {
		const { iconKeyForSection } = m.icons;
		assert.equal(iconKeyForSection({ id: "lead", icon: "rocket" }), "lead", "an unknown icon is ignored");
		assert.equal(iconKeyForSection({ id: "market-pulse", icon: "people" }), "people");
		assert.equal(iconKeyForSection({ id: "deal-flow", title: "Anything" }), "deal-flow");
		const fromTitles = SECTION_TITLES.map((title) => iconKeyForSection({ id: "s1", title }));
		assert.deepEqual(fromTitles, ["lead", "market-pulse", "earnings", "roundup", "deal-flow", "regulation", "people", "launches", "coming-up"]);
		assert.equal(iconKeyForSection({ title: "Markets fall 3% on rate fears" }), "generic", "a headline that mentions markets is not the section");
		assert.equal(iconKeyForSection({}), "generic");
	});

	test("only a sectioned issue's headings get them: one known heading in an ordinary issue stays plain", () => {
		const plain = "<h2>People</h2><p>Text</p><h2>What I read</h2>";
		assert.equal(m.icons.addSectionIcons(plain, () => "<i></i>"), plain);
		assert.deepEqual(m.icons.getSectionKeys(plain), []);
		const sectioned = "<h2>Lead</h2><p>a</p><h2 id=\"x\">Deal flow</h2><h2>Odd one</h2>";
		assert.deepEqual(m.icons.getSectionKeys(sectioned), ["lead", "deal-flow"]);
		assert.equal(m.icons.addSectionIcons(sectioned, (key) => `[${key}]`), "<h2>[lead]Lead</h2><p>a</p><h2 id=\"x\">[deal-flow]Deal flow</h2><h2>Odd one</h2>");
	});

	test("show inline on the issue's web page, in the accent, after the sanitizer", async () => {
		const newsletter = { name: "Underwritten", slug: "underwritten", accentColor: ACCENT };
		const body = m.webIssue.renderWebIssue({ newsletter, issue: { format: "markdown", markdown: BRIEFING, subject: "S" }, recommendations: [] });
		const headings = [...body.html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((match) => match[1]);
		assert.equal(headings.length, 9);
		for (const [index, heading] of headings.entries()) {
			assert.match(heading, /^<svg class="section-icon" [^>]*aria-hidden="true">/);
			assert.equal(heading.replace(/<svg[\s\S]*?<\/svg>/, "").replace(/&amp;/g, "&"), SECTION_TITLES[index]);
		}
		const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.match(css, /\.prose-issue h2 > \.section-icon \{[^}]*color: var\(--site-link, currentColor\)/);
	});
});

describe("share card", () => {
	test("the issue, home and mounted pages' tags carry the card's hash, its size and alt text", async () => {
		const user = await briefingPublisher("visuals-tags");
		const { issue } = user;
		const hash = m.card.getCardHash(user.newsletter, issue);
		const { metadata } = m.seo.getIssueSeo(user.newsletter, issue);
		for (const image of [metadata.openGraph.images[0], metadata.twitter.images[0]]) {
			assert.equal(image.url, `http://localhost:3000/archive/${user.slug}/og?p=${issue.archiveSlug}&v=${hash}`);
			assert.equal(image.width, 1200);
			assert.equal(image.height, 630);
			assert.equal(image.alt, "Coastal rates climb as inland capacity loosens");
		}
		const home = m.seo.getHomeSeo(user.newsletter).metadata;
		assert.equal(home.openGraph.images[0].url, `http://localhost:3000/archive/${user.slug}/og?v=${m.card.getCardHash(user.newsletter, null)}`);
		assert.deepEqual([home.twitter.images[0].width, home.twitter.images[0].height, home.twitter.images[0].alt], [1200, 630, user.newsletter.name]);

		// A mounted website: the card stays on the app's address, which the mount's rewriter leaves alone, and prints the mount.
		const mounted = { ...user.newsletter, mount: { url: "https://www.example.com/newsletter/underwritten", verifiedAt: new Date() } };
		const mountedImage = m.seo.getIssueSeo(mounted, issue).metadata.openGraph.images[0];
		assert.match(mountedImage.url, new RegExp(`^http://localhost:3000/archive/${user.slug}/og\\?p=${issue.archiveSlug}&v=[0-9a-f]{16}$`));
		assert.notEqual(mountedImage.url, `http://localhost:3000/archive/${user.slug}/og?p=${issue.archiveSlug}&v=${hash}`, "the printed address is part of the card");
		assert.equal(m.card.getCardInputs(mounted, issue).host, "example.com/newsletter/underwritten");
		assert.equal(m.mountRules.toMountedUrl(mountedImage.url, { mountPath: "/newsletter/underwritten", slug: user.slug }), mountedImage.url);
		assert.equal(m.seo.getIssueSeo(mounted, issue).metadata.alternates.canonical, `https://www.example.com/newsletter/underwritten/p/${issue.archiveSlug}`);
	});

	test("shows the issue's first four section icons, and changes its hash with what it shows", async () => {
		const user = await briefingPublisher("visuals-hash");
		const inputs = m.card.getCardInputs(user.newsletter, user.issue);
		assert.deepEqual(inputs.icons, ["lead", "market-pulse", "earnings", "roundup"]);
		assert.equal(inputs.publisher, "by QuoteSweep");
		assert.equal(inputs.date, "2026-10-28");
		const hash = m.card.hashCardInputs(inputs);
		assert.match(hash, /^[0-9a-f]{16}$/);
		assert.equal(m.card.hashCardInputs({ ...inputs }), hash);
		assert.notEqual(m.card.hashCardInputs({ ...inputs, title: `${inputs.title}.` }), hash);
		assert.notEqual(m.card.hashCardInputs({ ...inputs, accent: "#1d4ed8" }), hash);
		assert.notEqual(m.card.hashCardInputs({ ...inputs, version: inputs.version + 1 }), hash);
	});

	test("is drawn once, stored by its hash and served from storage after, immutable when asked for by that hash", async () => {
		const user = await briefingPublisher("visuals-store");
		const hash = m.card.getCardHash(user.newsletter, user.issue);
		const key = `cards/${user.newsletterId}/${hash}.png`;
		const first = await ogFor(user.slug, `?p=${user.issue.archiveSlug}&v=${hash}`);
		assert.equal(first.status, 200);
		assert.equal(first.headers.get("content-type"), "image/png");
		assert.equal(first.headers.get("cache-control"), "public, max-age=31536000, immutable");
		const drawn = Buffer.from(await first.arrayBuffer());
		assert.deepEqual([drawn.readUInt32BE(16), drawn.readUInt32BE(20)], [1200, 630]);
		assert.ok(images.has(key), "stored under cards/<newsletterId>/<hash>.png");
		assert.deepEqual(Buffer.from(images.get(key).bytes), drawn);

		// What is stored is what the next request gets: no second drawing.
		const marked = Uint8Array.from([...drawn.subarray(0, 64), 1, 2, 3]);
		images.set(key, { bytes: marked, contentType: "image/png" });
		const second = await ogFor(user.slug, `?p=${user.issue.archiveSlug}&v=${hash}`);
		assert.deepEqual(new Uint8Array(await second.arrayBuffer()), marked);

		// An old hash or none gets today's card, cached for a while only.
		const stale = await ogFor(user.slug, `?p=${user.issue.archiveSlug}&v=0000000000000000`);
		assert.match(stale.headers.get("cache-control"), /^public, max-age=3600/);
		assert.equal((await ogFor(user.slug, "?p=no-such-issue")).status, 404);
	});

	test("a card that can't be drawn answers the newsletter's own card, and failing that a plain one, never an error", async () => {
		const user = await briefingPublisher("visuals-fallback");
		const logo = "https://img.example.com/broken-logo.png";
		remoteImages.set(logo, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { imageUrl: logo } });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const errors = [];
		const original = console.error;
		console.error = (...args) => errors.push(args);
		try {
			const plain = await ogFor(user.slug, `?p=${user.issue.archiveSlug}`);
			assert.equal(plain.status, 200);
			assert.equal(plain.headers.get("cache-control"), "public, max-age=300");
			const bytes = Buffer.from(await plain.arrayBuffer());
			assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [1200, 630]);
			assert.ok(bytes.length < 400, "the plain gray card");

			// The newsletter's own card, stored before, stands in for the issue's.
			const homeKey = m.card.getCardKey(user.newsletterId, m.card.getCardHash(newsletter, null));
			const home = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
			images.set(homeKey, { bytes: home, contentType: "image/png" });
			const fallback = await ogFor(user.slug, `?p=${user.issue.archiveSlug}`);
			assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), home);
		} finally {
			console.error = original;
		}
		assert.ok(errors.length >= 2, "each failure is logged");
	});

	test("an email's card is its campaign's, signed, whatever its status; a wrong signature is 404", async () => {
		const user = await briefingPublisher("visuals-email-card");
		const draft = (await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Draft briefing", format: "markdown", markdown: BRIEFING, status: "draft", source: "briefing" })).toObject();
		const card = m.issueCard.getEmailCard({ newsletter: user.newsletter, campaign: draft });
		const url = new URL(card.url);
		assert.equal(url.origin, `https://${user.slug}.${SHARED_DOMAIN}`, "on the link host, like every link in an email");
		assert.equal(url.pathname, "/og");
		const query = url.search;
		const ok = await ogFor(user.slug, query);
		assert.equal(ok.status, 200);
		assert.equal(ok.headers.get("cache-control"), "public, max-age=31536000, immutable");
		assert.equal((await ogFor(user.slug, query.replace(/s=[^&]+/, "s=AAAAAAAAAAAAAAAAAAAAAA"))).status, 404);
		const other = await briefingPublisher("visuals-email-other");
		assert.equal((await ogFor(other.slug, query)).status, 404, "another newsletter's slug");
	});
});

describe("section icon PNGs", () => {
	test("each key is 48 by 48 in the accent on transparent, stored once per color; anything else is 404", async () => {
		const user = await briefingPublisher("visuals-icons");
		const color = m.issueCard.getIconColor(user.newsletter);
		assert.equal(color, "c33e00");
		for (const key of m.icons.SECTION_ICON_KEYS) {
			const response = await iconFor(user.slug, `${key}.png`, `?c=${color}`);
			assert.equal(response.status, 200, key);
			assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
			const { width, height, pixels } = readPng(await response.arrayBuffer());
			assert.deepEqual([width, height], [48, 48]);
			assert.equal(pixels[3], 0, "transparent corner");
			// Where two strokes overlap the edge is blended a step off; every opaque pixel is the accent within that.
			const off = (hex) => Math.max(...[1, 3, 5].map((index) => Math.abs(Number.parseInt(hex.slice(index, index + 2), 16) - Number.parseInt(ACCENT.slice(index, index + 2), 16))));
			const colors = [...opaqueColors(pixels)];
			assert.ok(colors.includes(ACCENT), key);
			assert.ok(colors.every((color) => off(color) <= 3), `${key}: ${colors.join(" ")}`);
			assert.ok(images.has(`section-icons/${color}/${key}.png`));
		}
		assert.match((await iconFor(user.slug, "lead.png", "?c=000000")).headers.get("cache-control"), /^public, max-age=3600/);
		for (const file of ["rocket.png", "lead.svg", "lead", "../lead.png"]) assert.equal((await iconFor(user.slug, file)).status, 404, file);
		assert.equal((await iconFor("no-such-newsletter", "lead.png")).status, 404);
	});

	test("a pale accent is drawn in the shade that reads on white", async () => {
		assert.equal(m.issueCard.getIconColor({ accentColor: "#fde047" }).length, 6);
		assert.notEqual(m.issueCard.getIconColor({ accentColor: "#fde047" }), "fde047");
	});

	test("the card and icons answer on the newsletter's host and through its mount", async () => {
		const user = await briefingPublisher("visuals-hosts");
		const host = `${user.slug}.${SHARED_DOMAIN}`;
		const visit = (path, headers = {}) => m.proxy(new m.NextRequest(new URL(path, `https://${host}`), { headers: { host, ...headers } }));
		const rewritten = (response) => new URL(response.headers.get("x-middleware-rewrite")).pathname;
		assert.equal(rewritten(await visit("/icon/deal-flow.png")), `/archive/${user.slug}/icon/deal-flow.png`);
		assert.equal(rewritten(await visit("/og?c=1")), `/archive/${user.slug}/og`);
		assert.equal((await visit("/icon/rocket.svg")).status, 404);

		const set = await callApi("POST", `/api/v1/newsletters/${user.slug}/mount`, { key: user.key, body: { url: "https://example.com/newsletter/visuals" } });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		const mounted = await visit("/icon/lead.png", { "x-flockstack-mount": set.body.token });
		assert.equal(rewritten(mounted), `/archive/${user.slug}/icon/lead.png`);
		assert.equal(mounted.headers.get("x-flockstack-mounted"), "/newsletter/visuals");

		const { config } = await import("../proxy.js");
		assert.ok(config.matcher.includes("/icon/:file"), "the .png paths the matcher skips include no section icon");
	});
});

describe("email", () => {
	const contact = { _id: "65a000000000000000000001", email: "reader@example.com", status: "active" };

	async function email(user, campaignFields = {}, newsletterBrand = {}) {
		const newsletter = { ...user.newsletter, brand: { ...user.newsletter.brand, emailLogo: true, ...newsletterBrand } };
		const campaign = { ...user.issue, ...campaignFields };
		return m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact, messageId: null });
	}

	test("a briefing's issue starts with its card by default; the newsletter and the issue can say otherwise", async () => {
		const user = await briefingPublisher("visuals-email-switch");
		const card = /<img src="https:\/\/[^"]+\/og\?c=[0-9a-f]{24}&amp;s=[A-Za-z0-9_-]{22}&amp;v=[0-9a-f]{16}" width="600" height="315" alt="Coastal rates climb as inland capacity loosens"/;
		assert.match((await email(user)).html, card);
		assert.doesNotMatch((await email(user, { source: "api" })).html, /\/og\?/, "another issue: off by default");
		assert.match((await email(user, { source: "api", externalId: "briefing:abc:2026-10-28" })).html, card, "made by a briefing before the source said so");
		assert.doesNotMatch((await email(user, {}, { issueCard: false })).html, /\/og\?/, "the newsletter turned it off");
		assert.match((await email(user, { source: "api" }, { issueCard: true })).html, card, "the newsletter turned it on");
		assert.doesNotMatch((await email(user, { issueCard: false }, { issueCard: true })).html, /\/og\?/, "the issue's own word wins");
		assert.match((await email(user, { issueCard: true, source: "dashboard" }, { issueCard: false })).html, card);
	});

	test("the header carries the publisher line, and each section heading its icon on the link host", async () => {
		const user = await briefingPublisher("visuals-email-icons");
		const { html } = await email(user);
		assert.match(html, /<br><span style="font-size:13px;font-weight:400;color:#71717a;">by QuoteSweep<\/span>/);
		const icons = [...html.matchAll(/<h2[^>]*><img src="([^"]+)" width="24" height="24" alt="([^"]+)"[^>]*>([^<]+)<\/h2>/g)];
		assert.equal(icons.length, 9);
		for (const [index, [, src, alt, text]] of icons.entries()) {
			assert.match(src, new RegExp(`^https://${user.slug}\\.${SHARED_DOMAIN.replace(".", "\\.")}/icon/[a-z-]+\\.png\\?c=c33e00$`));
			assert.equal(alt.replace(/&amp;/g, "&"), SECTION_TITLES[index]);
			assert.equal(text.replace(/&amp;/g, "&"), SECTION_TITLES[index]);
		}
		assert.doesNotMatch(html, /\p{Extended_Pictographic}/u, "no emoji");
	});

	test("a typical briefing reads the same with images off and stays far below Gmail's 102 KB clip", async () => {
		const user = await briefingPublisher("visuals-email-size");
		const rendered = await email(user);
		assert.ok(rendered.bytes < 40 * 1024, `${rendered.bytes} bytes`);
		// The same email as before the visuals: no card, no icons, no publisher line.
		const newsletter = { ...user.newsletter, brand: { ...user.newsletter.brand, emailLogo: true } };
		const common = { format: "markdown", markdown: BRIEFING, subject: user.issue.subject, webUrl: "https://example.com/p/x" };
		const before = m.renderEmail.renderEmail({ ...common, newsletter: { ...newsletter, brand: { ...newsletter.brand, publisher: "" } } });
		const visuals = m.renderEmail.renderEmail({ ...common, newsletter, issueCard: m.issueCard.getEmailCard({ newsletter, campaign: user.issue }), sectionIconUrl: (key) => m.issueCard.getEmailIconUrl(newsletter, key) });
		assert.ok(visuals.bytes - before.bytes < 2.5 * 1024, `the visuals add ${visuals.bytes - before.bytes} bytes`);

		const imagesOff = rendered.html.replace(/<img\b[^>]*>/gi, "");
		const headings = [...imagesOff.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((match) => match[1].replace(/&amp;/g, "&"));
		assert.deepEqual(headings, SECTION_TITLES);
		assert.match(imagesOff, /Commercial property insurers raised renewal rates/);
		for (const tag of rendered.html.match(/<img\b[^>]*>/gi)) {
			assert.match(tag, /\salt="/, tag);
			assert.match(tag, /\swidth="\d+"/, tag);
		}
		// The plain text part names no icon: each heading once.
		assert.equal(rendered.text.split("Market pulse").length - 1, 1);
	});

	test("welcome and automation emails, and transactional ones, have neither card nor icons", async () => {
		const user = await briefingPublisher("visuals-email-other-kinds", { issueCard: true });
		const welcome = m.sendingRules.buildRecipientEmail({ campaign: { format: "markdown", markdown: BRIEFING, subject: "Welcome" }, newsletter: user.newsletter, contact, messageId: null });
		assert.doesNotMatch(welcome.html, /\/og\?|\/icon\//);
		const order = m.sendingRules.buildRecipientEmail({ campaign: user.issue, newsletter: user.newsletter, contact, messageId: null, transactionalReason: "You bought a thing." });
		assert.doesNotMatch(order.html, /\/og\?|\/icon\//);
	});
});

describe("grotesk fonts", () => {
	test("are self-hosted, never preloaded, and named only in a grotesk newsletter's stylesheet", async () => {
		const source = await readFile(new URL("../lib/archive-fonts.js", import.meta.url), "utf8");
		assert.equal(source.match(/preload: false/g)?.length, 2);
		assert.doesNotMatch(source, /next\/font\/google|fonts\.googleapis/);
		for (const file of ["host-grotesk-latin-wght-normal.woff2", "inter-latin-wght-normal.woff2", "OFL-host-grotesk.txt", "OFL-inter.txt"]) {
			assert.ok((await readFile(new URL(`../app/archive/fonts/${file}`, import.meta.url))).length > 1000, file);
		}
		assert.match(await readFile(new URL("../app/archive/fonts/OFL-inter.txt", import.meta.url), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);

		const css = (fontPair) => m.StyleSite({ newsletter: { brand: { fontPair, theme: "classic" } }, only: "classic" }).props.dangerouslySetInnerHTML.__html;
		const { "Host Grotesk": heading, Inter: body } = m.fonts.WEB_FONT_FAMILIES;
		assert.ok(css("grotesk").includes(`--site-font-heading:${heading},'Host Grotesk'`));
		assert.ok(css("grotesk").includes(`--site-font-body:${body},Inter`));
		for (const pair of [undefined, "sans", "serif", "editorial", "modern", "helvetica"]) {
			assert.ok(!css(pair).includes(heading) && !css(pair).includes(body), `${pair} names no web font`);
		}
		// The email falls back to the device's sans-serif.
		const { html } = m.renderEmail.renderEmail({ format: "markdown", markdown: "## Lead\n\nText", newsletter: { name: "U", brand: { fontPair: "grotesk" } } });
		assert.ok(!html.includes(heading));
		assert.match(html, /font-family: 'Host Grotesk',-apple-system/);
	});
});
