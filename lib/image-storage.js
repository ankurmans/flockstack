import "server-only";
import { randomBytes, randomUUID } from "node:crypto";

// Sent emails point at these files forever, so their names never change and browsers can cache them for a year.
const ONE_YEAR = 365 * 24 * 60 * 60;
const S3_REQUIRED = ["IMAGES_S3_ACCESS_KEY_ID", "IMAGES_S3_SECRET_ACCESS_KEY", "IMAGES_CDN_URL"];
const AWS_TIMEOUT_MS = 30_000;
// S3 deletes up to 1,000 keys a request.
const DELETE_BATCH = 1000;
let s3;
let cloudFront;

// New uploads go to the S3 bucket when there is one, served from its CDN, else to Vercel Blob. Images
// uploaded before stay where they are.
export function getImageStorage(env = process.env) {
	if (env.IMAGES_STORAGE === "r2") return "r2";
	if (env.IMAGES_S3_BUCKET) return "s3";
	return env.BLOB_READ_WRITE_TOKEN ? "blob" : null;
}

export function getImageStorageProblem(env = process.env) {
	const storage = getImageStorage(env);
	if (!storage) return "Image uploads need an R2 bucket (IMAGES_STORAGE=r2), an S3 bucket (IMAGES_S3_BUCKET) or a Vercel Blob store (BLOB_READ_WRITE_TOKEN)";
	if (storage === "blob") return null;
	if (storage === "r2") return /^https:\/\/[^/]+/.test(env.IMAGES_CDN_URL ?? "") ? null : "IMAGES_CDN_URL must be the https:// address the R2 bucket is served from";
	const missing = S3_REQUIRED.filter((name) => !env[name]);
	if (missing.length > 0) {
		return `IMAGES_S3_BUCKET is set, so ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} to be set too`;
	}
	return /^https:\/\/[^/]+/.test(env.IMAGES_CDN_URL) ? null : "IMAGES_CDN_URL must be an https:// URL";
}

// Loaded only when Vercel Blob is used. Its undici compiles WebAssembly as the module loads and leaves the promise
// unhandled (`.catch()` without a handler), and Workers refuse to compile WebAssembly at runtime: imported at the top,
// it logged an unhandledRejection on every Worker's first request, whatever the page.
function loadVercelBlob() {
	return import("@vercel/blob");
}

// The R2 bucket bound as IMAGES in wrangler.jsonc.
async function getR2Bucket() {
	const { getCloudflareContext } = await import("@opennextjs/cloudflare");
	const { env } = await getCloudflareContext({ async: true });
	if (!env?.IMAGES) throw new Error("IMAGES_STORAGE is r2, but no R2 bucket is bound as IMAGES");
	return env.IMAGES;
}

async function putR2Image(pathname, bytes, contentType, { contentDisposition } = {}) {
	const key = pathname.replace(/(?=\.[a-z0-9]+$)|$/i, `-${randomBytes(8).toString("hex")}`);
	await (await getR2Bucket()).put(key, bytes, {
		httpMetadata: { contentType, cacheControl: `public, max-age=${ONE_YEAR}, immutable`, ...(contentDisposition && { contentDisposition }) },
	});
	return { url: `${getCdnUrl()}/${key}`, pathname: key };
}

// contentDisposition: "attachment; ..." for an issue's file attachment (lib/attachment-files.js), so a browser saves it.
export async function putImage(pathname, bytes, contentType, options = {}) {
	if (getImageStorage() === "r2") return putR2Image(pathname, bytes, contentType, options);
	if (getImageStorage() === "s3") return putS3Image(pathname, bytes, contentType, options);
	const { put } = await loadVercelBlob();
	const blob = await put(pathname, bytes, {
		access: "public",
		contentType,
		addRandomSuffix: true,
		cacheControlMaxAge: ONE_YEAR,
	});
	return { url: blob.url, pathname: blob.pathname };
}

// Only these keys: never the default AWS chain (~/.aws, instance roles), which could belong to another AWS
// account. Vercel reserves the AWS_* names, and SES has its own.
function getCredentials() {
	return {
		accessKeyId: process.env.IMAGES_S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.IMAGES_S3_SECRET_ACCESS_KEY,
	};
}

// The AWS SDKs (S3 and CloudFront, 500 KB) load with the first upload or delete on S3, not with this module.
async function getS3() {
	const { S3Client } = await import("@aws-sdk/client-s3");
	s3 ??= new S3Client({
		region: process.env.IMAGES_S3_REGION || "us-east-1",
		credentials: getCredentials(),
	});
	return s3;
}

// CloudFront's API is global and signs in us-east-1, whatever the bucket's region.
async function getCloudFront() {
	const { CloudFrontClient } = await import("@aws-sdk/client-cloudfront");
	cloudFront ??= new CloudFrontClient({ region: "us-east-1", credentials: getCredentials() });
	return cloudFront;
}

// A random part before the extension, like Vercel Blob's suffix, so an upload never replaces another.
async function putS3Image(pathname, bytes, contentType, { contentDisposition } = {}) {
	const key = pathname.replace(/(?=\.[a-z0-9]+$)|$/i, `-${randomBytes(8).toString("hex")}`);
	const { PutObjectCommand } = await import("@aws-sdk/client-s3");
	const command = new PutObjectCommand({
		Bucket: process.env.IMAGES_S3_BUCKET,
		Key: key,
		Body: bytes,
		ContentType: contentType,
		CacheControl: `public, max-age=${ONE_YEAR}, immutable`,
		...(contentDisposition && { ContentDisposition: contentDisposition }),
	});
	await (await getS3()).send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
	return { url: `${getCdnUrl()}/${key}`, pathname: key };
}

function getCdnUrl() {
	return process.env.IMAGES_CDN_URL?.replace(/\/+$/, "") || null;
}

// Uploads' files (an account's purge, or a file whose record wasn't saved): on S3 by key when they're on the CDN, else
// on Vercel Blob by URL, where images uploaded before S3 stay. A file that's gone already counts as deleted.
export async function deleteImages(uploads) {
	const cdn = getCdnUrl();
	const isOnS3 = ({ url }) => Boolean(cdn) && url.startsWith(`${cdn}/`);
	const keys = uploads.filter(isOnS3).map(({ pathname }) => ({ Key: pathname }));
	if (getImageStorage() === "r2") {
		const bucket = await getR2Bucket();
		for (let start = 0; start < keys.length; start += DELETE_BATCH) await bucket.delete(keys.slice(start, start + DELETE_BATCH).map(({ Key }) => Key));
	} else
	for (let start = 0; start < keys.length; start += DELETE_BATCH) {
		const { DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
		const command = new DeleteObjectsCommand({
			Bucket: process.env.IMAGES_S3_BUCKET,
			Delete: { Objects: keys.slice(start, start + DELETE_BATCH), Quiet: true },
		});
		const { Errors = [] } = await (await getS3()).send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
		if (Errors.length > 0) throw new Error(`S3 didn't delete ${Errors.length} images: ${Errors[0].Code} ${Errors[0].Message ?? ""}`.trim());
	}
	const blobs = uploads.filter((upload) => !isOnS3(upload)).map(({ url }) => url);
	if (blobs.length === 0) return;
	const { del } = await loadVercelBlob();
	for (let start = 0; start < blobs.length; start += DELETE_BATCH) await del(blobs.slice(start, start + DELETE_BATCH));
}

// CloudFront keeps serving a deleted image from its cache, for up to a year, until its path is invalidated.
export async function invalidateAccountImages(accountId) {
	const distributionId = process.env.IMAGES_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return null;
	const path = `/accounts/${accountId}/*`;
	const { CreateInvalidationCommand } = await import("@aws-sdk/client-cloudfront");
	const command = new CreateInvalidationCommand({
		DistributionId: distributionId,
		InvalidationBatch: { CallerReference: randomUUID(), Paths: { Quantity: 1, Items: [path] } },
	});
	try {
		const { Invalidation } = await (await getCloudFront()).send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
		return Invalidation.Id;
	} catch (error) {
		throw new Error(`CloudFront didn't invalidate ${path}: ${error.name} ${error.message}`, { cause: error });
	}
}
