// Cloudflare validates a custom hostname's certificate over HTTP at these paths, and a Worker route in front of the
// hostname has to pass them through untouched (Cloudflare for SaaS, Workers as the fallback origin). Only customers'
// hostnames: FlockStack's own are Worker custom domains with certificates of their own, and a Worker can't fetch them.
const VALIDATION_PATH = /^\/\.well-known\/(acme-challenge|pki-validation)\//;

function readHost(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

export function isCertificateValidationRequest(request, env = {}) {
	if (!String(env.CLOUDFLARE_SAAS_ZONE_ID ?? "").trim()) return false;
	const url = new URL(request.url);
	if (!VALIDATION_PATH.test(url.pathname)) return false;
	const host = url.hostname.toLowerCase();
	const sharedDomain = String(env.SHARED_DOMAIN ?? "").trim().toLowerCase();
	const ownHosts = [readHost(env.APP_URL), ...String(env.ARCHIVE_TRUSTED_HOSTS ?? "").split(",").map((item) => item.trim().toLowerCase())];
	if (ownHosts.includes(host) || host.endsWith(".workers.dev")) return false;
	return !sharedDomain || (host !== sharedDomain && !host.endsWith(`.${sharedDomain}`));
}
