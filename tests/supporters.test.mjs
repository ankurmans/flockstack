import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, startTestApp } from "./helpers/app.mjs";
import { addReader, addTier, completeCheckout, listTiers, readerOf, setTier, subscribe, subscribeAndPay } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe } from "./helpers/shop.mjs";

// The founding or supporter tier: the same content for more money, shown as a way to back the writer, with an optional cap
// on members and an optional public list of the names they gave, off unless the writer turns it on.
let app;
let m;
let fake;
let counter = 0;

const seller = (options = {}) => createSeller(`founders${++counter}@example.com`, { fake, ...options });

async function render(user) {
	const element = await anonymous(() => m.subscribePage({ params: Promise.resolve({ slug: user.slug }) }));
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "Notes", slug: "notes" }, readers: 0 }, element));
}

const nameField = (value) => [{ key: "supportername", type: "text", text: { value } }];

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		subscribePage: (await import("../app/archive/[slug]/subscribe/page.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		Contact: (await import("../models/Contact.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

describe("the founding tier", () => {
	async function founders(cap = 2) {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Founding member", description: "Back the writing", yearlyCents: 25000, founding: { enabled: true, cap } });
		return { user, tier };
	}

	test("is a tier flagged founding, shown as a way to back the writer with the spots left", async () => {
		const { user, tier } = await founders(5);
		assert.deepEqual(tier.founding, { enabled: true, cap: 5, taken: 0, spotsLeft: 5 });
		const page = await render(user);
		assert.match(page, /Founding member/);
		assert.match(page, /5 spots left/);

		const plain = (await listTiers(user)).find(({ name }) => name === "Paid subscription");
		assert.deepEqual(plain.founding, { enabled: false, cap: null, taken: 0, spotsLeft: null });
	});

	test("takes members up to its cap, then refuses more and leaves the other tiers open", async () => {
		const { user, tier } = await founders(2);
		await subscribeAndPay(fake, user, { tier: tier.id, option: "year", email: "one@example.net" }, { interval: "year" });
		assert.equal((await listTiers(user)).find(({ id }) => id === tier.id).founding.spotsLeft, 1);
		await subscribeAndPay(fake, user, { tier: tier.id, option: "year", email: "two@example.net" }, { interval: "year" });
		const full = (await listTiers(user)).find(({ id }) => id === tier.id);
		assert.deepEqual([full.founding.taken, full.founding.spotsLeft], [2, 0]);

		assert.deepEqual(await subscribe(user, { tier: tier.id, option: "year", email: "three@example.net" }), { error: "All 2 founding spots are taken" });
		assert.doesNotMatch(await render(user), /Founding member/, "no longer for sale");
		assert.ok((await subscribe(user, { tier: "paid", option: "month", email: "three@example.net" })).url, "the other tier is open");
	});

	test("a member who leaves frees their spot", async () => {
		const { user, tier } = await founders(1);
		const { subscription } = await subscribeAndPay(fake, user, { tier: tier.id, option: "year", email: "one@example.net" }, { interval: "year" });
		assert.ok((await subscribe(user, { tier: tier.id, option: "year", email: "two@example.net" })).error);
		await m.Contact.updateOne({ accountId: user.accountId, email: "one@example.net" }, { $set: { paidUntil: new Date(Date.now() - 10 * 86_400_000) } });
		assert.ok((await subscribe(user, { tier: tier.id, option: "year", email: "two@example.net" })).url);
		void subscription;
	});

	test("a tier with no cap never fills", async () => {
		const { user, tier } = await founders(null);
		await addReader(m, user, "x@example.net", { tier: "paid", paidTierId: tier.id, paidUntil: new Date(Date.now() + 86_400_000 * 20) });
		assert.ok((await subscribe(user, { tier: tier.id, option: "year" })).url);
		assert.equal((await listTiers(user)).find(({ id }) => id === tier.id).founding.spotsLeft, null);
	});

	test("the cap can change, and founding can be turned off", async () => {
		const { user, tier } = await founders(1);
		const raised = await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { founding: { cap: 10 } });
		assert.deepEqual([raised.body.founding.enabled, raised.body.founding.cap], [true, 10]);
		const off = await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { founding: { enabled: false } });
		assert.equal(off.body.founding.enabled, false);
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { founding: { cap: 0 } }), 400, "validation_failed");
	});
});

describe("the supporters list", () => {
	async function listed({ publicList = true } = {}) {
		const user = await seller();
		await setTier(user, { supportersPublic: publicList });
		const tier = await addTier(user, { name: "Supporter", yearlyCents: 12000, founding: { enabled: true } });
		return { user, tier };
	}

	test("is off by default: no name is asked for and none is shown", async () => {
		const { user, tier } = await listed({ publicList: false });
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/paid-tier`)).body.supportersPublic, false);
		await subscribe(user, { tier: tier.id, option: "year" });
		const session = [...fake.sessions.values()].at(-1);
		assert.equal(session.custom_fields, undefined);
		const { result } = await completeCheckout(fake, user, session.url, { email: "quiet@example.net", interval: "year", customFields: nameField("Sneaky") });
		assert.equal(result.status, 200);
		assert.doesNotMatch(await render(user), /Supporters/);
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/supporters`)).body.publicList, false);
	});

	test("when on, a founding member can give a name in Checkout, and only that name is shown", async () => {
		const { user, tier } = await listed();
		await subscribe(user, { tier: tier.id, option: "year" });
		const session = [...fake.sessions.values()].at(-1);
		assert.deepEqual(session.custom_fields[0].key, "supportername");
		assert.equal(session.custom_fields[0].optional, "true");
		await completeCheckout(fake, user, session.url, { email: "ada@example.net", interval: "year", customFields: nameField("Ada <b>Lovelace</b>") });
		await subscribeAndPay(fake, user, { tier: tier.id, option: "year", email: "private@example.net" }, { interval: "year" });

		const page = await render(user);
		assert.match(page, /Supporters/);
		assert.match(page, /Ada bLovelace\/b/, "markup characters are dropped");
		assert.doesNotMatch(page, /ada@example\.net|private@example\.net|private/i, "never an email, and nobody without a name");
		assert.equal((await readerOf(m, user, "ada@example.net")).supporterName, "Ada bLovelace/b");
	});

	test("only a founding tier asks for a name", async () => {
		const { user } = await listed();
		await subscribe(user, { tier: "paid", option: "month" });
		assert.equal([...fake.sessions.values()].at(-1).custom_fields, undefined);
	});

	test("a lifetime founding member can be listed too", async () => {
		const user = await seller();
		await setTier(user, { supportersPublic: true });
		const tier = await addTier(user, { name: "Patron", lifetimeCents: 90000, founding: { enabled: true } });
		await subscribe(user, { tier: tier.id, option: "lifetime" });
		const session = [...fake.sessions.values()].at(-1);
		await completeCheckout(fake, user, session.url, { email: "life@example.net", customFields: nameField("Grace Hopper") });
		assert.match(await render(user), /Grace Hopper/);
	});

	test("the writer sees the members and can take a name off the list", async () => {
		const { user, tier } = await listed();
		await subscribe(user, { tier: tier.id, option: "year" });
		await completeCheckout(fake, user, [...fake.sessions.values()].at(-1).url, { email: "ada@example.net", interval: "year", customFields: nameField("Ada") });
		await subscribeAndPay(fake, user, { tier: tier.id, option: "year", email: "bob@example.net" }, { interval: "year" });

		const { body } = await api(user, "GET", `/newsletters/${user.slug}/supporters`);
		assert.equal(body.publicList, true);
		assert.deepEqual(body.supporters.map(({ email, name, listed: isListed }) => [email, name, isListed]), [["ada@example.net", "Ada", true], ["bob@example.net", null, false]]);

		const ada = body.supporters[0];
		const hidden = await api(user, "PATCH", `/newsletters/${user.slug}/supporters/${ada.contactId}`, { name: null });
		assert.deepEqual([hidden.body.name, hidden.body.listed], [null, false]);
		assert.doesNotMatch(await render(user), /Ada/);
		const renamed = await api(user, "PATCH", `/newsletters/${user.slug}/supporters/${ada.contactId}`, { name: "A. L." });
		assert.equal(renamed.body.listed, true);
		assert.match(await render(user), /A\. L\./);
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/supporters/6650f1c2e9b1d4a012345678`, { name: "x" }), 404, "not_found");

		await setTier(user, { supportersPublic: false });
		assert.doesNotMatch(await render(user), /A\. L\./, "turning the list off hides every name");
	});

	test("belongs to the newsletter's account only", async () => {
		const { user } = await listed();
		const stranger = await seller();
		assertError(await api(stranger, "GET", `/newsletters/${user.slug}/supporters`), 404, "not_found");
	});
});
