"use client";

import { createContext, use, useEffect, useState } from "react";
import { getSupporterBadges } from "@/app/archive/comment-actions";

const Badges = createContext(null);
export function useSupporterBadges() { return use(Badges); }

export default function ProviderSupporterBadges({ slug, post, ids, children }) {
	const [badges, setBadges] = useState(() => new Set());
	const key = ids.join(",");
	useEffect(() => {
		let alive = true;
		let generation = 0;
		const wanted = key ? key.split(",") : [];
		async function refresh() {
			const current = ++generation;
			setBadges(new Set());
			if (document.visibilityState === "hidden" || !wanted.length) return;
			try {
				const found = await getSupporterBadges(slug, post, wanted);
				if (alive && generation === current) setBadges(new Set(found));
			} catch { /* A failed refresh leaves badges hidden. */ }
		}
		refresh();
		const timer = window.setInterval(refresh, 60_000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
	}, [slug, post, key]);
	return <Badges value={badges}>{children}</Badges>;
}
