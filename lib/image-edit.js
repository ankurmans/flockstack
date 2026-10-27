// What the editor's image tools work out: the sizes a picture can be shown at, and the crop rectangle. Nothing here touches
// the editor or the page, so it is the same in the browser and in tests. Sizes are in pixels of the email (600 wide at most).
export const EMAIL_WIDTH = 600;
export const MIN_IMAGE_WIDTH = 80;
// The widest picture kept when one is cropped: the same as an upload (lib/upload-image.js), sharp on a retina screen.
export const MAX_CROP_WIDTH = 1200;
// The smallest crop in the picture's own pixels.
export const MIN_CROP_SIDE = 32;

export const RESIZE_PRESETS = [
	{ id: "small", label: "Small", width: 240 },
	{ id: "medium", label: "Medium", width: 360 },
	{ id: "large", label: "Large", width: 480 },
	{ id: "full", label: "Full width", width: EMAIL_WIDTH },
];

export const CROP_RATIOS = [
	{ id: "free", label: "Free", ratio: null },
	{ id: "1:1", label: "1:1", ratio: 1 },
	{ id: "4:3", label: "4:3", ratio: 4 / 3 },
	{ id: "3:2", label: "3:2", ratio: 3 / 2 },
	{ id: "16:9", label: "16:9", ratio: 16 / 9 },
];

function toPositive(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

// The size to show a picture at when its width is set: the height follows from the picture's own shape. Never wider than the
// email, nor narrower than a thumbnail. natural: the picture's own size, from which the shape is read; it is the shape of the
// current size when the picture's file isn't loaded.
export function getResizedSize(target, { current, natural } = {}) {
	const shape = natural && toPositive(natural.width) && toPositive(natural.height) ? natural : current;
	const width = Math.round(Math.min(EMAIL_WIDTH, Math.max(MIN_IMAGE_WIDTH, toPositive(target) ?? EMAIL_WIDTH)));
	const ratio = shape && toPositive(shape.width) && toPositive(shape.height) ? shape.height / shape.width : null;
	return ratio === null ? { width } : { width, height: Math.round(width * ratio) };
}

// The preset whose width is the picture's, if any, to mark it in the menu.
export function getActivePreset(width) {
	const number = Math.round(Number(width));
	return RESIZE_PRESETS.find((preset) => preset.width === number)?.id ?? null;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

// The biggest rectangle of the ratio (free: the whole picture) in the middle of a picture: { x, y, width, height } in its own pixels.
export function getInitialCrop(size, ratio = null) {
	const { width, height } = size;
	if (!ratio) return { x: 0, y: 0, width, height };
	let cropWidth = width;
	let cropHeight = width / ratio;
	if (cropHeight > height) {
		cropHeight = height;
		cropWidth = height * ratio;
	}
	return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight };
}

// The rectangle moved by dx and dy, kept inside the picture.
export function moveCrop(rect, dx, dy, size) {
	return { ...rect, x: clamp(rect.x + dx, 0, size.width - rect.width), y: clamp(rect.y + dy, 0, size.height - rect.height) };
}

// Dragging one corner to a point, with the opposite corner staying where it is. With a ratio the rectangle keeps it, as large
// as the point and the picture allow; without one it follows the point. It stays inside the picture and keeps a minimum side.
export function dragCropCorner(rect, corner, point, size, ratio = null) {
	const isLeft = corner === "nw" || corner === "sw";
	const isTop = corner === "nw" || corner === "ne";
	const anchor = { x: isLeft ? rect.x + rect.width : rect.x, y: isTop ? rect.y + rect.height : rect.y };
	const room = { width: isLeft ? anchor.x : size.width - anchor.x, height: isTop ? anchor.y : size.height - anchor.y };
	let width = clamp(Math.abs(point.x - anchor.x), 0, room.width);
	let height = clamp(Math.abs(point.y - anchor.y), 0, room.height);
	// The pointer must be on the corner's side of the anchor, or the rectangle collapses to the minimum.
	if ((point.x < anchor.x) !== isLeft) width = 0;
	if ((point.y < anchor.y) !== isTop) height = 0;
	if (ratio) {
		const widthFromHeight = height * ratio;
		if (widthFromHeight < width) width = widthFromHeight;
		else height = width / ratio;
		const minWidth = Math.max(MIN_CROP_SIDE, MIN_CROP_SIDE * ratio);
		width = Math.max(width, minWidth);
		height = width / ratio;
		if (width > room.width) {
			width = room.width;
			height = width / ratio;
		}
		if (height > room.height) {
			height = room.height;
			width = height * ratio;
		}
	} else {
		width = Math.min(room.width, Math.max(width, MIN_CROP_SIDE));
		height = Math.min(room.height, Math.max(height, MIN_CROP_SIDE));
	}
	return { x: isLeft ? anchor.x - width : anchor.x, y: isTop ? anchor.y - height : anchor.y, width, height };
}

// Changing the ratio keeps the crop's center where it can and the largest rectangle that fits.
export function changeCropRatio(rect, ratio, size) {
	if (!ratio) return rect;
	const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	let width = Math.min(rect.width, rect.height * ratio);
	let height = width / ratio;
	if (height > size.height) {
		height = size.height;
		width = height * ratio;
	}
	if (width > size.width) {
		width = size.width;
		height = width / ratio;
	}
	return { x: clamp(center.x - width / 2, 0, size.width - width), y: clamp(center.y - height / 2, 0, size.height - height), width, height };
}

// What to draw: the source rectangle in whole pixels of the picture, and the size of the result, scaled down to MAX_CROP_WIDTH
// when it is wider. The result keeps the crop's shape.
export function getCropOutput(rect, size) {
	const x = clamp(Math.round(rect.x), 0, size.width - 1);
	const y = clamp(Math.round(rect.y), 0, size.height - 1);
	const sw = clamp(Math.round(rect.width), 1, size.width - x);
	const sh = clamp(Math.round(rect.height), 1, size.height - y);
	const scale = Math.min(1, MAX_CROP_WIDTH / sw);
	return { sx: x, sy: y, sw, sh, width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}

// A GIF would lose its animation, so it isn't cropped.
export function canCropImage(src, type = "") {
	if (/gif/i.test(type)) return false;
	return !/\.gif(?:[?#]|$)/i.test(String(src ?? ""));
}
