// Image and file links answered from memory instead of the network: tests put the bytes a URL serves here.
export const remoteImages = new Map();
export const requested = [];

export async function fetchRemoteFile(link, { maxBytes, label = "Files" }) {
	requested.push(link);
	const bytes = remoteImages.get(link);
	if (!bytes) throw Object.assign(new Error("The link answered 404"), { code: "validation_failed" });
	if (bytes.length > maxBytes) throw Object.assign(new Error(`${label} must be under ${Math.round(maxBytes / 1024 / 1024)} MB`), { code: "validation_failed" });
	return bytes;
}

export function fetchRemoteImage(link, { maxBytes }) {
	return fetchRemoteFile(link, { maxBytes, label: "Images" });
}
