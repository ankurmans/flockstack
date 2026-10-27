import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { startTestApp } from "./helpers/app.mjs";
import { getReaderMessages, getReaderText, READER_LANGUAGES } from "../lib/reader-languages.js";
let app, Provider, Gift, Subscribe, Poll, Translation;
before(async () => {
	app = await startTestApp();
	Provider = (await import("../components/ProviderReaderLanguage.jsx")).default;
	Gift = (await import("../components/FormGiftRedeem.jsx")).default;
	Subscribe = (await import("../components/FormSubscribePaid.jsx")).default;
	Poll = (await import("../components/FormPollFollowUp.jsx")).default;
	Translation = (await import("../components/ReaderTranslation.jsx")).default;
});
after(() => app?.stop());
const render = (language, component, props) => renderToStaticMarkup(h(Provider, { language }, h(component, props)));
test("all six reader catalogs contain the same phrases and preserve interpolation variables", () => {
	const english = getReaderMessages("en");
	for (const language of READER_LANGUAGES) {
		const messages = getReaderMessages(language);
		for (const [key, value] of Object.entries(english)) {
			assert.ok(messages[key]?.trim(), `${language}: ${key}`);
			assert.deepEqual([...messages[key].matchAll(/\{[a-z]+\}/g)].map(([token]) => token).sort(), [...value.matchAll(/\{[a-z]+\}/g)].map(([token]) => token).sort(), `${language}: ${key}`);
		}
	}
});
test("standalone gift controls inherit each publication's language, leaving the personal message intact", () => {
	for (const language of READER_LANGUAGES) {
		const t = getReaderText(language);
		const html = render(language, Gift, { token: "synthetic", gift: { newsletterName: "Example newsletter", tierName: "Custom tier", from: "Alex", months: 3, message: "KEEP_THE_AUTHORED_MESSAGE", state: "sent", expiresAt: "2027-01-01", archiveUrl: "/archive/example" } });
		assert.ok(html.includes(`lang="${language}"`));
		assert.ok(html.includes(t("Redeem my gift"))); assert.match(html, /KEEP_THE_AUTHORED_MESSAGE/); assert.match(html, /Custom tier/);
		if (language !== "en") assert.doesNotMatch(html, /gave you|Your 3 months start|Redeem my gift/);
	}
});
test("checkout localizes plan controls, trial days and billing explanation, while tier copy stays authored", () => {
	const html = render("es", Subscribe, { newsletterSlug: "example", currency: "eur", trialDays: 7, tiers: [{ id: "custom", name: "Authored tier", description: "KEEP_CUSTOM_DESCRIPTION", founding: { enabled: false, spotsLeft: null }, benefits: ["KEEP_CUSTOM_BENEFIT"], options: [{ option: "month", label: "Monthly", cents: 800, note: "a month" }, { option: "year", label: "Yearly", cents: 8000, note: "a year" }] }] });
	assert.match(html, /Mensual/); assert.match(html, /prueba gratuita de 7 días/); assert.match(html, /KEEP_CUSTOM_DESCRIPTION/); assert.match(html, /KEEP_CUSTOM_BENEFIT/);
	assert.doesNotMatch(html, /Start your|You pay through Stripe/);
	const followUp = render("fr", Poll, { pollId: "synthetic", question: "KEEP_QUESTION", defaultValue: "" });
	assert.match(followUp, /KEEP_QUESTION/); assert.doesNotMatch(followUp, />Send</);
});
test("translation is an explicit reader action and never renders the model's text as HTML", async () => {
	assert.equal(renderToStaticMarkup(h(Translation, { enabled: false }, h("p", null, "Original"))), "<p>Original</p>");
	assert.equal(renderToStaticMarkup(h(Translation, { enabled: true, hasSession: false }, h("p", null, "Original"))), "<p>Original</p>");
	const html = render("es", Translation, { slug: "example", post: "issue", enabled: true, hasSession: true, language: "es", children: h("p", null, "Original") });
	assert.match(html, /Traducir/); assert.match(html, /Original/);
	const source = await readFile(new URL("../components/ReaderTranslation.jsx", import.meta.url), "utf8");
	assert.doesNotMatch(source, /dangerouslySetInnerHTML|useEffect/);
	assert.match(source, /\{answer\.text\}/);
});
test("reader billing controls translate all six languages and preserve the creator's offer name", async () => {
	const Billing = (await import("../components/PanelReaderBilling.jsx")).default;
	const initial = { status: "active", personalPaidUntil: null, pause: { state: null, canSchedule: true }, save: { available: true, offer: { name: "KEEP_CREATOR_OFFER", type: "percent", percentOff: 20, currency: "usd", duration: "repeating", durationMonths: 3, id: "synthetic", hash: "0".repeat(64) } }, cancellation: { canCancel: true, surveyEnabled: true } };
	for (const language of READER_LANGUAGES) {
		const html = renderToStaticMarkup(h(Billing, { initial, language, token: "synthetic-private-capability", action: async () => ({}) }));
		assert.match(html, /KEEP_CREATOR_OFFER/);
		if (language === "en") { assert.match(html, />Not reading<\/option>/); assert.match(html, />Price<\/option>/); }
		const t = getReaderText({ language }); assert.ok(html.includes(t("Cancel subscription"))); assert.ok(html.includes(t("Open Stripe billing")));
		if (language !== "en") assert.doesNotMatch(html, /Schedule pause|Share this feedback privately|Accept save offer/);
	}
});
