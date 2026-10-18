import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readAnalyticsEnv } from "../lib/marketing/analytics-config.js";
import {
	ACCEPTED,
	CONSENT_COOKIE,
	CONSENT_MAX_AGE,
	DECLINED,
	clearAnalyticsStorage,
	cookieDomains,
	decideAnalytics,
	getAnalyticsStatus,
	hasPrivacySignal,
	readBrowserPrivacySignal,
	readConsent,
	requiresConsent,
	serializeConsentCookie,
} from "../lib/marketing/analytics-consent.js";

// When FlockStack's own PostHog may run: who must accept first, which signals switch it off, how the choice is kept
// and what a decline removes (lib/marketing/analytics-consent.js).
const US = { FLOCKSTACK_REGION: "us" };
const EU = { FLOCKSTACK_REGION: "eu" };

// A document.cookie that keeps a jar: a write with Max-Age=0 removes the cookie, any other adds it.
function fakeDocument(cookies) {
	const jar = new Map(Object.entries(cookies));
	const writes = [];
	return {
		jar,
		writes,
		get cookie() {
			return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
		},
		set cookie(line) {
			writes.push(line);
			const [pair, ...attributes] = line.split(";").map((part) => part.trim());
			const [name, value] = pair.split("=");
			if (attributes.some((attribute) => attribute === "Max-Age=0")) jar.delete(name);
			else jar.set(name, value);
		},
	};
}

function fakeStorage(entries) {
	const map = new Map(Object.entries(entries));
	return {
		map,
		get length() {
			return map.size;
		},
		key: (index) => [...map.keys()][index] ?? null,
		removeItem: (key) => map.delete(key),
	};
}

describe("who must accept first", () => {
	test("visitors in the EU, the EEA, the UK and Switzerland are asked", () => {
		for (const country of ["DE", "FR", "IE", "NL", "PL", "SE", "NO", "IS", "LI", "GB", "CH"]) assert.equal(requiresConsent({ country, env: US }), true, country);
		assert.equal(requiresConsent({ country: "de", env: US }), true);
	});

	test("everyone else gets the analytics by default", () => {
		for (const country of ["US", "CA", "AU", "JP", "BR", "IN", "SG"]) assert.equal(requiresConsent({ country, env: US }), false, country);
	});

	test("a visitor Cloudflare can't place is asked, as one who may be in the EU", () => {
		for (const country of [undefined, null, "", "XX", "T1"]) assert.equal(requiresConsent({ country, env: US }), true, String(country));
	});

	test("every visitor to the EU deployment is asked, wherever they are", () => {
		for (const country of ["US", "DE", "JP", undefined]) assert.equal(requiresConsent({ country, env: EU }), true, String(country));
	});
});

describe("privacy signals", () => {
	test("Global Privacy Control and Do Not Track, as headers and as the browser reports them", () => {
		assert.equal(hasPrivacySignal({ gpc: "1" }), true);
		assert.equal(hasPrivacySignal({ dnt: "1" }), true);
		assert.equal(hasPrivacySignal({ gpc: true }), true);
		assert.equal(hasPrivacySignal({ dnt: "yes" }), true);
		for (const none of [{}, { gpc: "0", dnt: "0" }, { gpc: null, dnt: null }, { gpc: false }, { dnt: "unspecified" }]) assert.equal(hasPrivacySignal(none), false);
		assert.equal(readBrowserPrivacySignal({ navigator: { globalPrivacyControl: true } }), true);
		assert.equal(readBrowserPrivacySignal({ navigator: { doNotTrack: "1" } }), true);
		assert.equal(readBrowserPrivacySignal({ doNotTrack: "1", navigator: {} }), true);
		assert.equal(readBrowserPrivacySignal({ navigator: { globalPrivacyControl: false, doNotTrack: null } }), false);
		assert.equal(readBrowserPrivacySignal({}), false);
	});

	test("a signal means nothing renders and no banner, whatever the country or an earlier choice", () => {
		for (const country of ["US", "DE"]) {
			for (const consent of [null, ACCEPTED, DECLINED]) {
				assert.deepEqual(decideAnalytics({ country, gpc: "1", consent, env: US }), { show: false, reason: "privacy-signal" });
				assert.deepEqual(decideAnalytics({ country, dnt: "1", consent, env: US }), { show: false, reason: "privacy-signal" });
			}
		}
		assert.equal(decideAnalytics({ country: "US", gpc: "1", env: EU }).show, false);
	});
});

describe("the choice", () => {
	test("is read from the fs_consent cookie, and anything else is no choice", () => {
		assert.equal(CONSENT_COOKIE, "fs_consent");
		assert.equal(readConsent("fs_consent=accepted"), ACCEPTED);
		assert.equal(readConsent("theme=dark; fs_consent=declined; tz=UTC"), DECLINED);
		for (const value of ["", undefined, null, "fs_consent=maybe", "fs_consent=", "fs_consent_old=accepted", "xfs_consent=accepted", "other=fs_consent=accepted"]) {
			assert.equal(readConsent(value), null, String(value));
		}
	});

	test("decides the status: on, ask or off", () => {
		assert.equal(getAnalyticsStatus({ requiresConsent: true, consent: null }), "ask");
		assert.equal(getAnalyticsStatus({ requiresConsent: true, consent: ACCEPTED }), "on");
		assert.equal(getAnalyticsStatus({ requiresConsent: true, consent: DECLINED }), "off");
		assert.equal(getAnalyticsStatus({ requiresConsent: false, consent: null }), "on");
		assert.equal(getAnalyticsStatus({ requiresConsent: false, consent: DECLINED }), "off");
		assert.equal(getAnalyticsStatus({ requiresConsent: false, consent: ACCEPTED }), "on");
	});

	test("the server's decision for each kind of visitor", () => {
		const ask = (country, consent, env) => decideAnalytics({ country, consent, env });
		assert.equal(ask("DE", null, US).status, "ask");
		assert.equal(ask("GB", ACCEPTED, US).status, "on");
		assert.equal(ask("CH", DECLINED, US).status, "off");
		assert.equal(ask("US", null, US).status, "on");
		assert.equal(ask("US", DECLINED, US).status, "off");
		assert.equal(ask("US", null, EU).status, "ask");
		assert.equal(ask("US", ACCEPTED, EU).status, "on");
		assert.deepEqual(ask("US", null, US), { show: true, requiresConsent: false, consent: null, status: "on" });
	});

	test("is kept for twelve months in a first-party cookie: Lax, Secure, on the whole site", () => {
		assert.equal(CONSENT_MAX_AGE, 365 * 24 * 3600);
		assert.equal(serializeConsentCookie(ACCEPTED), "fs_consent=accepted; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
		assert.equal(serializeConsentCookie(DECLINED), "fs_consent=declined; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
		assert.equal(serializeConsentCookie(DECLINED, { secure: false }), "fs_consent=declined; Max-Age=31536000; Path=/; SameSite=Lax");
		assert.doesNotMatch(serializeConsentCookie(ACCEPTED), /Domain=|HttpOnly/);
		assert.throws(() => serializeConsentCookie("yes"));
		assert.equal(readConsent(serializeConsentCookie(ACCEPTED).split(";")[0]), ACCEPTED);
	});
});

describe("declining", () => {
	test("deletes every ph_ cookie and storage key, and nothing else", () => {
		const document = fakeDocument({
			fs_consent: "declined",
			theme: "dark",
			ph_phc_example_posthog: "%7B%7D",
			__ph_opt_in_out_phc_example: "0",
			tz: "UTC",
		});
		const local = fakeStorage({ ph_phc_example_posthog: "{}", __ph_opt_in_out_phc_example: "1", theme: "dark", "ph-like": "kept" });
		const session = fakeStorage({ ph_phc_example_window_id: "x", flash: "kept" });
		clearAnalyticsStorage({ document, storages: [local, session], hostname: "eu.flockstack.io" });
		assert.deepEqual([...document.jar.keys()], ["fs_consent", "theme", "tz"]);
		assert.deepEqual([...local.map.keys()], ["theme", "ph-like"]);
		assert.deepEqual([...session.map.keys()], ["flash"]);
	});

	test("tries the host and its parent domain, since PostHog can set the cookie on either", () => {
		const document = fakeDocument({ ph_phc_example_posthog: "x" });
		clearAnalyticsStorage({ document, hostname: "eu.flockstack.io" });
		assert.equal(document.writes.length, 3);
		assert.ok(document.writes.every((line) => line.startsWith("ph_phc_example_posthog=; Max-Age=0")));
		assert.ok(document.writes.some((line) => line.endsWith("Path=/")));
		assert.ok(document.writes.some((line) => line.endsWith("Domain=eu.flockstack.io")));
		assert.ok(document.writes.some((line) => line.endsWith("Domain=flockstack.io")));
		assert.deepEqual(cookieDomains("flockstack.io"), ["flockstack.io"]);
		assert.deepEqual(cookieDomains("localhost"), ["localhost"]);
		assert.deepEqual(cookieDomains("127.0.0.1"), ["127.0.0.1"]);
		assert.deepEqual(cookieDomains(""), []);
	});

	test("keeps PostHog's opt-out flag for the running page when asked, so the live client stays quiet", () => {
		const document = fakeDocument({ ph_phc_example_posthog: "x", __ph_opt_in_out_phc_example: "0" });
		const local = fakeStorage({ ph_phc_example_posthog: "{}", __ph_opt_in_out_phc_example: "0" });
		clearAnalyticsStorage({ document, storages: [local], hostname: "flockstack.io", keepOptOut: true });
		assert.deepEqual([...document.jar.keys()], ["__ph_opt_in_out_phc_example"]);
		assert.deepEqual([...local.map.keys()], ["__ph_opt_in_out_phc_example"]);
	});

	test("survives blocked storage", () => {
		const blocked = {
			get length() {
				throw new Error("SecurityError");
			},
		};
		assert.doesNotThrow(() => clearAnalyticsStorage({ document: fakeDocument({}), storages: [blocked], hostname: "flockstack.io" }));
	});
});

describe("the project key and host", () => {
	test("with no key, or a malformed one, there is nothing to load", () => {
		for (const POSTHOG_KEY of [undefined, "", "  ", "short", "has space in it", "<script>"]) assert.equal(readAnalyticsEnv({ POSTHOG_KEY }), null, String(POSTHOG_KEY));
	});

	test("the host is PostHog US Cloud unless POSTHOG_HOST is another https address", () => {
		const key = "phc_exampleprojectkey0123456789";
		assert.deepEqual(readAnalyticsEnv({ POSTHOG_KEY: key }), { token: key, host: "https://us.i.posthog.com", replay: false });
		assert.equal(readAnalyticsEnv({ POSTHOG_KEY: key, POSTHOG_HOST: "https://eu.i.posthog.com/" }).host, "https://eu.i.posthog.com");
		assert.equal(readAnalyticsEnv({ POSTHOG_KEY: key, POSTHOG_HOST: "https://ph.example.com/path?x=1" }).host, "https://ph.example.com");
		for (const POSTHOG_HOST of ["http://us.i.posthog.com", "not a url", "https://user:pass@ph.example.com", "javascript:alert(1)"]) {
			assert.equal(readAnalyticsEnv({ POSTHOG_KEY: key, POSTHOG_HOST }).host, "https://us.i.posthog.com", POSTHOG_HOST);
		}
	});

	test("session recording is off unless POSTHOG_SESSION_REPLAY is exactly true", () => {
		const POSTHOG_KEY = "phc_exampleprojectkey0123456789";
		for (const value of [undefined, "", "false", "1", "yes", "off"]) assert.equal(readAnalyticsEnv({ POSTHOG_KEY, POSTHOG_SESSION_REPLAY: value }).replay, false, String(value));
		assert.equal(readAnalyticsEnv({ POSTHOG_KEY, POSTHOG_SESSION_REPLAY: "true" }).replay, true);
		assert.equal(readAnalyticsEnv({ POSTHOG_KEY, POSTHOG_SESSION_REPLAY: " TRUE " }).replay, true);
	});
});
