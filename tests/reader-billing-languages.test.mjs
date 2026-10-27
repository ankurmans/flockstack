import assert from "node:assert/strict";
import { test } from "node:test";
import { READER_LANGUAGES, getReaderText } from "../lib/reader-languages.js";
import { formatReaderBillingDate, readerBillingSummary, readerPledgeSummary, readerReferralSummary } from "../lib/reader-billing-copy.js";

test("all reader locales keep the same monthly, quarterly, yearly, lifetime, gift and complimentary access facts", () => {
	for (const language of READER_LANGUAGES) {
		const t = getReaderText(language);
		const paidUntil = "2027-02-03T23:30:00-05:00";
		const date = formatReaderBillingDate(language, paidUntil);
		for (const [interval, phrase] of [["month", "{membership}, billed every month"], ["quarter", "{membership}, billed every 3 months"], ["year", "{membership}, billed every year"]]) {
			const result = readerBillingSummary(language, { access: "stripe", interval, paidUntil, status: "active", tier: { id: "custom", name: "KEEP_TIER_NAME" } });
			assert.match(result.heading, /KEEP_TIER_NAME/);
			assert.equal(result.heading, t(phrase, { membership: t("{tier} subscriber", { tier: "KEEP_TIER_NAME" }) }));
			assert.ok(result.detail.includes(t("Your current period runs to {date}.", { date })));
			assert.ok(result.detail.includes(t("You read every issue of your tier on the website while you are signed in.")));
		}
		const lifetime = readerBillingSummary(language, { access: "stripe", interval: "lifetime", paidUntil: "2100-01-01", tier: { id: "paid" } });
		assert.equal(lifetime.heading, t("{membership}, paid once for life", { membership: t("Paid subscriber") }));
		assert.doesNotMatch(lifetime.detail, /2100/);
		for (const access of ["gift", "comp"]) {
			const result = readerBillingSummary(language, { access, interval: "lifetime", paidUntil });
			assert.ok(result.detail.includes(t("Your access runs to {date}.", { date })), "a grant keeps its actual deadline even beside an old lifetime interval");
		}
		const ended = readerBillingSummary(language, { access: "stripe", interval: "year", paidUntil, status: "canceled" });
		assert.ok(ended.detail.includes(t("Access until {date}.", { date })));
	}
});

test("missing dates and referral counts stay missing, and UTC dates do not shift with the runtime's local zone", () => {
	assert.equal(formatReaderBillingDate("en", null), null);
	assert.equal(formatReaderBillingDate("en", "invalid"), null);
	assert.equal(formatReaderBillingDate("en", "2027-02-03T23:30:00-05:00"), "Feb 4, 2027");
	assert.equal(formatReaderBillingDate("unsupported", "2027-02-04"), formatReaderBillingDate("en", "2027-02-04"));
	assert.equal(readerReferralSummary("fr", { count: null }), "");
	assert.equal(readerReferralSummary("fr", { count: -1 }), "");
	assert.doesNotMatch(readerBillingSummary("en", { access: "stripe", interval: "month", paidUntil: null }).detail, /Invalid|1970|null|undefined/);
});

test("pledge timing, referral pluralization and authored reward names remain distinct in each locale", () => {
	for (const language of READER_LANGUAGES) {
		const t = getReaderText(language);
		const base = { amount: "KEEP_AMOUNT", tierName: "KEEP_TIER_NAME" };
		const waiting = readerPledgeSummary(language, base);
		assert.ok(waiting.includes(t("We email you before the first charge.")));
		assert.match(waiting, /KEEP_AMOUNT/); assert.match(waiting, /KEEP_TIER_NAME/);
		const chargeAt = "2027-02-04T00:00:00Z";
		const dated = readerPledgeSummary(language, { ...base, chargeAt });
		assert.ok(dated.includes(t("Your first charge is on {date}.", { date: formatReaderBillingDate(language, chargeAt) })));
		const one = readerReferralSummary(language, { count: 1, next: { remaining: 1, title: "KEEP_REWARD" } });
		assert.ok(one.startsWith(t("1 person has signed up through your link.")));
		assert.ok(one.endsWith(t("1 more referral unlocks {reward}.", { reward: "KEEP_REWARD" })));
		const many = readerReferralSummary(language, { count: 2, next: { remaining: 3, title: "KEEP_REWARD" } });
		assert.ok(many.includes(t("{count} more referrals unlock {reward}.", { count: "3", reward: "KEEP_REWARD" })));
		if (language !== "en") assert.doesNotMatch(many, /people have signed up|more referrals unlock/);
	}
});

test("parameterized reader validation keeps its limits and authored fields, options and moderation reason", () => {
	for (const language of READER_LANGUAGES) {
		const t = getReaderText(language), number = (value) => new Intl.NumberFormat(language).format(value);
		assert.equal(t.error("Use 100 characters or fewer for your name."), t("Use {max} characters or fewer for your name.", { max: number(100) }));
		assert.equal(t.error("A comment can have up to 4,000 characters."), t("A comment can have up to {max} characters.", { max: number(4000) }));
		assert.equal(t.error("Pick a day within 365 days"), t("Pick a day within {days} days", { days: number(365) }));
		assert.ok(t.error("KEEP_FIELD must be one of KEEP_OPTION_ONE, KEEP_OPTION_TWO").includes("KEEP_OPTION_ONE, KEEP_OPTION_TWO"));
		assert.ok(t.error("KEEP_FIELD must be a number").includes("KEEP_FIELD"));
		assert.ok(t.error("Commenting is turned off for you: Keep this owner reason unchanged.").endsWith("Keep this owner reason unchanged."));
		assert.equal(t.error("An unmapped provider diagnostic."), "An unmapped provider diagnostic.");
		assert.ok(t.error("A comment can have up to 99999999999999999999999 characters.").includes("99999999999999999999999"), "an unsafe integer is not rounded into a different limit");
		if (language !== "en") assert.notEqual(t.error("You already posted this."), "You already posted this.");
	}
});
