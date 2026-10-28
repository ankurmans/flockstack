// Before and after of an issue's visuals (docs/VISUALS-DESIGN.md), for development only: given an issue's Markdown and a
// newsletter's settings, writes the email as it was (no card, icons or publisher line), the email now, the email now with its
// images stripped (as a reader with images off sees it), the issue's share card and the section icons it uses, and prints the
// HTML sizes. Nothing is stored or sent; the logo is read from a local file.
//   node --import ./tests/setup/register.mjs scripts/visuals-preview.mjs --markdown issue.md --settings newsletter.json --out dir \
//     [--subject "Title"] [--logo logo.png] [--date 2026-10-28]
// newsletter.json: { name, slug, accentColor, imageUrl, archiveHost, description, brand: { publisher, headerUrl, fontPair, emailLogo, issueCard } }
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		markdown: { type: "string" },
		settings: { type: "string" },
		out: { type: "string" },
		subject: { type: "string", default: "Coastal rates climb as inland capacity loosens" },
		logo: { type: "string" },
		date: { type: "string", default: new Date().toISOString().slice(0, 10) },
	},
});
if (!values.markdown || !values.settings || !values.out) {
	console.error("Usage: node --import ./tests/setup/register.mjs scripts/visuals-preview.mjs --markdown issue.md --settings newsletter.json --out dir");
	process.exit(1);
}
process.env.APP_URL ??= "https://flockstack.io";
process.env.BETTER_AUTH_SECRET ??= "visuals-preview-only-not-a-real-secret-0000";

const { renderEmail } = await import("../lib/render-email.js");
const { getEmailCard, getEmailIconUrl } = await import("../lib/issue-card.js");
const { getCardInputs } = await import("../lib/share-card.js");
const { drawSectionIcon, drawShareCard } = await import("../lib/card-images.jsx");
const { remoteImages } = await import("../tests/stubs/remote-image.mjs");

const markdown = await readFile(values.markdown, "utf8");
const settings = JSON.parse(await readFile(values.settings, "utf8"));
const newsletter = { _id: "000000000000000000000001", slug: "preview", ...settings };
if (values.logo && newsletter.imageUrl) remoteImages.set(newsletter.imageUrl, new Uint8Array(await readFile(values.logo)));
const campaign = {
	_id: "000000000000000000000002",
	newsletterId: newsletter._id,
	subject: values.subject,
	format: "markdown",
	markdown,
	startedAt: new Date(`${values.date}T12:00:00Z`),
	issueCard: true,
};
const common = { format: "markdown", markdown, subject: campaign.subject, previewText: "", webUrl: "https://example.com/p/preview", assetBase: process.env.APP_URL };
const before = renderEmail({ ...common, newsletter: { ...newsletter, brand: { ...newsletter.brand, publisher: "" } } });
const after = renderEmail({ ...common, newsletter, issueCard: getEmailCard({ newsletter, campaign }), sectionIconUrl: (key) => getEmailIconUrl(newsletter, key) });
const imagesOff = after.html.replace(/<img\b[^>]*>/gi, "");

await mkdir(join(values.out, "icons"), { recursive: true });
await writeFile(join(values.out, "email-before.html"), before.html);
await writeFile(join(values.out, "email-after.html"), after.html);
await writeFile(join(values.out, "email-after-images-off.html"), imagesOff);
const inputs = getCardInputs(newsletter, campaign);
await writeFile(join(values.out, "card.png"), await drawShareCard(inputs));
await writeFile(join(values.out, "card-home.png"), await drawShareCard(getCardInputs(newsletter, null)));
const color = getEmailIconUrl(newsletter, "generic").split("?c=")[1];
const keys = [...new Set([...after.html.matchAll(/\/icon\/([a-z-]+)\.png/g)].map((match) => match[1]))];
for (const key of keys) await writeFile(join(values.out, "icons", `${key}.png`), await drawSectionIcon(key, `#${color}`));

console.log(`email before: ${before.bytes} bytes`);
console.log(`email after: ${after.bytes} bytes (+${after.bytes - before.bytes})`);
console.log(`card icons: ${inputs.icons.join(", ") || "none"}; section icons in the email: ${keys.length}`);
console.log(`wrote ${values.out}`);
