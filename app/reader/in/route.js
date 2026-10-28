import { NextResponse } from "next/server";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { getMountHandoffUrl, signInWithEmailLink } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

export const dynamic = "force-dynamic";

// The "Discuss this issue" link in a newsletter's emails: the signed link signs the reader in, and the page lands on the
// issue's comments. The token never stays in the address bar. A link that doesn't work lands there too, signed out, with
// the hash saying why, so the page can offer the email sign-in instead.
export async function GET(request) {
	const { searchParams } = request.nextUrl;
	const token = searchParams.get("token");
	const issueSlug = searchParams.get("p") ?? "";
	const comment = /^[a-f0-9]{24}$/i.test(searchParams.get("c") ?? "") ? searchParams.get("c") : null;

	let result = {};
	try {
		await connectDb();
		const handoff = await getMountHandoffUrl("email", token, "/reader/in", request.nextUrl.search);
		if (handoff) return noStore(NextResponse.redirect(handoff, 303));
		result = await signInWithEmailLink(token);
	} catch (error) {
		console.error("[reader] Could not use the email link:", error.message);
	}
	const { newsletter } = result;
	const destination = newsletter && ARCHIVE_SLUG_PATTERN.test(issueSlug)
		? getArchiveUrls(newsletter).absolutePost(issueSlug)
		: newsletter
			? getArchiveUrls(newsletter).siteIndex
			: new URL("/", request.url).toString();
	const hash = result.contact ? (comment ? `#comment-${comment}` : "#comments") : "#comments-expired";
	return noStore(NextResponse.redirect(new URL(`${destination}${hash}`, request.url), 303));
}

function noStore(response) {
	response.headers.set("Cache-Control", "no-store");
	return response;
}
