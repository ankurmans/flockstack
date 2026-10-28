"use client";

import { useEffect } from "react";
import { withReaderBase } from "@/lib/reader-base";
import { readStoredNumber, storeValue } from "@/lib/storage";

const VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

// One view per issue, browser and day; a refresh or a second visit the same day doesn't count again.
export default function TrackView({ issueId }) {
	useEffect(() => {
		const key = `flockstack:viewed:${issueId}`;
		if (Date.now() - readStoredNumber(key) < VIEW_WINDOW_MS) return;
		storeValue(key, Date.now());

		const body = JSON.stringify({ id: issueId });
		const url = withReaderBase("/api/views");
		const isQueued = navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }));
		if (!isQueued) {
			fetch(url, {
				method: "POST",
				body,
				keepalive: true,
				headers: { "Content-Type": "application/json" },
			}).catch(() => {});
		}
	}, [issueId]);

	return null;
}
