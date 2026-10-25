// Whether a value is the BETTER_AUTH_SECRET a region's app is running with, without printing it or sending it anywhere: the value comes
// in on stdin, and the only thing sent is an HMAC of a body the app refuses as malformed. The app's internal revalidation route
// (lib/internal-revalidate.js) answers 401 for a signature that is not made with its secret and 400 for one that is, with a body it
// will not act on. scripts/rotate-auth-secret.sh asks before it carries the value forward as BETTER_AUTH_SECRET_PREVIOUS.
//   printf %s "$value" | node scripts/probe-auth-secret.mjs us|eu
// Exits 0 when the app accepted the signature, 1 when it did not, 2 when it could not be asked.
import { pathToFileURL } from "node:url";
import { REVALIDATE_PATH, SIGNATURE_HEADER, signBody } from "../lib/internal-revalidate.js";
import { getRegionUrls } from "../lib/region.js";

export async function probeSecret(secret, baseUrl, fetchImpl = fetch) {
	const body = "{}";
	try {
		const response = await fetchImpl(new URL(REVALIDATE_PATH, baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(body, secret) },
			body,
			signal: AbortSignal.timeout(15_000),
		});
		await response.arrayBuffer();
		if (response.status === 400) return "accepted";
		if (response.status === 401) return "refused";
		return "unknown";
	} catch {
		return "unknown";
	}
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const region = process.argv[2];
	const baseUrl = getRegionUrls()[region];
	if (!baseUrl) {
		console.error("region must be us or eu");
		process.exit(2);
	}
	const secret = await readStdin();
	if (!secret) process.exit(2);
	const answer = await probeSecret(secret, baseUrl);
	console.log(answer);
	process.exit(answer === "accepted" ? 0 : answer === "refused" ? 1 : 2);
}
