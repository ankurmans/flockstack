import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { ERROR_CODES, hasActiveSubscription } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, toIso } from "@/lib/actions/shared";
import { ATTACHMENT_IN_WORDS, detectAttachmentType, getContentDisposition, readExtension } from "@/lib/attachment-files";
import { decodeBase64Image, detectImageType } from "@/lib/image-files";
import { deleteImages, getImageStorageProblem, putImage } from "@/lib/image-storage";
import { FOLDER_RULE, normalizeFolder } from "@/lib/media-rules";
import { isRateLimited } from "@/lib/rate-limit";
import { fetchRemoteImage } from "@/lib/remote-image";
import { slugify } from "@/lib/slug";
import { IMAGE_TYPES, MAX_UPLOAD_BYTES } from "@/lib/upload-image";
import Upload from "@/models/Upload";

const GROUP = "Images";
// Files share the images' storage, limits and records (kind "file"); list_images leaves them out.
// base64 grows a file by a third, and requests stop at 4.5 MB.
const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 100;
// Enough to try the editor without a plan, not enough to host images on FlockStack for free.
const TRIAL_UPLOADS = { name: "upload-trial", limit: 20, window: "1 d" };
const SORT = { createdAt: -1, _id: -1 };

const folderInput = z.string().trim().max(60).optional().describe(`The media library folder to put it in (list_media_folders). ${FOLDER_RULE}. Default: no folder.`);
const folderOutput = z.string().nullable().describe("Its media library folder, or null");

const ImageSchema = z.object({
	id: z.string(),
	url: z.string().describe("Permanent: sent emails keep pointing at it"),
	contentType: z.enum(IMAGE_TYPES),
	bytes: z.number().int(),
	folder: folderOutput,
	createdAt: dateOutput,
});

function toImage(upload) {
	return {
		id: String(upload._id),
		url: upload.url,
		contentType: upload.contentType,
		bytes: upload.bytes,
		folder: upload.folder || null,
		createdAt: toIso(upload.createdAt),
	};
}

function readFolder(value) {
	const folder = normalizeFolder(value);
	if (folder === null) throw actionError("validation_failed", `folder: ${FOLDER_RULE}`);
	return folder;
}

const FileSchema = z.object({
	id: z.string(),
	url: z.string().describe("Permanent: sent emails keep pointing at it. Browsers download it rather than open it."),
	name: z.string().describe("The file's name, as readers see it"),
	contentType: z.string(),
	bytes: z.number().int(),
	folder: folderOutput,
	html: z.string().describe("The File block for a rich campaign's content: a download link with the file's name and size"),
	createdAt: dateOutput,
});

function toFile(upload) {
	const href = upload.url.replaceAll('"', "%22");
	const name = upload.name.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return {
		id: String(upload._id),
		url: upload.url,
		name: upload.name,
		contentType: upload.contentType,
		bytes: upload.bytes,
		folder: upload.folder || null,
		html: `<div data-file="" data-size="${upload.bytes}"><a href="${href}">${name}</a></div>`,
		createdAt: toIso(upload.createdAt),
	};
}

// Stores the bytes where images go and keeps a record for the account's purge, which finds files by their records.
async function storeUpload(account, { pathname, bytes, contentType, options, record }) {
	let stored;
	try {
		stored = await putImage(pathname, bytes, contentType, options);
	} catch (error) {
		console.error("[uploads] Upload failed:", error);
		throw actionError("unavailable", "Upload failed, try again");
	}
	try {
		return await Upload.create({ accountId: account._id, url: stored.url, pathname: stored.pathname, contentType, bytes: bytes.length, ...record });
	} catch (error) {
		await deleteImages([stored]).catch((deleteError) => console.error(`[uploads] ${stored.pathname} stays without a record:`, deleteError));
		throw error;
	}
}

export const uploadActions = [
	defineAction({
		name: "list_images",
		tryWithoutPlan: true,
		title: "List images",
		group: GROUP,
		description:
			"Lists the images uploaded to the account, newest first, 50 a page, so a campaign can use one again without uploading it twice. Pass nextCursor back as cursor for the next page.",
		http: { method: "GET", path: "/images" },
		readOnly: true,
		example: { limit: 20 },
		input: z.object({
			limit: z.number().int().min(1).max(100).optional().describe("Images per page, 50 by default, 100 at most"),
			cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
		}),
		output: z.object({
			images: z.array(ImageSchema),
			nextCursor: z.string().nullable().describe("null on the last page"),
		}),
		handler: async ({ account, input }) => {
			const limit = input.limit ?? 50;
			const filter = scoped(account, { kind: { $ne: "file" }, ...(input.cursor ? afterCursor(input.cursor, "createdAt") : {}) });
			const uploads = await Upload.find(filter).sort(SORT).limit(limit + 1).lean();
			const page = uploads.slice(0, limit);
			const last = page.at(-1);
			return {
				images: page.map(toImage),
				nextCursor: uploads.length > limit ? encodeCursor(last.createdAt, last._id) : null,
			};
		},
	}),
	defineAction({
		name: "upload_image",
		tryWithoutPlan: true,
		title: "Upload an image",
		group: GROUP,
		description:
			"Stores a PNG, JPEG, GIF or WebP image under 4 MB on FlockStack's CDN and returns its URL for campaign content. Send the file as base64 (under about 3 MB, since requests stop at 4.5 MB) or an https:// link FlockStack downloads. The URL never changes: sent emails keep pointing at it. list_images finds images uploaded before.",
		http: { method: "POST", path: "/images", status: 201 },
		openWorld: true,
		rateLimit: { limit: 60, window: "1 h" },
		example: { url: "https://example.com/cover.png" },
		input: z.object({
			base64: z.string().max(MAX_BASE64_LENGTH).optional().describe("The image file, base64 encoded; a data: URL works too"),
			url: z.string().max(2000).optional().describe("An https:// link to the image"),
			fileName: z.string().max(200).optional().describe("Used in the stored file's name"),
			contentType: z.string().max(100).optional().describe("The file's type, checked against its first bytes"),
			folder: folderInput,
		}),
		output: ImageSchema,
		handler: async ({ account, input }) => {
			if (Boolean(input.base64) === Boolean(input.url)) throw actionError("validation_failed", "Send either base64 or url");
			if (input.contentType && !IMAGE_TYPES.includes(input.contentType)) {
				throw actionError("validation_failed", "Use a PNG, JPEG, GIF or WebP image");
			}
			const storageProblem = getImageStorageProblem();
			if (storageProblem) throw actionError("unavailable", storageProblem);
			if (!hasActiveSubscription(account) && (await isRateLimited({ ...TRIAL_UPLOADS, key: String(account._id) }))) {
				throw actionError(ERROR_CODES.subscriptionRequired, "Pick a plan to upload more images");
			}

			const bytes = input.url ? await fetchRemoteImage(input.url, { maxBytes: MAX_UPLOAD_BYTES }) : decodeBase64Image(input.base64);
			if (!bytes) throw actionError("validation_failed", "base64 isn't valid base64");
			if (bytes.length > MAX_UPLOAD_BYTES) throw actionError("validation_failed", "Images must be under 4 MB");
			const type = detectImageType(bytes);
			if (!type) throw actionError("validation_failed", "Use a PNG, JPEG, GIF or WebP image");
			if (input.contentType && input.contentType !== type.contentType) throw actionError("validation_failed", "This file isn't a valid image");

			// The account's folder comes from the account, never from the request.
			const name = slugify(input.fileName?.replace(/\.[a-z0-9]+$/i, ""), 60) || "image";
			const folder = readFolder(input.folder);
			const upload = await storeUpload(account, {
				pathname: `accounts/${account._id}/images/${name}.${type.extension}`,
				bytes,
				contentType: type.contentType,
				record: { kind: "image", name: `${name}.${type.extension}`, ...(folder && { folder }) },
			});
			return toImage(upload);
		},
	}),
	defineAction({
		name: "upload_file",
		tryWithoutPlan: true,
		title: "Upload a file",
		group: GROUP,
		description: `Stores a file readers can download from an issue: ${ATTACHMENT_IN_WORDS}, under 4 MB, checked against its first bytes. Send it as base64 with its name. The answer's html is the File block to put in a rich campaign's content; the link never changes, and browsers save the file rather than open it.`,
		http: { method: "POST", path: "/files", status: 201 },
		openWorld: true,
		rateLimit: { limit: 30, window: "1 h" },
		example: { fileName: "report.pdf" },
		input: z.object({
			base64: z.string().max(MAX_BASE64_LENGTH).describe("The file, base64 encoded; a data: URL works too"),
			fileName: z.string().trim().min(3).max(120).describe("Its name with the extension, e.g. report.pdf: readers see it, and the extension says its type"),
			folder: folderInput,
		}),
		output: FileSchema,
		handler: async ({ account, input }) => {
			const storageProblem = getImageStorageProblem();
			if (storageProblem) throw actionError("unavailable", storageProblem);
			if (!hasActiveSubscription(account) && (await isRateLimited({ ...TRIAL_UPLOADS, key: String(account._id) }))) {
				throw actionError(ERROR_CODES.subscriptionRequired, "Pick a plan to upload more files");
			}
			const bytes = decodeBase64Image(input.base64);
			if (!bytes) throw actionError("validation_failed", "base64 isn't valid base64");
			if (bytes.length > MAX_UPLOAD_BYTES) throw actionError("validation_failed", "Files must be under 4 MB");
			const type = detectAttachmentType(bytes, input.fileName);
			if (!type) {
				const known = readExtension(input.fileName);
				throw actionError("validation_failed", known ? `This file isn't a valid ${known.toUpperCase()} file, or that type can't be attached` : `Attach a ${ATTACHMENT_IN_WORDS} file`);
			}
			const base = slugify(input.fileName.replace(/\.[a-z0-9]+$/i, ""), 60) || "file";
			const folder = readFolder(input.folder);
			const upload = await storeUpload(account, {
				pathname: `accounts/${account._id}/files/${base}.${type.extension}`,
				bytes,
				contentType: type.contentType,
				options: { contentDisposition: getContentDisposition(input.fileName) },
				record: { kind: "file", name: input.fileName, ...(folder && { folder }) },
			});
			return toFile(upload);
		},
	}),
];
