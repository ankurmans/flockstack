// The media library's folders: one level of names, kept on each upload (models/Upload.js). A folder exists while an upload
// is in it.
export const MAX_FOLDER_LENGTH = 60;
export const MAX_FOLDERS = 50;
export const MAX_MOVE = 100;

const FOLDER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.&+()-]*$/u;

// The folder as stored: spaces collapsed. "" for no folder (or null/undefined); null when the name isn't one.
export function normalizeFolder(value) {
	if (value === null || value === undefined) return "";
	const folder = String(value).trim().replace(/\s+/g, " ");
	if (!folder) return "";
	return folder.length <= MAX_FOLDER_LENGTH && FOLDER_PATTERN.test(folder) ? folder : null;
}

export const FOLDER_RULE = `A folder's name: letters, digits, spaces and - _ . & + ( ), ${MAX_FOLDER_LENGTH} characters at most`;

// What an upload is called in the library: the name it was uploaded under, else its stored file's name.
export function getMediaName(upload) {
	if (upload.name) return upload.name;
	const file = String(upload.pathname ?? "").split("/").at(-1) ?? "";
	return file || "Untitled";
}

export function escapeRegex(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
