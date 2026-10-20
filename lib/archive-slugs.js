import "server-only";
import { slugify } from "@/lib/slug";
import Campaign from "@/models/Campaign";
import SitePage from "@/models/SitePage";

// Slugs are unique across accounts (/p/<slug> on the app's domain), so the check looks at every account. With a
// newsletterId, a slug that one of its custom pages has is taken too: pages share /p/ with its issues.
export async function isArchiveSlugTaken(slug, { exceptId, newsletterId } = {}) {
	const filter = { archiveSlug: slug, ...(exceptId && { _id: { $ne: exceptId } }) };
	if (await Campaign.exists(filter).setOptions({ crossAccount: true })) return true;
	return Boolean(newsletterId && (await SitePage.exists({ newsletterId, slug }).setOptions({ crossAccount: true })));
}

export async function uniqueArchiveSlug(base, { newsletterId } = {}) {
	for (let suffix = 1; suffix < 100; suffix += 1) {
		const slug = suffix === 1 ? base : `${base}-${suffix}`;
		if (!(await isArchiveSlugTaken(slug, { newsletterId }))) return slug;
	}
	return `${base}-${Date.now()}`;
}

// Unless the API set one, the slug comes from the subject as it is when the issue goes out, so the
// /p/ page exists before the first email links to it.
export async function assignArchiveSlug({ campaign, newsletter }) {
	if (!newsletter.archiveEnabled || campaign.archiveSlug) return;
	await Campaign.updateOne(
		{ accountId: campaign.accountId, _id: campaign._id },
		{ $set: { archiveSlug: await uniqueArchiveSlug(slugify(campaign.subject, 80) || "issue", { newsletterId: newsletter._id }) } }
	);
}
