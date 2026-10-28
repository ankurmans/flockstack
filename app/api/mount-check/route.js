import { NextResponse } from "next/server";
import { MOUNT_MATCH_HEADER, MOUNT_PATH_HEADER, MOUNT_SLUG_HEADER } from "@/lib/mount-rules";
import { signMountProof } from "@/lib/mounts";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

// <mount>/.well-known/flockstack-mount, which proxy.js sends here once the request's token matched (and answers itself when it
// didn't). check_newsletter_mount asks it through the owner's site with a challenge and checks the signature (lib/mounts.js).
export async function GET(request) {
	const slug = request.headers.get(MOUNT_SLUG_HEADER);
	const path = request.headers.get(MOUNT_PATH_HEADER);
	const matched = request.headers.get(MOUNT_MATCH_HEADER);
	if (!slug || !path || !matched) return NextResponse.json({ mounted: false, reason: "missing_token" }, { status: 403, headers: NO_STORE });
	const challenge = request.nextUrl.searchParams.get("challenge") ?? "";
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(challenge)) return NextResponse.json({ mounted: true, newsletter: slug, path, token: matched }, { headers: NO_STORE });
	return NextResponse.json({ mounted: true, newsletter: slug, path, token: matched, challenge, signature: signMountProof({ slug, path, matched, challenge }) }, { headers: NO_STORE });
}
