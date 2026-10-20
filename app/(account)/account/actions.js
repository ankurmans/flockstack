"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDeletionBlockers, requestDeletion } from "@/lib/account-deletion";
import { listSocialAccounts } from "@/lib/accounts";
import { notifyActivity } from "@/lib/alerts";
import { checkDeletionCode, getAuth, isAppleEnabled, isGoogleEnabled, requireAccount, sendDeletionCodeEmail } from "@/lib/auth";
import { canSendSigninCodes } from "@/lib/platform-email";
import { saveProfile } from "@/lib/profile";
import { isRateLimited } from "@/lib/rate-limit";
import { SIGNIN_PROVIDERS } from "@/lib/signin-methods";
import { normalizeEmail } from "@/lib/validation";

// Each code also dies after 3 wrong tries and 5 minutes (Better Auth's emailOTP).
const CODES_PER_ACCOUNT = { name: "deletion-code", limit: 3, window: "15 m" };
const CHECKS_PER_ACCOUNT = { name: "deletion-check", limit: 10, window: "15 m" };
const CODE_PATTERN = /^\d{6}$/;
const BLOCKED_MESSAGE = "Your account can't be deleted yet. This page says what to do first.";
const PROVIDER_ENABLED = { google: isGoogleEnabled, apple: isAppleEnabled };

export async function updateProfile(_state, formData) {
	const { user, account } = await requireAccount();
	const result = await saveProfile({ user, account, name: formData.get("name"), image: formData.get("image") });
	if (result.ok) revalidatePath("/", "layout");
	return result;
}

// Google or Apple joins the ways this user signs in. Better Auth sends them there and back to the account page: with
// ?connected= once it's linked, or ?connect= and its ?error= when it wasn't (another email, another user's account).
export async function connectSignin(formData) {
	await requireAccount();
	const provider = String(formData.get("provider") ?? "");
	if (!Object.hasOwn(PROVIDER_ENABLED, provider) || !PROVIDER_ENABLED[provider]()) redirect("/account");
	const { url } = await (await getAuth()).api.linkSocialAccount({
		body: { provider, callbackURL: `/account?connected=${provider}`, errorCallbackURL: `/account?connect=${provider}`, disableRedirect: true },
		headers: await headers(),
	});
	redirect(url);
}

// A code by email always signs in, so even the last Google or Apple account can go, unless this server can't send one.
// Better Auth asks for a session from the last day to unlink.
export async function unlinkSignin(_state, formData) {
	const { user } = await requireAccount();
	const linked = await listSocialAccounts(user.id);
	const account = linked.find(({ id }) => id === String(formData.get("id") ?? ""));
	if (!account) return { error: "This sign-in method isn't connected any more. Reload the page." };
	if (linked.length === 1 && !canSendSigninCodes()) {
		return { error: `This server can't send sign-in codes, so ${account.name} is your only way in. Keep it connected.` };
	}
	try {
		await (await getAuth()).api.unlinkAccount({ body: { accountId: account.id }, headers: await headers() });
	} catch (error) {
		if (error?.body?.code === "SESSION_NOT_FRESH") {
			return { error: `To unlink ${account.name}, sign out and sign in again first. It takes a sign-in from the last day.` };
		}
		throw error;
	}
	revalidatePath("/account");
	return { ok: true, name: SIGNIN_PROVIDERS[account.provider] };
}

export async function sendDeletionCode() {
	const { user, account } = await requireAccount();
	if (await getDeletionBlockers(account)) return { error: BLOCKED_MESSAGE };
	if (await isRateLimited({ ...CODES_PER_ACCOUNT, key: String(account._id) })) return { error: "Too many codes. Try again in 15 minutes." };
	try {
		await sendDeletionCodeEmail(user.email);
	} catch (error) {
		console.error("[account] Could not send a deletion code:", error.message);
		return { error: "Couldn't send the code. Try again in a minute." };
	}
	return { sent: true };
}

// A session left open somewhere isn't enough: it takes a code sent for this, and the email typed out.
export async function deleteAccount(_state, formData) {
	const { user, account } = await requireAccount();
	const code = String(formData.get("code") ?? "").replace(/\s/g, "");
	if (normalizeEmail(formData.get("email")) !== normalizeEmail(user.email)) return { error: "Type your email address to confirm" };
	if (!CODE_PATTERN.test(code)) return { error: "Enter the 6-digit code" };
	if (await isRateLimited({ ...CHECKS_PER_ACCOUNT, key: String(account._id) })) return { error: "Too many tries. Try again in 15 minutes." };
	if (await getDeletionBlockers(account)) return { error: BLOCKED_MESSAGE };
	if (!(await checkDeletionCode(user.email, code))) return { error: "This code is wrong or expired" };
	try {
		await requestDeletion({ account, user });
	} catch (error) {
		console.error("[account] Deletion failed:", error);
		return { error: "Couldn't delete your account. Try again in a minute." };
	}
	await notifyActivity(["Account deleted", user.email], { accountId: account._id });
	redirect("/signin?deleted=1");
}
