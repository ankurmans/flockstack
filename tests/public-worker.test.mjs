import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp, withEnv } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { analyticsValues, createHandler, lookup } from "../workers/public/handler.js";
import { ANALYTICS_MARKERS, ANALYTICS_MARKER_PATTERN, fillAnalyticsMarkers, fillMarkerStream, isPrerendering } from "../lib/prerender.js";
import { firstDifference, normalize, removeHelpChat, resolveStreaming } from "../scripts/verify-public.mjs";
import { buildDevVars, buildWranglerConfig, checkPage, countMarkers, fileFor, findMarkerReplacements, hasMarkers, parseArgs, pickHeaders } from "../scripts/build-public.mjs";

// workers/public: the Worker that serves what scripts/build-public.mjs rendered. Its files here are stand-ins; the pages
// themselves are the app's own output, and the tests that follow check what is added to them per request.
const KEY = "phc_exampleprojectkey0123456789";
const M = ANALYTICS_MARKERS;

// What Next.js puts in a page for the browser: the analytics element's props, inside the JSON of a script, quotes escaped.
const flight = (props) => `<script>self.__next_f.push([1,"2e:[\\"$\\",\\"$L5b\\",null,${JSON.stringify(props).replaceAll('"', '\\"')}]\\n"])</script>`;
const PROPS = { token: M.token, host: M.host, replay: M.replay, region: "us", requiresConsent: M.requiresConsent, consent: M.consent, identity: null, privacyHref: "/privacy" };
const PAGE = `<!DOCTYPE html><html><body><h1>Terms</h1><span hidden data-analytics-provider></span>${flight(PROPS)}</body></html>`;

function manifest() {
	const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate", "x-frame-options": "DENY" };
	return {
		build: "abc123",
		regions: {
			us: { "/terms": { file: "terms.page", status: 200, headers, replacements: findMarkerReplacements(Buffer.from(PAGE)) }, "/docs/api": { file: "docs/api.page", status: 200, headers, replacements: [] }, "/privacy": { file: "privacy.page", status: 404, headers, replacements: [] }, "/robots.txt": { file: "robots.txt.page", status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, replacements: [] } },
			eu: { "/terms": { file: "terms.page", status: 200, headers, replacements: findMarkerReplacements(Buffer.from(PAGE)) } },
		},
	};
}

function assets(files, { fail = false } = {}) {
	const reads = [];
	return {
		reads,
		fetch: async (request) => {
			const path = new URL(request.url).pathname.slice(1);
			reads.push(path);
			if (fail) throw new Error("assets down");
			return path in files ? new Response(files[path]) : new Response("Not found", { status: 404 });
		},
	};
}

const FILES = { "terms.page": PAGE, "docs/api.page": "<h1>API</h1>", "privacy.page": "<h1>Not found</h1>", "robots.txt.page": "User-agent: *\n" };
const ask = async (url, { headers = {}, method = "GET", env = { POSTHOG_KEY: KEY }, files = FILES, fail = false } = {}) => {
	const binding = assets(files, { fail });
	const response = await createHandler(manifest())(new Request(url, { method, headers }), { ...env, ASSETS: binding });
	return { response, binding };
};

describe("the public pages Worker", () => {
	test("serves its region's page with the headers the app sent it, and says which build it is", async () => {
		const { response, binding } = await ask("https://flockstack.io/docs/api?utm_source=x");
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "<h1>API</h1>");
		assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(response.headers.get("x-frame-options"), "DENY");
		assert.equal(response.headers.get("x-public-build"), "abc123");
		assert.deepEqual(binding.reads, ["docs/api.page"]);
	});

	test("the EU Worker serves the EU table and the US Worker the US one; anything else is the US", async () => {
		const eu = await ask("https://eu.flockstack.io/terms", { env: { POSTHOG_KEY: KEY, FLOCKSTACK_REGION: "eu" } });
		assert.equal(eu.response.status, 200);
		assert.match(await eu.response.text(), /region\\":\\"us|<h1>Terms/, "the file is the one in its own folder");
		const euOnly = await ask("https://eu.flockstack.io/docs/api", { env: { POSTHOG_KEY: KEY, FLOCKSTACK_REGION: "eu" } });
		assert.equal(euOnly.response.headers.get("x-fs-public-miss"), "1", "the EU table has no /docs/api in this manifest");
		const us = await ask("https://flockstack.io/docs/api", { env: { POSTHOG_KEY: KEY, FLOCKSTACK_REGION: "us" } });
		assert.equal(us.response.status, 200);
		const other = await ask("https://flockstack.io/docs/api", { env: { POSTHOG_KEY: KEY, FLOCKSTACK_REGION: "mars" } });
		assert.equal(other.response.status, 200, "an unknown region is the US");
	});

	test("answers a legal page that is not published with the 404 the app gave, and a file with its own type", async () => {
		const { response } = await ask("https://flockstack.io/privacy");
		assert.equal(response.status, 404);
		assert.equal(await response.text(), "<h1>Not found</h1>");
		assert.equal(response.headers.has("x-fs-public-miss"), false, "a deliberate 404 is not a miss: the router passes it on");
		const robots = await ask("https://flockstack.io/robots.txt");
		assert.equal(robots.response.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.equal(await robots.response.text(), "User-agent: *\n");
	});

	test("says it has no copy of a page (a miss, so the router asks the app) or cannot read it (502)", async () => {
		const unknown = await ask("https://flockstack.io/docs/nope");
		assert.equal(unknown.response.status, 404);
		assert.equal(unknown.response.headers.get("x-fs-public-miss"), "1");
		const broken = await ask("https://flockstack.io/terms", { fail: true });
		assert.equal(broken.response.status, 502);
		assert.equal(broken.response.headers.get("x-fs-public-miss"), "1");
		const gone = await ask("https://flockstack.io/terms", { files: {} });
		assert.equal(gone.response.status, 502);
	});

	test("answers HEAD without a body and refuses a write", async () => {
		const head = await ask("https://flockstack.io/terms", { method: "HEAD" });
		assert.equal(head.response.status, 200);
		assert.equal(await head.response.text(), "");
		assert.equal(head.response.headers.get("content-type"), "text/html; charset=utf-8");
		const post = await ask("https://flockstack.io/terms", { method: "POST" });
		assert.equal(post.response.status, 405);
		assert.equal(post.binding.reads.length, 0);
	});

	test("streams a page that has nothing to fill in, and leaves no marker in one that has", async () => {
		const { response } = await ask("https://flockstack.io/terms", { headers: { "cf-ipcountry": "DE" } });
		const text = await response.text();
		assert.equal(text.includes("FSPRERENDERTOKEN"), false);
		for (const marker of Object.values(M)) assert.equal(text.includes(marker), false, marker);
		assert.match(text, /\\"token\\":\\"phc_exampleprojectkey0123456789\\",\\"host\\":\\"https:\/\/us\.i\.posthog\.com\\",\\"replay\\":false,\\"region\\":\\"us\\",\\"requiresConsent\\":true,\\"consent\\":null/);
	});

	test("lookup reads the region's table and nothing else", () => {
		assert.equal(lookup(manifest(), "us", "/terms").file, "terms.page");
		assert.equal(lookup(manifest(), "eu", "/docs/api"), null);
		assert.equal(lookup(manifest(), "us", "/__proto__"), null);
		assert.equal(lookup({}, "us", "/terms"), null);
	});
});

describe("the markers", () => {
	test("are replaced inside escaped JSON and in plain attributes, and booleans lose their quotes", () => {
		const values = { token: "phc_abcdefgh", host: "https://us.i.posthog.com", replay: true, requiresConsent: false, consent: "accepted" };
		const filled = fillAnalyticsMarkers(PAGE, values);
		assert.match(filled, /\\"token\\":\\"phc_abcdefgh\\"/);
		assert.match(filled, /\\"replay\\":true,/);
		assert.match(filled, /\\"requiresConsent\\":false,/);
		assert.match(filled, /\\"consent\\":\\"accepted\\"/);
		const plain = fillAnalyticsMarkers(`{"consent":"${M.consent}","requiresConsent":"${M.requiresConsent}"}`, { ...values, consent: null, requiresConsent: true });
		assert.equal(plain, '{"consent":null,"requiresConsent":true}');
		assert.equal(fillAnalyticsMarkers("<h1>nothing</h1>", values), "<h1>nothing</h1>");
	});

	test("what the page holds is valid JSON after the replacement, whatever the visitor's values", () => {
		for (const consent of [null, "accepted", "declined"]) {
			for (const requiresConsent of [true, false]) {
				const text = fillAnalyticsMarkers(PAGE, { token: "phc_abcdefgh", host: "https://us.i.posthog.com", replay: false, requiresConsent, consent });
				const chunk = /push\(\[1,("(?:[^"\\]|\\.)*")\]\)/.exec(text)[1];
				const props = JSON.parse(JSON.parse(chunk).split("\n")[0].replace(/^2e:/, ""))[3];
				assert.deepEqual(props, { token: "phc_abcdefgh", host: "https://us.i.posthog.com", replay: false, region: "us", requiresConsent, consent, identity: null, privacyHref: "/privacy" });
			}
		}
	});

	test("the pattern finds each marker only as a whole quoted string", () => {
		assert.equal(`x "${M.token}" y`.match(ANALYTICS_MARKER_PATTERN)?.length, 1);
		assert.equal(`x ${M.token} y`.match(ANALYTICS_MARKER_PATTERN), null);
		assert.equal(`x "${M.token}-more" y`.match(ANALYTICS_MARKER_PATTERN), null);
		assert.equal(isPrerendering({}), false);
		assert.equal(isPrerendering({ FLOCKSTACK_PRERENDER: "true" }), true);
		assert.equal(isPrerendering({ FLOCKSTACK_PRERENDER: "1" }), false);
	});

	test("the stream makes the same bytes as the text does, however the page is cut up, with multi-byte text before and between", async () => {
		const page = `<!DOCTYPE html><html><body><h1>Términos · 条款</h1>${"é".repeat(300)}${flight(PROPS)}<p>${"日本".repeat(50)}</p>${flight({ ...PROPS, region: "eu" })}</body></html>`;
		const bytes = Buffer.from(page);
		const replacements = findMarkerReplacements(bytes);
		assert.equal(replacements.length, 10, "five markers, twice");
		for (const values of [{ token: "phc_abcdefgh", host: "https://us.i.posthog.com", replay: false, requiresConsent: true, consent: null }, { token: "phc_zzzzzzzz", host: "https://eu.i.posthog.com", replay: true, requiresConsent: false, consent: "declined" }]) {
			const expected = Buffer.from(fillAnalyticsMarkers(page, values));
			for (const size of [1, 2, 3, 7, 13, 64, 500, 100000]) {
				const body = new ReadableStream({
					start(controller) {
						for (let at = 0; at < bytes.length; at += size) controller.enqueue(new Uint8Array(bytes.subarray(at, at + size)));
						controller.close();
					},
				});
				const out = Buffer.from(await new Response(fillMarkerStream(body, replacements, values)).arrayBuffer());
				assert.equal(out.toString("utf8"), expected.toString("utf8"), `chunks of ${size}`);
			}
		}
	});

	test("the offsets are bytes, not characters: a page with text before a marker is changed in the right place", () => {
		const bytes = Buffer.from(`ééé"${M.token}"`);
		assert.deepEqual(findMarkerReplacements(bytes), [[6, 6 + M.token.length + 2, M.token, 0]]);
		assert.deepEqual(findMarkerReplacements(Buffer.from("<h1>plain</h1>")), []);
	});

	test("the build counts them, and refuses a page that has some but not all", () => {
		assert.equal(hasMarkers(PAGE), true);
		assert.equal(hasMarkers("<h1>plain</h1>"), false);
		assert.deepEqual(Object.values(countMarkers(PAGE)), [1, 1, 1, 1, 1]);
		assert.throws(() => hasMarkers(`"${M.token}"`), /uneven/);
	});
});

describe("what a visitor gets is what the app would have worked out for them", () => {
	let app;
	let analytics;
	before(async () => {
		app = await startTestApp();
		analytics = await import("@/components/SiteExtensions");
	});
	after(() => app?.stop());

	const countries = [undefined, "", "US", "CA", "DE", "FR", "GB", "CH", "NO", "XX", "T1", "BR", "IN", "JP"];
	const cookies = [undefined, "fs_consent=accepted", "fs_consent=declined", "fs_consent=yes", "a=1; fs_consent=accepted; b=2"];

	async function fromApp({ region, country, cookie, replay, host }) {
		const jar = new Map();
		for (const part of String(cookie ?? "").split(";")) {
			const [name, value] = part.split("=").map((piece) => piece?.trim());
			if (name) jar.set(name, value);
		}
		const env = { POSTHOG_KEY: KEY, FLOCKSTACK_CLOUD: "true", FLOCKSTACK_REGION: region, LEGAL_PREVIEW: "true", POSTHOG_SESSION_REPLAY: replay ?? "", POSTHOG_HOST: host ?? "" };
		return withEnv(env, () =>
			runWithRequest({ jar, headers: country === undefined ? {} : { "cf-ipcountry": country } }, async () => {
				const element = analytics.SiteAnalytics({});
				return element ? element.type(element.props) : null;
			})
		);
	}

	test("for each region, country and saved choice", async () => {
		for (const region of ["us", "eu"]) {
			for (const country of countries) {
				for (const cookie of cookies) {
					const real = await fromApp({ region, country, cookie });
					const request = new Request("https://flockstack.io/terms", { headers: { ...(country === undefined ? {} : { "cf-ipcountry": country }), ...(cookie ? { cookie } : {}) } });
					const { region: serverRegion, identity, privacyHref, ...props } = real.props;
					void identity;
					void privacyHref;
					assert.equal(serverRegion, region);
					assert.deepEqual(analyticsValues(request, { POSTHOG_KEY: KEY }, region), props, `${region} ${country} ${cookie}`);
				}
			}
		}
	});

	test("with the app's replay and host settings, and with no key it is off, as the app renders nothing", async () => {
		const real = await fromApp({ region: "us", country: "US", replay: "true", host: "https://eu.i.posthog.com" });
		const request = new Request("https://flockstack.io/terms", { headers: { "cf-ipcountry": "US" } });
		assert.deepEqual(analyticsValues(request, { POSTHOG_KEY: KEY, POSTHOG_SESSION_REPLAY: "true", POSTHOG_HOST: "https://eu.i.posthog.com" }, "us"), { token: real.props.token, host: real.props.host, replay: real.props.replay, requiresConsent: real.props.requiresConsent, consent: real.props.consent });
		for (const POSTHOG_KEY of [undefined, "", "nope"]) {
			const off = analyticsValues(request, { POSTHOG_KEY }, "us");
			assert.equal(off.consent, "declined");
			assert.equal(off.requiresConsent, true);
		}
	});

	test("a Global Privacy Control or Do Not Track signal is the browser's to act on: the app renders nothing, the page's marker sees the same signal", async () => {
		assert.equal(await fromApp({ region: "us", country: "US", cookie: undefined, host: undefined }) !== null, true);
		const { readBrowserPrivacySignal } = await import("../lib/marketing/analytics-consent.js");
		assert.equal(readBrowserPrivacySignal({ navigator: { globalPrivacyControl: true } }), true);
		assert.equal(readBrowserPrivacySignal({ navigator: { doNotTrack: "1" } }), true);
		assert.equal(readBrowserPrivacySignal({ navigator: {} }), false);
	});

	test("the app, asked for the files, prints the markers and not the visitor's values", async () => {
		const element = await withEnv({ POSTHOG_KEY: KEY, FLOCKSTACK_CLOUD: "true", FLOCKSTACK_REGION: "us", FLOCKSTACK_PRERENDER: "true", LEGAL_PREVIEW: "true" }, () =>
			runWithRequest({ jar: new Map([["fs_consent", "accepted"]]), headers: { "cf-ipcountry": "DE" } }, async () => {
				const node = analytics.SiteAnalytics({});
				return node.type(node.props);
			})
		);
		assert.deepEqual(element.props, { token: M.token, host: M.host, replay: M.replay, region: "us", requiresConsent: M.requiresConsent, consent: M.consent, identity: null, privacyHref: "/privacy" });
		const support = await withEnv({ FLOCKSTACK_CLOUD: "true", FLOCKSTACK_PRERENDER: "true" }, async () => (await import("../lib/marketing/support-config.js")).getAiBinding());
		assert.ok(support, "the help chat is rendered, as it is on FlockStack Cloud");
		const without = await withEnv({ FLOCKSTACK_CLOUD: "true", FLOCKSTACK_PRERENDER: "" }, async () => (await import("../lib/marketing/support-config.js")).getAiBinding());
		assert.equal(without, null);
	});
});

describe("scripts/build-public.mjs", () => {
	test("names a file by its path, in a name no tool serves on its own", () => {
		assert.equal(fileFor("/docs/api"), "docs/api.page");
		assert.equal(fileFor("/api/v1/openapi.json"), "api/v1/openapi.json.page");
		assert.equal(fileFor("/"), "index.page");
	});

	test("keeps the headers a browser or crawler acts on and none of the platform's", () => {
		const kept = pickHeaders(new Headers({ "content-type": "text/html", "cache-control": "no-store", "transfer-encoding": "chunked", date: "x", "x-opennext": "1", "x-frame-options": "DENY", "set-cookie": "a=b", vary: "rsc" }));
		assert.deepEqual(kept, { "content-type": "text/html", "cache-control": "no-store", "x-frame-options": "DENY", vary: "rsc" });
	});

	test("refuses a page that did not render: a status, a cut-off or empty page; a legal page may be a 404", () => {
		const page = (overrides) => checkPage({ pathname: "/docs", status: 200, body: Buffer.from("<html><body><h1>x</h1></body></html>"), contentType: "text/html", ...overrides });
		assert.deepEqual(page(), []);
		assert.match(page({ status: 500 })[0], /500/);
		assert.match(page({ status: 404 })[0], /404/);
		assert.deepEqual(page({ pathname: "/terms", status: 404, body: Buffer.from("not found") }), []);
		assert.match(page({ body: Buffer.from("<html><body><h1>x") }).join(), /cut off/);
		assert.match(page({ body: Buffer.from("<html><body>no heading</body></html>") }).join(), /no h1/);
		assert.match(page({ contentType: null }).join(), /content type/);
	});

	test("starts the app on a local port with dummy secrets in a file Wrangler does not print, and the marker mode on", () => {
		const config = buildWranglerConfig({ region: "eu", appUrl: "https://eu.flockstack.io", urls: { us: "https://flockstack.io", eu: "https://eu.flockstack.io" }, root: "/repo" });
		assert.equal(config.main, "/repo/.worker/worker-entry.js");
		assert.equal(config.vars.FLOCKSTACK_PRERENDER, "true");
		assert.equal(config.vars.FLOCKSTACK_REGION, "eu");
		assert.equal(config.vars.APP_URL, "https://eu.flockstack.io");
		assert.equal(config.vars.POSTHOG_KEY, M.token);
		assert.equal(config.services, undefined, "no website, no app Worker: the app answers for itself");
		assert.equal(config.ai, undefined);
		assert.equal(config.triggers, undefined);
		assert.doesNotMatch(JSON.stringify(config), /SECRET|HASH_KEY|SES_ACCESS/);
		const secrets = buildDevVars();
		assert.match(secrets, /^BETTER_AUTH_SECRET=[0-9a-f]{64}\nSUPPRESSION_HASH_KEY=[0-9a-f]{64}\n/);
		assert.notEqual(buildDevVars(), secrets, "new ones each time");
	});

	test("takes --build, --only and --out and refuses anything else", () => {
		assert.equal(parseArgs([]).build, false);
		assert.equal(parseArgs(["--build", "--only", "eu"]).only, "eu");
		assert.throws(() => parseArgs(["--only", "mars"]), /us or eu/);
		assert.throws(() => parseArgs(["--deploy"]), /Unknown option/);
	});
});

describe("scripts/verify-public.mjs compares the page the visitor ends up with", () => {
	const late = '<main>x</main><!--$?--><template id="B:0"></template><!--/$--><footer>f</footer><div hidden id="S:0"><div class="a"><button>Help</button></div></div><script>$RC("B:0","S:0")</script>';
	const early = "<main>x</main><!--$--><div class=\"a\"><button>Help</button></div><!--/$--><footer>f</footer>";

	test("puts a part that arrived late where its placeholder is, which is where the browser moves it", () => {
		assert.equal(resolveStreaming(late).replace(/<!--\/?\$\??-->/g, ""), early.replace(/<!--\/?\$\??-->/g, ""));
		assert.equal(resolveStreaming("<p>plain</p>"), "<p>plain</p>");
	});

	test("ignores how Next.js cut its data into pieces and in which order the rows came", () => {
		const a = '<body><script>self.__next_f.push([1,"1:\\"a\\"\\n2:[\\"$L5db\\"]\\n"])</script><script>self.__next_f.push([1,"3:[\\"b\\"]\\n"])</script></body>';
		const b = '<body><script>self.__next_f.push([1,"3:[\\"b\\"]\\n1:\\"a\\"\\n2:[\\"$L5da\\"]\\n"])</script></body>';
		assert.equal(normalize(a), normalize(b));
		const c = '<body><script>self.__next_f.push([1,"1:\\"a\\"\\n2:[\\"$L5db\\"]\\n3:[\\"other\\"]\\n"])</script></body>';
		assert.notEqual(normalize(a), normalize(c));
	});

	test("sees a real difference: text, an attribute, a visitor's value", () => {
		assert.notEqual(normalize("<h1>Terms</h1>"), normalize("<h1>Privacy</h1>"));
		assert.deepEqual(firstDifference("abc", "abc"), null);
		assert.equal(firstDifference("abcdef", "abcxef").index, 3);
		assert.equal(firstDifference("abc", "abcd").index, 3);
		const consent = (value) => `<script>self.__next_f.push([1,"2:{\\"consent\\":${value}}\\n"])</script>`;
		assert.notEqual(normalize(consent("null")), normalize(consent('\\"accepted\\"')));
	});

	test("takes the help chat out of both sides when the app has no AI binding to render it", () => {
		const page = '<main>x</main><div data-support-chat="true" class="ph-no-capture"><button>Help</button><section><div>panel</div></section></div><footer>f</footer>';
		assert.equal(removeHelpChat(page), "<main>x</main><footer>f</footer>");
		assert.equal(removeHelpChat("<main>x</main>"), "<main>x</main>");
		assert.equal(normalize(page, { withoutHelpChat: true }), normalize("<main>x</main><footer>f</footer>", { withoutHelpChat: true }));
	});
});
