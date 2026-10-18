import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_KEY_SCAN_REGEX, generateApiKey, getKeyRegion, hashApiKey, readBearerToken } from "../lib/api-key-tokens.js";
import {
	chooseRegion,
	getCookiePrefix,
	getOtherRegion,
	getRegion,
	getRegionForCountry,
	getRegionUrls,
	getSigninUrl,
	isEu,
	readCountry,
} from "../lib/region.js";

const EU = { FLOCKSTACK_REGION: "eu" };

describe("the region of a Worker", () => {
	test("FLOCKSTACK_REGION=eu is the EU; unset, empty or anything else is the US", () => {
		assert.equal(getRegion({}), "us");
		assert.equal(getRegion({ FLOCKSTACK_REGION: "" }), "us");
		assert.equal(getRegion({ FLOCKSTACK_REGION: "us" }), "us");
		assert.equal(getRegion({ FLOCKSTACK_REGION: "mars" }), "us");
		assert.equal(getRegion({ FLOCKSTACK_REGION: " EU " }), "eu");
		assert.equal(isEu(EU), true);
		assert.equal(isEu({}), false);
		assert.equal(getOtherRegion("us"), "eu");
		assert.equal(getOtherRegion("eu"), "us");
	});

	test("it reads the environment when asked, not when the module loads", () => {
		const previous = process.env.FLOCKSTACK_REGION;
		try {
			process.env.FLOCKSTACK_REGION = "eu";
			assert.equal(getRegion(), "eu");
			process.env.FLOCKSTACK_REGION = "us";
			assert.equal(getRegion(), "us");
		} finally {
			if (previous === undefined) delete process.env.FLOCKSTACK_REGION;
			else process.env.FLOCKSTACK_REGION = previous;
		}
	});

	test("the US keeps Better Auth's cookie names, the EU gets its own, so a browser signed in to both never mixes them", () => {
		assert.equal(getCookiePrefix({}), "better-auth");
		assert.equal(getCookiePrefix({ FLOCKSTACK_REGION: "us" }), "better-auth");
		assert.equal(getCookiePrefix(EU), "flockstack-eu");
		assert.notEqual(getCookiePrefix(EU), getCookiePrefix({}));
	});

	test("each region's address comes from REGION_URL_US and REGION_URL_EU, with FlockStack Cloud's as the default", () => {
		assert.deepEqual(getRegionUrls({}), { us: "https://flockstack.io", eu: "https://eu.flockstack.io" });
		assert.deepEqual(getRegionUrls({ REGION_URL_US: "https://us.example.com/", REGION_URL_EU: " https://eu.example.com " }), {
			us: "https://us.example.com",
			eu: "https://eu.example.com",
		});
		assert.deepEqual(getRegionUrls({ REGION_URL_EU: "" }).eu, "https://eu.flockstack.io");
	});
});

describe("the region a visitor starts on", () => {
	test("the EU, the other EEA countries, the UK and Switzerland start on the EU; everywhere else, and no country, on the US", () => {
		const eu = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(" ");
		assert.equal(eu.length, 32);
		for (const country of eu) assert.equal(getRegionForCountry(country), "eu", country);
		for (const country of ["US", "CA", "MX", "BR", "IN", "AU", "JP", "TR", "RU", "UA", "T1", "XX"]) assert.equal(getRegionForCountry(country), "us", country);
		assert.equal(getRegionForCountry("de"), "eu", "any case");
		assert.equal(getRegionForCountry(" nl "), "eu");
		assert.equal(getRegionForCountry(""), null);
		assert.equal(getRegionForCountry(undefined), null);
	});

	test("the country comes from Cloudflare's header, else the request's cf object", () => {
		assert.equal(readCountry(new Headers({ "cf-ipcountry": "FR" }), { country: "US" }), "FR");
		assert.equal(readCountry(new Headers(), { country: "DE" }), "DE");
		assert.equal(readCountry(new Headers(), undefined), null);
	});

	test("?region= wins, then the region cookie, then the country, then the Worker's own region", () => {
		assert.deepEqual(chooseRegion({ query: "us", cookie: "eu", country: "DE" }), { region: "us", source: "query" });
		assert.deepEqual(chooseRegion({ query: "eu", cookie: "us", country: "US" }), { region: "eu", source: "query" });
		assert.deepEqual(chooseRegion({ cookie: "us", country: "DE" }), { region: "us", source: "cookie" });
		assert.deepEqual(chooseRegion({ cookie: "eu", country: "US" }), { region: "eu", source: "cookie" });
		assert.deepEqual(chooseRegion({ country: "DE" }), { region: "eu", source: "country" });
		assert.deepEqual(chooseRegion({ country: "US" }), { region: "us", source: "country" });
		assert.deepEqual(chooseRegion({ env: EU }), { region: "eu", source: "deployment" });
		assert.deepEqual(chooseRegion({ env: {} }), { region: "us", source: "deployment" });
	});

	test("a query or cookie that names no region is ignored", () => {
		assert.deepEqual(chooseRegion({ query: "asia", cookie: "<script>", country: "FR" }), { region: "eu", source: "country" });
		assert.deepEqual(chooseRegion({ query: ["eu"], cookie: undefined, env: {} }), { region: "us", source: "deployment" });
	});
});

describe("the sign-in address of a region", () => {
	test("on the Worker's own region it is a path; for the other region, that region's address, with the choice and where to go next", () => {
		assert.equal(getSigninUrl("us", { env: {} }), "/signin?region=us");
		assert.equal(getSigninUrl("eu", { env: EU }), "/signin?region=eu");
		assert.equal(getSigninUrl("eu", { env: {} }), "https://eu.flockstack.io/signin?region=eu");
		assert.equal(getSigninUrl("us", { env: EU }), "https://flockstack.io/signin?region=us");
		assert.equal(getSigninUrl("eu", { next: "/campaigns/abc?tab=sent", env: {} }), "https://eu.flockstack.io/signin?region=eu&next=%2Fcampaigns%2Fabc%3Ftab%3Dsent");
		assert.equal(getSigninUrl("us", { next: "/", env: EU }), "https://flockstack.io/signin?region=us", "the dashboard is where sign-in goes anyway");
	});
});

describe("API keys", () => {
	test("a key made on the US Worker is the same mc_ key as before regions", () => {
		const { key, prefix, hash } = generateApiKey("us");
		assert.match(key, /^mc_[A-Za-z0-9_-]{43}$/);
		assert.equal(key.length, 46);
		assert.equal(prefix, `${key.slice(0, 10)}…`);
		assert.equal(hash, hashApiKey(key));
		assert.equal(getKeyRegion(key), "us");
	});

	test("a key made on the EU Worker starts with mc_eu_", () => {
		const { key, prefix } = generateApiKey("eu");
		assert.match(key, /^mc_eu_[A-Za-z0-9_-]{43}$/);
		assert.equal(key.length, 49);
		assert.equal(Buffer.from(key.slice(6), "base64url").length, 32);
		assert.equal(prefix, `${key.slice(0, 13)}…`);
		assert.equal(getKeyRegion(key), "eu");
	});

	test("the Worker's region picks the prefix", () => {
		const previous = process.env.FLOCKSTACK_REGION;
		try {
			process.env.FLOCKSTACK_REGION = "eu";
			assert.match(generateApiKey().key, /^mc_eu_/);
			delete process.env.FLOCKSTACK_REGION;
			assert.equal(generateApiKey().key.length, 46);
		} finally {
			if (previous === undefined) delete process.env.FLOCKSTACK_REGION;
			else process.env.FLOCKSTACK_REGION = previous;
		}
	});

	test("both formats are read as bearer tokens, and existing US keys, whatever their 43 characters, still validate", () => {
		const us = `mc_${"y".repeat(43)}`;
		const eu = `mc_eu_${"y".repeat(43)}`;
		assert.equal(readBearerToken(`Bearer ${us}`), us);
		assert.equal(readBearerToken(`Bearer ${eu}`), eu);
		// 43 random characters can spell "eu_" at the start: the length still says it is a US key.
		const lookalike = `mc_eu_${"z".repeat(40)}`;
		assert.equal(lookalike.length, 46);
		assert.equal(readBearerToken(`Bearer ${lookalike}`), lookalike);
		assert.equal(getKeyRegion(lookalike), "us");
		for (let index = 0; index < 200; index++) {
			const { key } = generateApiKey("us");
			assert.equal(readBearerToken(`Bearer ${key}`), key);
			assert.equal(getKeyRegion(key), "us");
		}
	});

	test("malformed keys of either region are refused", () => {
		for (const token of [`mc_eu_${"y".repeat(42)}`, `mc_eu_${"y".repeat(44)}`, `mc_eu${"y".repeat(43)}`, `mc_us_${"y".repeat(43)}`, `mc_EU_${"y".repeat(43)}`, `mc__eu_${"y".repeat(43)}`]) {
			assert.equal(readBearerToken(`Bearer ${token}`), null, token);
			assert.equal(getKeyRegion(token), null, token);
		}
		assert.equal(getKeyRegion(undefined), null);
	});

	test("the secret scanning expression finds both formats and nothing longer", () => {
		const regex = new RegExp(API_KEY_SCAN_REGEX, "g");
		const us = generateApiKey("us").key;
		const eu = generateApiKey("eu").key;
		assert.deepEqual(`FLOCKSTACK_API_KEY=${us}\nAuthorization: Bearer ${eu}.`.match(regex), [us, eu]);
		assert.equal(`${us}x`.match(regex), null, "a longer run is something else");
		assert.equal(`mc_${"a".repeat(42)}`.match(regex), null);
	});
});
