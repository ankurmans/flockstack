// The origins a socket may come from: the dashboard's (APP_URL) and, for trying realtime editing before a domain moves, the exact origins
// in COLLABORATION_ALLOWED_ORIGINS (comma separated, set by scripts/deploy-all.mjs from the optional Workers settings). No wildcards, no paths.
// Without APP_URL no socket is accepted, whatever the list says.
export function isAllowedOrigin(origin, env) {
	if (!origin || !env.APP_URL) return false;
	try {
		if (origin === new URL(env.APP_URL).origin) return true;
	} catch {
		return false;
	}
	return String(env.COLLABORATION_ALLOWED_ORIGINS ?? "").split(",").some(part => part.trim() === origin && isTestOrigin(origin));
}

// An https origin with a plain host name, or http on the machine itself; the same test the deploy script applies before it sets the variable.
export function isTestOrigin(value) {
	try {
		const url = new URL(value);
		const isLocal = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
		return url.origin === value && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) && (url.protocol === "https:" || isLocal);
	} catch {
		return false;
	}
}
