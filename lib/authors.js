import { emitRecordEvent } from "@/lib/record-events";
import "server-only";
import { randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { revalidateArchive } from "@/lib/archive-data";
import { getArchiveAuthor } from "@/lib/archive-author";
import { slugify } from "@/lib/slug";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

export const MAX_AUTHORS = 50;
export function listAuthors(newsletter) {
	return { revision: newsletter.authorsRevision ?? 0, authors: [{ ...getArchiveAuthor(newsletter), id: "default", archived: false }, ...(newsletter.authors ?? [])] };
}

async function saveAuthors(account, newsletter, authors, type, id) {
	const revision = newsletter.authorsRevision ?? 0;
	const version = revision ? { authorsRevision: revision } : { $or: [{ authorsRevision: 0 }, { authorsRevision: { $exists: false } }] };
	const result = await Newsletter.updateOne(scoped(account, { _id: newsletter._id, ...version }), { $set: { authors, authorsRevision: revision + 1 } });
	if (!result.matchedCount) throw actionError("conflict", "The authors changed. Reload and try again.");
	await emitRecordEvent(type, { accountId: account._id, newsletterId: newsletter._id, id });
	revalidateArchive(newsletter.slug);
	return listAuthors({ ...newsletter, authors, authorsRevision: revision + 1 });
}

export async function upsertAuthor(account, newsletter, input) {
	const authors = [...(newsletter.authors ?? [])];
	const index = input.id ? authors.findIndex(({ id }) => id === input.id) : -1;
	if (input.id && index < 0) throw actionError("not_found", "Author not found");
	if (index < 0 && authors.length >= MAX_AUTHORS) throw actionError("conflict", `A newsletter can have ${MAX_AUTHORS} guest authors`);
	const previous = authors[index];
	const slug = input.slug || previous?.slug || slugify(input.name, 60);
	if (!slug || listAuthors(newsletter).authors.some((author) => author.slug === slug && author.id !== previous?.id)) throw actionError("validation_failed", "Choose a unique author slug");
	const author = { id: previous?.id ?? randomUUID(), slug, name: input.name, bio: input.bio ?? previous?.bio ?? "", imageUrl: input.imageUrl ?? previous?.imageUrl ?? "", archived: previous?.archived ?? false };
	if (index < 0) authors.push(author); else authors[index] = author;
	return saveAuthors(account, newsletter, authors, previous ? "author.updated" : "author.created", author.id);
}

export async function archiveAuthor(account, newsletter, id, archived) {
	if (!(newsletter.authors ?? []).some((author) => author.id === id)) throw actionError("not_found", "Guest author not found");
	return saveAuthors(account, newsletter, newsletter.authors.map((author) => author.id === id ? { ...author, archived } : author), archived ? "author.archived" : "author.updated", id);
}

export async function setIssueAuthor(account, campaign, newsletter, authorId) {
	if (!["draft", "scheduled", "sent"].includes(campaign.status) || campaign.abTest?.status === "testing") throw actionError("conflict", "Wait until the send and subject test are over");
	if (authorId && authorId !== "default" && !(newsletter.authors ?? []).some((author) => author.id === authorId && !author.archived)) throw actionError("validation_failed", "Choose an active author from this newsletter");
	const id = authorId === "default" ? null : authorId;
	const result = await Campaign.updateOne(scoped(account, { _id: campaign._id, newsletterId: newsletter._id, status: campaign.status }), id ? { $set: { authorId: id } } : { $unset: { authorId: 1 } });
	if (!result.matchedCount) throw actionError("conflict", "The campaign changed. Reload and try again.");
	revalidateArchive(newsletter.slug);
	return { campaignId: String(campaign._id), authorId: id ?? null };
}

export async function authorChanges(account, newsletterId, authorId) {
	if (authorId === undefined) return {};
	if (!authorId || authorId === "default") return { authorId: null };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).lean();
	if (!(newsletter?.authors ?? []).some((author) => author.id === authorId && !author.archived)) throw actionError("validation_failed", "Choose an active author from this newsletter");
	return { authorId };
}

export async function copyIssueAuthor(account, campaign) {
	if (!campaign.authorId) return {};
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).select({ authors: 1 }).lean();
	return (newsletter?.authors ?? []).some((author) => author.id === campaign.authorId && !author.archived) ? { authorId: campaign.authorId } : {};
}
