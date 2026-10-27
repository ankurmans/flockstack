import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FieldsSponsorCreative from "../components/FieldsSponsorCreative.jsx";
import PanelSponsorshipReport from "../components/PanelSponsorshipReport.jsx";
import { getReaderText, READER_LANGUAGES } from "../lib/reader-languages.js";
import { getSponsorshipEmailCopy } from "../lib/sponsorship-email-copy.js";
import { renderSponsorshipBlocks, sponsorshipBlockHtml } from "../lib/sponsorship-blocks.js";
import { hasContent } from "../lib/render-email.js";
const creative = { headline: "KEEP_AUTHORED_HEADLINE", body: "KEEP_AUTHORED_BODY", callToAction: "KEEP_AUTHORED_CTA", url: "https://example.com/sponsor", assetId: null };
test("sponsor controls, disclosure and private emails use all six languages while preserving authored creative", () => {
	for (const language of READER_LANGUAGES) {
		const t = getReaderText(language);
		const fields = renderToStaticMarkup(h(FieldsSponsorCreative, { language, creative })); assert.ok(fields.includes(t("Headline"))); assert.ok(fields.includes(t("Sponsor copy"))); assert.match(fields, /KEEP_AUTHORED_BODY/);
		const report = renderToStaticMarkup(h(PanelSponsorshipReport, { language, report: { issues: [] } })); assert.ok(report.includes(t("Observed delivery and clicks")));
		const block = sponsorshipBlockHtml({ id: "1".repeat(24), hash: "a".repeat(64), language, creative, imageUrl: null });
		assert.equal(hasContent(block), true); const html = renderSponsorshipBlocks(block); assert.ok(html.includes(t("Sponsored"))); assert.match(html, /KEEP_AUTHORED_HEADLINE/);
		const booking = { _id: "2".repeat(24), placementName: "KEEP_PLACEMENT", day: "2026-11-20", timeZone: "Europe/Paris" }, newsletter = { name: "KEEP_NEWSLETTER", language };
		for (const kind of ["verify", "manager", "invoice"]) {
			const copy = getSponsorshipEmailCopy(newsletter, booking, kind, "https://example.com/private-link");
			assert.ok(copy.markdown.includes("https://example.com/private-link")); assert.equal(copy.reason, t("This email concerns your newsletter sponsorship request. It does not subscribe you."));
			assert.ok(copy.markdown.includes(kind === "verify" ? t("Confirm my sponsorship request") : kind === "manager" ? t("Manage my sponsorship") : t("Review invoice in Stripe")));
		}
	}
});
