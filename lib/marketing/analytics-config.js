// FlockStack Cloud's PostHog settings, from the Worker's environment. One PostHog project serves both deployments, on
// PostHog US Cloud. Read when a request renders, never at module load: a Worker has no env then.
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// A project key is public (it only writes events) and looks like phc_ followed by letters and digits.
const PROJECT_KEY = /^[A-Za-z0-9_-]{8,128}$/;

// { token, host, replay }, or null while POSTHOG_KEY is unset or malformed: then nothing loads and nothing renders.
export function readAnalyticsEnv(env = process.env) {
	const token = String(env.POSTHOG_KEY ?? "").trim();
	if (!PROJECT_KEY.test(token)) return null;
	return { token, host: readHost(env.POSTHOG_HOST), replay: String(env.POSTHOG_SESSION_REPLAY ?? "").trim().toLowerCase() === "true" };
}

// Only an https address: the events leave the browser for it.
function readHost(value) {
	const text = String(value ?? "").trim().replace(/\/+$/, "");
	if (!text || !URL.canParse(text)) return DEFAULT_POSTHOG_HOST;
	const url = new URL(text);
	return url.protocol === "https:" && !url.username && !url.password ? url.origin : DEFAULT_POSTHOG_HOST;
}
