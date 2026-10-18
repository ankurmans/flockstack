"use client";

import { useEffect } from "react";
import { readStoredNumber, storeValue } from "@/lib/storage";

const WINDOW_MS = 24 * 60 * 60 * 1000;

// One impression per newsletter, place and browser a day. The page names the newsletters it showed; nothing about the
// reader is sent.
export default function TrackRecommendations({ newsletterSlug, shown, surface }) {
	const list = shown.join(",");

	useEffect(() => {
		const key = `flockstack:recommendations:${surface}:${newsletterSlug}`;
		if (Date.now() - readStoredNumber(key) < WINDOW_MS) return;
		storeValue(key, Date.now());

		const body = JSON.stringify({ newsletter: newsletterSlug, shown: list.split(",") });
		const url = "/api/recommendations/impression";
		const isQueued = navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
		if (!isQueued) fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
	}, [newsletterSlug, list, surface]);

	return null;
}
