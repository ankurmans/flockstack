import { getCropOutput } from "./image-edit.js";
import { IMAGE_TYPES, prepareImage } from "./upload-image.js";

// The browser side of the crop: reading a picture's pixels and drawing the chosen part (lib/image-edit.js says which).

// The picture as a blob. One of the account's own uploads comes through FlockStack (/api/uploads/source), because its image
// host may not let this page read it; any other address is read directly, which works where that host allows it.
async function fetchBlob(src) {
	const own = await fetch(`/api/uploads/source?url=${encodeURIComponent(src)}`).catch(() => null);
	if (own?.ok) return own.blob();
	const direct = await fetch(src, { mode: "cors", credentials: "omit" }).catch(() => null);
	if (direct?.ok) return direct.blob();
	throw new Error("This picture can't be cropped here. Upload it again to crop it.");
}

export async function loadCropSource(src) {
	const blob = await fetchBlob(src);
	if (!IMAGE_TYPES.includes(blob.type)) throw new Error("Use a PNG, JPEG or WebP picture to crop");
	if (blob.type === "image/gif") throw new Error("A GIF can't be cropped without losing its animation");
	const bitmap = await createImageBitmap(blob).catch(() => {
		throw new Error("Couldn't read the picture");
	});
	return { bitmap, blob };
}

// The cropped part as an upload-ready file, scaled and typed like any other upload.
export async function cropToFile({ bitmap, blob }, rect) {
	const output = getCropOutput(rect, { width: bitmap.width, height: bitmap.height });
	const canvas = document.createElement("canvas");
	canvas.width = output.width;
	canvas.height = output.height;
	const context = canvas.getContext("2d");
	const isJpeg = blob.type === "image/jpeg";
	if (isJpeg) {
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
	}
	context.drawImage(bitmap, output.sx, output.sy, output.sw, output.sh, 0, 0, output.width, output.height);
	const type = isJpeg ? "image/jpeg" : "image/png";
	const cropped = await new Promise((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Couldn't crop the picture"))), type, 0.9));
	return prepareImage(new File([cropped], `cropped.${isJpeg ? "jpg" : "png"}`, { type }));
}
