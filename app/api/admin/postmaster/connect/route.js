import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { STATE_COOKIE, STATE_MAX_AGE_SECONDS, getPostmasterSetup, startPostmasterConnect } from "@/lib/postmaster";

export const dynamic = "force-dynamic";

// The admin page's Connect link: Google's consent screen for Postmaster Tools, with a state only this browser holds.
// A link, not a form: the CSP's form-action would stop a form's redirect to Google.
export async function GET() {
	await requireAdmin();
	if (getPostmasterSetup().missing.length > 0) redirect("/admin?postmaster=missing");
	const { url, cookie } = startPostmasterConnect();
	(await cookies()).set(STATE_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: STATE_MAX_AGE_SECONDS });
	redirect(url);
}
