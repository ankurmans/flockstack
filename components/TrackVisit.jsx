"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { getReaderPathname, withReaderBase } from "@/lib/reader-base";
import { buildVisit, hasOptedOut } from "@/lib/visit-beacon";

// The page the visitor arrived by is only told once per tab: the next pages' referrer is this website.
let hasReportedReferrer = false;

// Counts a page view on the newsletter's website: which kind of page, which issue, and the referring page. No cookie, no
// storage, nothing that stays with the visitor, and nothing at all when the browser says Do Not Track or Global Privacy Control
// (lib/web-analytics.js checks the same on the server).
export default function TrackVisit({ slug }) {
	const pathname = usePathname();

	useEffect(() => {
		if (hasOptedOut({ navigator, window })) return;
		const body = JSON.stringify(buildVisit({ slug, pathname: getReaderPathname(window.location.pathname), referrer: hasReportedReferrer ? "" : document.referrer }));
		hasReportedReferrer = true;
		const url = withReaderBase("/api/visit");
		const isQueued = navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
		if (!isQueued) fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
	}, [pathname, slug]);

	return null;
}
