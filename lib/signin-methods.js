// The ways besides a code by email that sign a user in, by Better Auth's provider id.
export const SIGNIN_PROVIDERS = { google: "Google", apple: "Apple" };

// What the account page says after Google or Apple sent the user back from connecting: ?connected=google, or
// ?connect=google&error=<Better Auth's code> when it wasn't linked. null when there's nothing to say.
export function describeConnectResult({ connected, connect, error, email }) {
	if (Object.hasOwn(SIGNIN_PROVIDERS, connected ?? "")) {
		return { isError: false, text: `${SIGNIN_PROVIDERS[connected]} is connected. You can sign in with it now.` };
	}
	if (!Object.hasOwn(SIGNIN_PROVIDERS, connect ?? "") || !error) return null;
	const name = SIGNIN_PROVIDERS[connect];
	const texts = {
		email_does_not_match: `That ${name} account uses another email. Connect one that uses ${email}.${connect === "apple" ? " If Apple asks, share your email rather than hide it." : ""}`,
		account_already_linked_to_different_user: `That ${name} account already signs in to another FlockStack account.`,
		unable_to_link_account: `${name} hasn't verified that account's email, so it can't sign you in here.`,
		email_not_verified: `${name} hasn't verified that account's email, so it can't sign you in here.`,
	};
	return { isError: true, text: texts[error] ?? `Couldn't connect ${name}. Try again.` };
}
