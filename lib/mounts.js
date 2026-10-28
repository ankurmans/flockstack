import "server-only";
import crypto from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { isSignedWithAppKey, signWithAppKey } from "@/lib/app-keys";
import { revalidateArchive } from "@/lib/archive-data";
import { getMountUpstream } from "@/lib/archive-hosts";
import { getAppHost, getSharedDomain } from "@/lib/config";
import { forgetMount } from "@/lib/mount-routing";
import { MOUNT_CHECK_PATH, getMountPath, getMountUrlProblem, normalizeMountUrl } from "@/lib/mount-rules";
import { MOUNT_TOKEN_OVERLAP_MS, createMountToken, hashMountToken } from "@/lib/mount-tokens";
import { getPrivateHostProblem } from "@/lib/webhook-url";
import Newsletter from "@/models/Newsletter";

// The check is a fetch of the owner's own site, so it is held like the feed reader (lib/feed-fetch.js): https to public names,
// redirects followed by hand and each checked, a small answer and a short wait.
export const MOUNT_CHECK_LIMITS = { bytes: 16_000, timeoutMs: 8000, redirects: 3 };
const PROOF_INFO = "flockstack-mount-proof-v1";

function mountError(code, message) {
	return codedError({ code, message });
}

function ownNames() {
	return { appHost: getAppHost(), sharedDomain: getSharedDomain() };
}

export function toMountOutput(newsletter) {
	const mount = newsletter?.mount;
	if (!mount?.url) return null;
	const previousUntil = mount.previousUntil && new Date(mount.previousUntil).getTime() > Date.now() ? new Date(mount.previousUntil).toISOString() : null;
	return {
		url: mount.url,
		path: getMountPath(mount.url),
		upstream: getMountUpstream(newsletter),
		verified: Boolean(mount.verifiedAt),
		verifiedAt: mount.verifiedAt ? new Date(mount.verifiedAt).toISOString() : null,
		previousTokenUntil: previousUntil,
	};
}

async function load(account, newsletterId) {
	return Newsletter.findOne(scoped(account, { _id: newsletterId })).lean();
}

function changed(newsletter, wasVerified) {
	forgetMount(newsletter.slug);
	if (wasVerified) revalidateArchive();
}

// A new address or a new token for the same one: either way the proxy needs the new token, and the pages stay where they were
// until a check sees it.
export async function setMount({ account, newsletter, url }) {
	if (newsletter.archiveHost) {
		throw mountError("conflict", `This website is on its own subdomain, ${newsletter.archiveHost}. A newsletter has a subdomain or a subfolder, not both: take the subdomain off its domain first.`);
	}
	const problem = getMountUrlProblem(url, ownNames());
	if (problem) throw mountError("validation_failed", problem);
	const token = createMountToken();
	await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { mount: { url: normalizeMountUrl(url), tokenHash: hashMountToken(token) } } });
	changed(newsletter, Boolean(newsletter.mount?.verifiedAt));
	return { newsletter: await load(account, newsletter._id), token };
}

export async function rotateMountToken({ account, newsletter, now = new Date() }) {
	if (!newsletter.mount?.url) throw mountError("not_found", "This newsletter has no subfolder to rotate a token for");
	const token = createMountToken();
	const previousUntil = new Date(now.getTime() + MOUNT_TOKEN_OVERLAP_MS);
	await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), {
		$set: { "mount.tokenHash": hashMountToken(token), "mount.previousTokenHash": newsletter.mount.tokenHash, "mount.previousUntil": previousUntil },
	});
	forgetMount(newsletter.slug);
	return { newsletter: await load(account, newsletter._id), token, previousTokenUntil: previousUntil.toISOString() };
}

export async function removeMount({ account, newsletter }) {
	if (!newsletter.mount?.url) return { newsletter, removed: false };
	await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $unset: { mount: 1 } });
	changed(newsletter, Boolean(newsletter.mount.verifiedAt));
	return { newsletter: await load(account, newsletter._id), removed: true };
}

function proofValue({ slug, path, matched, challenge }) {
	return `${slug}\n${path}\n${matched}\n${challenge}`;
}

// What /.well-known/flockstack-mount answers a mounted request: the request's challenge signed with the server's own key, so
// the check knows FlockStack itself answered, for this newsletter and path, with the proxy's token matched.
export function signMountProof(fields) {
	return signWithAppKey(PROOF_INFO, proofValue(fields));
}

export function isMountProof(fields, signature) {
	return isSignedWithAppKey(PROOF_INFO, proofValue(fields), signature);
}

async function readJson(response) {
	const length = Number(response.headers.get("content-length"));
	if (length > MOUNT_CHECK_LIMITS.bytes) return null;
	const text = await response.text();
	if (text.length > MOUNT_CHECK_LIMITS.bytes) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// The answer at <mount>/.well-known/flockstack-mount, following up to three redirects that stay on public https names.
// { answer, status } or { problem }.
async function askThroughSite(mountUrl, challenge, fetchImpl) {
	let url = `${mountUrl}${MOUNT_CHECK_PATH}?challenge=${challenge}`;
	for (let hops = 0; hops <= MOUNT_CHECK_LIMITS.redirects; hops += 1) {
		const parsed = new URL(url);
		const problem = parsed.protocol !== "https:" ? "it isn't https" : parsed.port ? "it has a port" : getPrivateHostProblem(parsed);
		if (problem) return { problem: `Your site redirects to an address FlockStack can't ask: ${problem}.` };
		let response;
		try {
			response = await fetchImpl(url, { redirect: "manual", headers: { accept: "application/json", "user-agent": "FlockStack mount check (+https://flockstack.io/docs/subfolder)" }, signal: AbortSignal.timeout(MOUNT_CHECK_LIMITS.timeoutMs) });
		} catch (error) {
			return { problem: error?.name === "TimeoutError" ? "Your site took too long to answer." : "Your site could not be reached." };
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			url = new URL(location, url).href;
			continue;
		}
		return { status: response.status, answer: await readJson(response) };
	}
	return { problem: "Your site redirects too many times." };
}

// Asks the owner's site for the check path and expects FlockStack's own signed answer back. On success the mount is verified
// and the website's pages move to it.
export async function checkMount({ account, newsletter, fetchImpl = fetch }) {
	const mount = newsletter.mount;
	if (!mount?.url) throw mountError("not_found", "This newsletter has no subfolder to check");
	const challenge = crypto.randomBytes(18).toString("base64url");
	const path = getMountPath(mount.url);
	const result = await askThroughSite(mount.url, challenge, fetchImpl);
	const fail = (problem) => ({ newsletter, verified: false, token: null, problem });
	if (result.problem) return fail(result.problem);
	const { status, answer } = result;
	if (!answer || typeof answer !== "object") {
		return fail(`Your site answered ${status} at ${path}${MOUNT_CHECK_PATH}, not FlockStack: forward ${path} and everything under it to ${getMountUpstream(newsletter)}.`);
	}
	if (answer.mounted !== true) {
		if (answer.reason === "wrong_token") return fail("The request reached FlockStack with a token that doesn't match. Copy the current token into your proxy's X-FlockStack-Mount header.");
		if (answer.reason === "missing_token") return fail("The request reached FlockStack without the X-FlockStack-Mount header. Add it in your proxy.");
		return fail(`Your site answered ${status} at ${path}${MOUNT_CHECK_PATH}, not FlockStack.`);
	}
	const fields = { slug: newsletter.slug, path, matched: answer.token, challenge };
	if (answer.challenge !== challenge || answer.newsletter !== newsletter.slug || answer.path !== path || !["current", "previous"].includes(answer.token) || !isMountProof(fields, answer.signature)) {
		return fail("Your site answered for another newsletter or another path. Check where your proxy forwards.");
	}
	const wasVerified = Boolean(mount.verifiedAt);
	if (!wasVerified) {
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id, "mount.url": mount.url }), { $set: { "mount.verifiedAt": new Date() } });
		forgetMount(newsletter.slug);
		revalidateArchive();
	}
	const problem = answer.token === "previous" ? "It works, with the previous token: put the new one in your proxy before the previous one stops working." : null;
	return { newsletter: await load(account, newsletter._id), verified: true, token: answer.token, problem };
}
