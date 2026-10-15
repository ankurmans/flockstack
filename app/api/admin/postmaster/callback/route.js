import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { STATE_COOKIE, finishPostmasterConnect } from "@/lib/postmaster";

export const dynamic = "force-dynamic";

// Where Google's consent screen comes back (the redirect URI on the OAuth client). Only the admin who started it, in the
// same browser, finishes it.
export async function GET(request) {
	const admin = await requireAdmin();
	const jar = await cookies();
	const cookie = jar.get(STATE_COOKIE)?.value;
	// A __Host- cookie is only replaced by one with the same attributes, so it's emptied rather than deleted.
	jar.set(STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
	const status = await finishPostmasterConnect({ params: new URL(request.url).searchParams, cookie, admin });
	redirect(`/admin?postmaster=${status}`);
}
