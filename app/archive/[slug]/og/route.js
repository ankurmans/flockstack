import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { FALLBACK_CARD_PNG, drawShareCard } from "@/lib/card-images";
import { connectDb } from "@/lib/db";
import { isCardSignature } from "@/lib/issue-card";
import { getRenderedImage } from "@/lib/rendered-images";
import { getCardInputs, getCardKey, hashCardInputs } from "@/lib/share-card";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

const OBJECT_ID = /^[a-f0-9]{24}$/i;
// The address names the card's content (v=<hash>), so a card asked for by its hash never changes.
const IMMUTABLE = "public, max-age=31536000, immutable";
const CURRENT = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
const FALLBACK = "public, max-age=300";
const NEWSLETTER_FIELDS = "accountId name slug archiveHost mount imageUrl description accentColor brand privateArchive";
const ISSUE_FIELDS = "subject format markdown html startedAt sentAt";

function png(bytes, cacheControl) {
	return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": cacheControl } });
}

// An email's card (lib/issue-card.js): its campaign by ID with the link's signature, whatever its status, so a draft's test email
// and an email only issue have one; the newsletter needs no website for it.
async function loadEmailCard(slug, campaignId, signature) {
	if (!OBJECT_ID.test(campaignId ?? "")) return null;
	await connectDb();
	const newsletter = await Newsletter.findOne({ slug }).setOptions({ crossAccount: true }).select(NEWSLETTER_FIELDS).lean();
	if (!newsletter || !isCardSignature({ newsletterId: newsletter._id, campaignId }, signature)) return null;
	const issue = await Campaign.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, _id: campaignId }).select(ISSUE_FIELDS).lean();
	return issue ? { newsletter, issue } : null;
}

// A shared page's card: the newsletter's, or an issue's on its public website. A private website's issues share its own card.
async function loadPageCard(slug, postSlug) {
	const newsletter = await getArchiveNewsletter(slug);
	if (!newsletter) return null;
	if (!postSlug || newsletter.privateArchive) return { newsletter, issue: null };
	const issue = await getArchiveIssue(newsletter, postSlug);
	return issue ? { newsletter, issue } : null;
}

async function drawStored(newsletter, inputs) {
	const hash = hashCardInputs(inputs);
	const { bytes } = await getRenderedImage(getCardKey(newsletter._id, hash), () => drawShareCard(inputs));
	return { bytes, hash };
}

// The share card of the archive home and of each issue without a picture of its own (docs/VISUALS-DESIGN.md): drawn once, kept
// in the IMAGES bucket by the hash of what it shows. A card that can't be drawn answers the newsletter's own card, and that failing
// a plain gray one: a social preview or an email never gets an error for an image.
export async function GET(request, { params }) {
	const { slug } = await params;
	const search = new URL(request.url).searchParams;
	const loaded = search.has("c") ? await loadEmailCard(slug, search.get("c"), search.get("s")) : await loadPageCard(slug, search.get("p"));
	if (!loaded) return new Response("Not found", { status: 404 });
	const { newsletter, issue } = loaded;

	try {
		const { bytes, hash } = await drawStored(newsletter, getCardInputs(newsletter, issue));
		return png(bytes, search.get("v") === hash ? IMMUTABLE : CURRENT);
	} catch (error) {
		console.error(`The share card of ${slug} couldn't be drawn`, error);
	}
	try {
		if (issue) return png((await drawStored(newsletter, getCardInputs(newsletter, null))).bytes, FALLBACK);
	} catch (error) {
		console.error(`The default share card of ${slug} couldn't be drawn`, error);
	}
	return png(FALLBACK_CARD_PNG, FALLBACK);
}
