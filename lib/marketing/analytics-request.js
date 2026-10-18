import { cookies, headers } from "next/headers";
import { readAnalyticsEnv } from "@/lib/marketing/analytics-config";
import { CONSENT_COOKIE, decideAnalytics, toConsent } from "@/lib/marketing/analytics-consent";
import { GOAL_COOKIE, GOAL_COOKIE_MAX_AGE, GOAL_EVENTS } from "@/lib/marketing/analytics-privacy";

// What the server knows of a request when it decides whether FlockStack's own pages carry PostHog: the project key,
// the visitor's country (Cloudflare's cf-ipcountry), their privacy signals and their saved choice. Null: nothing
// renders (no key, or a Global Privacy Control or Do Not Track signal).
export async function readAnalyticsRequest(env = process.env) {
	const config = readAnalyticsEnv(env);
	if (!config) return null;
	const [requestHeaders, jar] = await Promise.all([headers(), cookies()]);
	const decision = decideAnalytics({
		country: requestHeaders.get("cf-ipcountry"),
		gpc: requestHeaders.get("sec-gpc"),
		dnt: requestHeaders.get("dnt"),
		consent: toConsent(jar.get(CONSENT_COOKIE)?.value),
		env,
	});
	if (!decision.show) return null;
	return { ...config, requiresConsent: decision.requiresConsent, consent: decision.consent, status: decision.status };
}

// siteExtensions.sendGoalOnNextPage: a step only the server sees (a new account, a newsletter, a plan) leaves its name
// in a cookie for ten minutes, and the browser's analytics reports it on the next page and removes it. Nothing is
// sent to PostHog from here, and the cookie is left only for a visitor whose analytics is on.
export async function setGoalCookie(goal, env = process.env) {
	if (!Object.hasOwn(GOAL_EVENTS, goal)) return;
	try {
		const request = await readAnalyticsRequest(env);
		if (request?.status !== "on") return;
		(await cookies()).set(GOAL_COOKIE, goal, { path: "/", maxAge: GOAL_COOKIE_MAX_AGE, sameSite: "lax", secure: true });
	} catch (error) {
		console.warn("[analytics] Couldn't leave a goal for the next page:", error.message);
	}
}
