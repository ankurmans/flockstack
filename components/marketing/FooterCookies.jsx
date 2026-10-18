"use client";

import { useSyncExternalStore } from "react";
import { getCookieSettingsAvailable, openCookieSettings, subscribeCookieSettings } from "@/lib/marketing/cookie-settings";

// The footer's "Cookie settings" (FooterCookies in components/SiteExtensions.jsx), a list item beside the legal pages.
// Nothing until the page has analytics whose choice it can change.
export default function FooterCookies({ className }) {
	const isAvailable = useSyncExternalStore(subscribeCookieSettings, getCookieSettingsAvailable, () => false);
	if (!isAvailable) return null;

	return (
		<li>
			<button type="button" onClick={openCookieSettings} className={className}>
				Cookie settings
			</button>
		</li>
	);
}
