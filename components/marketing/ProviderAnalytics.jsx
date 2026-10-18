"use client";

import { useEffect, useRef, useState } from "react";
import BannerConsent from "@/components/marketing/BannerConsent";
import { GOAL_EVENT } from "@/lib/goals";
import { analytics, takeGoalCookie } from "@/lib/marketing/analytics-client";
import { getAnalyticsStatus, readBrowserPrivacySignal, readConsent, serializeConsentCookie } from "@/lib/marketing/analytics-consent";
import { COOKIE_SETTINGS_EVENT, setCookieSettingsAvailable } from "@/lib/marketing/cookie-settings";
import { SIGN_OUT_EVENT } from "@/lib/sign-out";
import { useIsClient } from "@/lib/use-is-client";

// FlockStack Cloud's analytics on one of FlockStack's own pages (SiteAnalytics, on the server, decides it may be here
// and passes what it read from the request). The browser applies the rules again: a privacy signal means nothing is
// loaded, sent or stored, a visitor who must consent sees the banner first, and posthog-js is imported only once
// they may be tracked. It renders the marker below for the server-rendered page and the banner once it is needed.
export default function ProviderAnalytics({ token, host, replay, region, requiresConsent, consent: serverConsent, identity, privacyHref = null }) {
	const isClient = useIsClient();
	const [choice, setChoice] = useState(null);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const opener = useRef(null);

	// The server read the cookie when it rendered; the browser's copy is the one that counts.
	const consent = choice ?? (isClient ? readConsent(document.cookie) : serverConsent);
	const hasSignal = isClient && readBrowserPrivacySignal();
	const status = hasSignal ? "off" : getAnalyticsStatus({ requiresConsent, consent });
	const { id: userId = null, email: userEmail = null, plan: userPlan = null } = identity ?? {};

	useEffect(() => {
		if (!isClient) return;
		if (status !== "on") {
			analytics.stop();
			takeGoalCookie();
			return;
		}
		let isCurrent = true;
		const person = userId ? { id: userId, email: userEmail, plan: userPlan } : null;
		analytics.start({ token, host, replay, region, identity: person }).then(() => {
			const goal = isCurrent ? takeGoalCookie() : null;
			if (goal) analytics.track(goal);
		});
		// Leaving for a page without analytics, or for another layout's: nothing more is captured until a provider starts it again.
		return () => {
			isCurrent = false;
			analytics.pause();
		};
	}, [isClient, status, token, host, replay, region, userId, userEmail, userPlan]);

	useEffect(() => {
		const signOut = () => analytics.reset();
		const goal = (event) => analytics.track(event.detail?.goal, event.detail?.props);
		const openSettings = () => {
			opener.current = document.activeElement;
			setIsSettingsOpen(true);
		};
		window.addEventListener(SIGN_OUT_EVENT, signOut);
		window.addEventListener(GOAL_EVENT, goal);
		window.addEventListener(COOKIE_SETTINGS_EVENT, openSettings);
		return () => {
			window.removeEventListener(SIGN_OUT_EVENT, signOut);
			window.removeEventListener(GOAL_EVENT, goal);
			window.removeEventListener(COOKIE_SETTINGS_EVENT, openSettings);
		};
	}, []);

	const canAsk = isClient && !hasSignal;
	useEffect(() => {
		setCookieSettingsAvailable(canAsk);
		return () => setCookieSettingsAvailable(false);
	}, [canAsk]);

	function choose(value) {
		document.cookie = serializeConsentCookie(value, { secure: location.protocol !== "http:" });
		setChoice(value);
		closeSettings();
	}

	function closeSettings() {
		setIsSettingsOpen(false);
		opener.current?.focus?.();
		opener.current = null;
	}

	const isAsking = canAsk && status === "ask";

	return (
		<>
			<span hidden data-analytics-provider />
			{canAsk && (isAsking || isSettingsOpen) && (
				<BannerConsent isSettings={isSettingsOpen} consent={consent} requiresConsent={requiresConsent} privacyHref={privacyHref} onChoose={choose} onClose={closeSettings} />
			)}
		</>
	);
}
