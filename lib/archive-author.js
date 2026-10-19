import { slugify } from "./slug.js";

// One person writes each newsletter: the From name, with the photo and bio set on the newsletter.
export function getArchiveAuthor(newsletter) {
	const name = newsletter.fromName || newsletter.name;
	return {
		name,
		slug: slugify(name, 60) || "author",
		bio: newsletter.author?.bio || "",
		imageUrl: newsletter.author?.imageUrl || newsletter.imageUrl || "",
	};
}

// An imported issue keeps the name of whoever wrote it on the old platform, when that isn't the newsletter's author. They
// have no page here: slug is null.
export function getIssueAuthor(newsletter, issue) {
	const author = getArchiveAuthor(newsletter);
	const original = issue?.importedFrom?.author?.trim();
	if (!original || original.toLowerCase() === author.name.toLowerCase()) return author;
	return { name: original, slug: null, bio: "", imageUrl: "" };
}
