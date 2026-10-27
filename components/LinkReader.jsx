"use client";
import useReaderText from "@/components/useReaderText";

import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

// "Sign in" until the browser holds a reader session for this newsletter, then "Account". The pages are cached for
// everyone, so only the marker cookie (lib/reader-cookies.js), which the page can read, says which; the session itself is
// an httpOnly cookie the server checks.
export default function LinkReader({ marker, signinHref, accountHref, className }) {
	const t = useReaderText();
	const isSignedIn = useSyncExternalStore(
		subscribeToNothing,
		() => document.cookie.split("; ").includes(`${marker}=1`),
		() => false
	);

	return (
		<a href={isSignedIn ? accountHref : signinHref} className={className}>
			{t(isSignedIn ? "Account" : "Sign in")}
		</a>
	);
}
