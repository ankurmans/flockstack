import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, toIso } from "@/lib/actions/shared";
import { FOLDER_RULE, MAX_FOLDERS, MAX_MOVE, escapeRegex, getMediaName, normalizeFolder } from "@/lib/media-rules";
import { slugify } from "@/lib/slug";
import { isObjectIdString } from "@/lib/validation";
import Upload from "@/models/Upload";

const GROUP = "Media library";
const SORT = { createdAt: -1, _id: -1 };
const folderName = z.string().trim().min(1).max(60).describe(FOLDER_RULE);

const MediaSchema = z.object({
	id: z.string(),
	kind: z.enum(["image", "file"]),
	name: z.string().describe("The name it was uploaded under"),
	url: z.string().describe("Permanent: sent emails keep pointing at it"),
	contentType: z.string(),
	bytes: z.number().int(),
	folder: z.string().nullable().describe("Its folder, or null when it is in none"),
	createdAt: dateOutput,
});

function toMedia(upload) {
	return {
		id: String(upload._id),
		kind: upload.kind === "file" ? "file" : "image",
		name: getMediaName(upload),
		url: upload.url,
		contentType: upload.contentType,
		bytes: upload.bytes,
		folder: upload.folder || null,
		createdAt: toIso(upload.createdAt),
	};
}

function readFolder(value, field) {
	const folder = normalizeFolder(value);
	if (folder === null) throw actionError("validation_failed", `${field}: ${FOLDER_RULE}`);
	return folder;
}

// The folders and how many uploads are in each, with the count of unfiled ones.
async function countFolders(account) {
	const rows = await Upload.aggregate([{ $match: scoped(account) }, { $group: { _id: { $ifNull: ["$folder", ""] }, count: { $sum: 1 } } }]);
	const folders = rows.filter(({ _id }) => _id).map(({ _id, count }) => ({ name: _id, count })).toSorted((a, b) => a.name.localeCompare(b.name));
	return { folders, unfiled: rows.find(({ _id }) => !_id)?.count ?? 0 };
}

const listMedia = defineAction({
	name: "list_media",
	tryWithoutPlan: true,
	title: "List the media library",
	group: GROUP,
	description:
		"Lists the images and files uploaded to the account, newest first, 50 a page. Filter by folder (an empty folder means uploads in none), by kind, or by a search of their names. Pass nextCursor back as cursor for the next page.",
	http: { method: "GET", path: "/media" },
	readOnly: true,
	example: { folder: "Covers", limit: 20 },
	input: z.object({
		folder: z.string().trim().max(60).optional().describe("Only this folder's uploads. An empty string means uploads in no folder. Default: all."),
		search: z.string().trim().max(100).optional().describe("Only uploads whose name contains this, ignoring case"),
		kind: z.enum(["image", "file"]).optional().describe("Only images, or only files"),
		limit: z.number().int().min(1).max(100).optional().describe("Uploads per page, 50 by default, 100 at most"),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		media: z.array(MediaSchema),
		nextCursor: z.string().nullable().describe("null on the last page"),
	}),
	handler: async ({ account, input }) => {
		const limit = input.limit ?? 50;
		const and = [];
		if (input.folder !== undefined) {
			const folder = readFolder(input.folder, "folder");
			and.push(folder ? { folder } : { folder: { $in: [null, ""] } });
		}
		if (input.kind) and.push(input.kind === "file" ? { kind: "file" } : { kind: { $ne: "file" } });
		if (input.search) {
			// A name is what it was uploaded under; older images only have the file name in their path, made of slug characters.
			const slug = slugify(input.search, 60);
			and.push({
				$or: [{ name: { $regex: escapeRegex(input.search), $options: "i" } }, ...(slug ? [{ pathname: { $regex: `${escapeRegex(slug)}[^/]*$`, $options: "i" } }] : [])],
			});
		}
		if (input.cursor) and.push(afterCursor(input.cursor, "createdAt"));
		const uploads = await Upload.find(scoped(account, and.length > 0 ? { $and: and } : {})).sort(SORT).limit(limit + 1).lean();
		const page = uploads.slice(0, limit);
		const last = page.at(-1);
		return { media: page.map(toMedia), nextCursor: uploads.length > limit ? encodeCursor(last.createdAt, last._id) : null };
	},
});

const listMediaFolders = defineAction({
	name: "list_media_folders",
	tryWithoutPlan: true,
	title: "List the media library's folders",
	group: GROUP,
	description: "Lists the media library's folders with how many uploads each holds, and how many are in none. A folder exists while an upload is in it: move_media creates one.",
	http: { method: "GET", path: "/media/folders" },
	readOnly: true,
	input: z.object({}),
	output: z.object({
		folders: z.array(z.object({ name: z.string(), count: z.number().int() })),
		unfiled: z.number().int().describe("Uploads in no folder"),
	}),
	handler: async ({ account }) => countFolders(account),
});

const moveMedia = defineAction({
	name: "move_media",
	tryWithoutPlan: true,
	title: "Move uploads to a folder",
	group: GROUP,
	description: `Puts up to ${MAX_MOVE} images and files in a folder, creating it if it is new (50 folders at most), or takes them out of their folder with an empty folder. Nothing is deleted and no link changes: sent emails keep pointing at the same URLs.`,
	http: { method: "POST", path: "/media/move" },
	idempotent: true,
	example: { ids: ["6650f1c2e9b1d4a012345678"], folder: "Covers" },
	input: z.object({
		ids: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_MOVE).describe(`The uploads' IDs, from list_media, ${MAX_MOVE} at most`),
		folder: z.string().trim().max(60).describe(`The folder to put them in. ${FOLDER_RULE}. An empty string takes them out of their folder.`),
	}),
	output: z.object({ moved: z.number().int(), folder: z.string().nullable() }),
	handler: async ({ account, input }) => {
		const folder = readFolder(input.folder, "folder");
		const ids = [...new Set(input.ids)];
		if (!ids.every(isObjectIdString)) throw actionError("validation_failed", "ids: use IDs from list_media");
		const found = await Upload.find(scoped(account, { _id: { $in: ids } })).select({ _id: 1 }).lean();
		if (found.length !== ids.length) throw actionError("not_found", "An upload isn't in this account");
		if (folder) {
			const { folders } = await countFolders(account);
			if (!folders.some(({ name }) => name === folder) && folders.length >= MAX_FOLDERS) {
				throw actionError("validation_failed", `An account has up to ${MAX_FOLDERS} folders: empty one you don't use`);
			}
		}
		await Upload.updateMany(scoped(account, { _id: { $in: ids } }), folder ? { $set: { folder } } : { $unset: { folder: 1 } });
		return { moved: ids.length, folder: folder || null };
	},
});

const renameMediaFolder = defineAction({
	name: "rename_media_folder",
	tryWithoutPlan: true,
	title: "Rename a media folder",
	group: GROUP,
	description: "Renames a media library folder. Renaming it to another folder's name joins the two. An empty name takes its uploads out of any folder. No link changes.",
	http: { method: "PATCH", path: "/media/folders" },
	idempotent: true,
	example: { folder: "Covers", name: "Cover images" },
	input: z.object({
		folder: folderName.describe("The folder to rename"),
		name: z.string().trim().max(60).describe(`Its new name. ${FOLDER_RULE}. Empty: the uploads leave the folder.`),
	}),
	output: z.object({ moved: z.number().int(), folder: z.string().nullable() }),
	handler: async ({ account, input }) => {
		const from = readFolder(input.folder, "folder");
		const name = readFolder(input.name, "name");
		const { modifiedCount } = await Upload.updateMany(scoped(account, { folder: from }), name ? { $set: { folder: name } } : { $unset: { folder: 1 } });
		if (!modifiedCount) throw actionError("not_found", "Folder not found");
		return { moved: modifiedCount, folder: name || null };
	},
});

export const mediaActions = [listMedia, listMediaFolders, moveMedia, renameMediaFolder];
