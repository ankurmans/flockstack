import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { enrollOnTagsAdded } from "@/lib/automation-triggers";
import { refuseWhileRemoving, removeFromContacts } from "@/lib/bulk-removal";
import { MAX_TAGS_PER_CONTACT, MAX_TAGS_PER_NEWSLETTER, MAX_TAG_LENGTH, normalizeTag } from "@/lib/tag-rules";
import { emitSubscriberUpdated } from "@/lib/webhooks";
import Contact from "@/models/Contact";
import Tag from "@/models/Tag";

// The distinct tags of a list, or a validation error naming the first that isn't one.
export function normalizeTags(values) {
	const tags = [];
	for (const value of values ?? []) {
		const tag = normalizeTag(value);
		if (!tag) {
			throw actionError(
				"validation_failed",
				`tags: "${String(value).slice(0, 50)}" isn't a valid tag: use letters, digits, spaces and - _ . : / + &, ${MAX_TAG_LENGTH} characters at most`
			);
		}
		if (!tags.includes(tag)) tags.push(tag);
	}
	return tags;
}

// Remembers the tags a newsletter uses, up to its limit.
export async function registerTags(account, newsletterId, tags) {
	if (tags.length === 0) return;
	const known = new Set((await Tag.find(scoped(account, { newsletterId, name: { $in: tags } })).select({ name: 1 }).lean()).map(({ name }) => name));
	const missing = tags.filter((tag) => !known.has(tag));
	if (missing.length === 0) return;
	await refuseWhileRemoving(account, { newsletterId, kind: "tag", names: missing });
	const count = await Tag.countDocuments(scoped(account, { newsletterId }));
	if (count + missing.length > MAX_TAGS_PER_NEWSLETTER) {
		throw actionError("validation_failed", `A newsletter has up to ${MAX_TAGS_PER_NEWSLETTER} tags: delete some you don't use`);
	}
	await Promise.all(missing.map((name) => Tag.updateOne(scoped(account, { newsletterId, name }), { $setOnInsert: { name } }, { upsert: true })));
}

// Adds tags to one contact. Returns the tags the contact now has and the ones it didn't have before.
export async function addTags(account, contact, input) {
	const tags = normalizeTags(input);
	if (tags.length === 0) return { tags: contact.tags ?? [], added: [] };
	const current = contact.tags ?? [];
	const fresh = tags.filter((tag) => !current.includes(tag));
	if (current.length + fresh.length > MAX_TAGS_PER_CONTACT) {
		throw actionError("validation_failed", `A contact has up to ${MAX_TAGS_PER_CONTACT} tags`);
	}
	await registerTags(account, contact.newsletterId, tags);
	const before = await Contact.findOneAndUpdate(scoped(account, { _id: contact._id }), { $addToSet: { tags } }, { returnDocument: "before" })
		.select({ tags: 1 })
		.lean();
	if (!before) throw actionError("not_found", "Contact not found");
	const had = new Set(before.tags ?? []);
	const added = tags.filter((tag) => !had.has(tag));
	const now = [...had, ...added];
	await enrollOnTagsAdded({ ...contact, tags: now }, added);
	await emitSubscriberUpdated({ ...contact, accountId: account._id ?? account }, { tagsAdded: added });
	return { tags: now, added };
}

export async function removeTags(account, contact, input) {
	const tags = normalizeTags(input);
	const before = await Contact.findOneAndUpdate(scoped(account, { _id: contact._id }), { $pull: { tags } }, { returnDocument: "before" })
		.select({ tags: 1 })
		.lean();
	if (!before) throw actionError("not_found", "Contact not found");
	const had = before.tags ?? [];
	const removed = tags.filter((tag) => had.includes(tag));
	await emitSubscriberUpdated({ ...contact, accountId: account._id ?? account }, { tagsRemoved: removed });
	return { tags: had.filter((tag) => !removed.includes(tag)), removed };
}

export async function listTagsWithCounts(account, newsletterId) {
	const tags = await Tag.find(scoped(account, { newsletterId })).sort({ name: 1 }).select({ name: 1, color: 1 }).lean();
	const counts = await Promise.all(tags.map(({ name }) => Contact.countDocuments(scoped(account, { newsletterId, tags: name }))));
	return tags.map(({ name, color }, index) => ({ name, color: color ?? null, contacts: counts[index] }));
}

// Takes the tag off every contact of the newsletter, in the background for a large list (lib/bulk-removal.js), and
// forgets it. Segments and automations that name it match nobody.
export async function deleteTag(account, newsletterId, name) {
	const { contacts, inBackground } = await removeFromContacts(account, { newsletterId, kind: "tag", name });
	const { deletedCount } = await Tag.deleteOne(scoped(account, { newsletterId, name }));
	return { removedFrom: contacts, inBackground, existed: deletedCount > 0 || contacts > 0 };
}
