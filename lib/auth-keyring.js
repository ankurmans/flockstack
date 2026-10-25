// The OAuth signing keys (Better Auth's jwks collection) kept readable across a rotation of BETTER_AUTH_SECRET. Each key's private half
// is encrypted with the secret that was current when it was made; Better Auth decrypts it every time it signs a token, and throws when it
// can't, which fails every token request (authorization code and refresh alike) until the collection is cleaned by hand.
//
// This is the jwt plugin's `adapter.getJwks`, which its sign, verify and /jwks paths all read through. It looks at the newest live key:
//  - readable with a previous secret, or written before versioned secrets existed: encrypted again with the current secret, so the key
//    outlives BETTER_AUTH_SECRET_PREVIOUS;
//  - unreadable with any secret we hold: retired at once. Better Auth then makes a new key, and the old public key stays in /jwks for its
//    grace period (30 days), so access tokens already issued keep verifying until they expire.
import { getAppSecrets } from "./config.js";

function readEnvelopeVersion(stored) {
	const match = /^\$ba\$(\d+)\$/.exec(stored);
	return match ? Number(match[1]) : null;
}

async function tryDecrypt(symmetricDecrypt, key, data) {
	try {
		return await symmetricDecrypt({ key, data });
	} catch {
		return null;
	}
}

// The key's private half in clear, or null. A key written without versions is bare hex, encrypted with a plain secret.
async function readPrivateKey({ symmetricDecrypt, secretConfig, secrets }, stored) {
	const plain = await tryDecrypt(symmetricDecrypt, secretConfig, stored);
	if (plain !== null || readEnvelopeVersion(stored) !== null) return plain;
	for (const secret of secrets) {
		const attempt = await tryDecrypt(symmetricDecrypt, secret, stored);
		if (attempt !== null) return attempt;
	}
	return null;
}

// One per Better Auth instance (and so per isolate): what it has looked at stays in memory, so a request costs a read of the table.
export function createJwksKeyring({ model = "jwks", log = console } = {}) {
	const retired = new Set();
	const checked = new Map();
	return async function getJwks(ctx) {
		const adapter = ctx.context.adapter;
		const rows = (await adapter.findMany({ model })) ?? [];
		const now = Date.now();
		const live = rows.filter((row) => !row.expiresAt || row.expiresAt.getTime() > now).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		const { secretConfig } = ctx.context;
		const currentVersion = secretConfig?.currentVersion;
		for (const row of live) {
			if (retired.has(row.id)) {
				row.expiresAt = new Date(now - 1);
				continue;
			}
			let stored;
			try {
				stored = JSON.parse(row.privateKey);
			} catch {
				stored = null;
			}
			// Already looked at: nothing to read or write.
			if (typeof stored === "string" && checked.get(row.id) === stored) break;
			const { symmetricDecrypt, symmetricEncrypt } = await import("better-auth/crypto");
			const plain = typeof stored === "string" ? await readPrivateKey({ symmetricDecrypt, secretConfig, secrets: getAppSecrets() }, stored) : null;
			if (plain === null) {
				retired.add(row.id);
				row.expiresAt = new Date(now - 1);
				log.error(`[auth] The OAuth signing key ${row.id} can't be decrypted with BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_PREVIOUS: it is retired and a new one is made. Its public key stays listed for 30 days, so tokens already issued keep verifying. Rotate with BETTER_AUTH_SECRET_PREVIOUS set to avoid this (docs/AUTH-ROTATION.md).`);
				await adapter.update({ model, where: [{ field: "id", value: row.id }], update: { expiresAt: row.expiresAt } }).catch((error) => log.error("[auth] Could not retire the signing key:", error?.message ?? error));
				continue;
			}
			if (readEnvelopeVersion(stored) !== currentVersion) {
				const rewrapped = JSON.stringify(await symmetricEncrypt({ key: secretConfig, data: plain }));
				row.privateKey = rewrapped;
				log.info(`[auth] The OAuth signing key ${row.id} is encrypted with the current secret now.`);
				await adapter.update({ model, where: [{ field: "id", value: row.id }], update: { privateKey: rewrapped } }).catch((error) => log.error("[auth] Could not save the signing key:", error?.message ?? error));
				checked.set(row.id, JSON.parse(rewrapped));
			} else {
				checked.set(row.id, stored);
			}
			break;
		}
		return rows;
	};
}
