"use client";

import { useEffect, useId, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ACCEPTED, DECLINED } from "@/lib/marketing/analytics-consent";

// Asks whether FlockStack's own pages may use PostHog, and later lets the visitor change the answer ("Cookie settings").
// Accept and Decline look and weigh the same, and the page works the same whichever is chosen. isSettings: opened from
// the footer link, so it takes focus and Escape closes it; the first time it only waits, like any other part of the page.
export default function BannerConsent({ isSettings = false, consent = null, requiresConsent = true, onChoose, onClose }) {
	const id = useId();
	const headingRef = useRef(null);

	useEffect(() => {
		if (isSettings) headingRef.current?.focus();
	}, [isSettings]);

	const status = consent === ACCEPTED ? "You accepted analytics." : consent === DECLINED ? "You declined analytics." : requiresConsent ? null : "Analytics is on, as it is where you are.";

	return (
		<section
			role={isSettings ? "dialog" : "region"}
			aria-modal={isSettings ? "false" : undefined}
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-text`}
			data-consent-banner
			onKeyDown={(event) => {
				if (isSettings && event.key === "Escape") onClose?.();
			}}
			className="fixed inset-x-3 bottom-3 z-50 flex flex-col gap-3 rounded-xl bg-background p-4 text-foreground shadow-border drop-shadow-xl sm:right-auto sm:bottom-4 sm:left-4 sm:w-[26rem]"
		>
			<h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
				{isSettings ? "Cookie settings" : "Analytics on FlockStack's own pages"}
			</h2>
			<div id={`${id}-text`} className="flex flex-col gap-2 text-sm text-pretty text-muted-foreground">
				<p>
					We use PostHog to see page views, clicks, your device and approximate location and, when you are signed in, your account and email address.
					It never runs on newsletters or on the pages readers use.{" "}
					<Link href="/privacy" className="text-foreground underline underline-offset-4">
						Privacy policy
					</Link>
				</p>
				{isSettings && status && <p className="text-foreground">{status}</p>}
			</div>
			<div className="flex gap-2">
				<Button type="button" variant="outline" size="lg" className="flex-1" onClick={() => onChoose(ACCEPTED)}>
					Accept
				</Button>
				<Button type="button" variant="outline" size="lg" className="flex-1" onClick={() => onChoose(DECLINED)}>
					Decline
				</Button>
			</div>
			{isSettings && (
				<Button type="button" variant="ghost" size="sm" className="self-start" onClick={onClose}>
					Close
				</Button>
			)}
		</section>
	);
}
