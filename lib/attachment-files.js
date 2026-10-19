// Files an issue links to for download (the editor's File block). They go where images go (lib/image-storage.js), so
// only these types, told by their first bytes as images are (lib/image-files.js): nothing a browser would run, and
// each is stored to be saved, not shown (Content-Disposition: attachment).
const ZIP = "PK\x03\x04";
export const ATTACHMENT_TYPES = {
	pdf: { contentType: "application/pdf", signature: "%PDF-" },
	zip: { contentType: "application/zip", signature: ZIP },
	epub: { contentType: "application/epub+zip", signature: ZIP },
	docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: ZIP },
	xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: ZIP },
	pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", signature: ZIP },
	mp3: { contentType: "audio/mpeg", check: isMp3 },
	m4a: { contentType: "audio/mp4", check: (bytes) => startsWith(bytes, "ftyp", 4) },
	csv: { contentType: "text/csv; charset=utf-8", check: isText },
	txt: { contentType: "text/plain; charset=utf-8", check: isText },
};
export const ATTACHMENT_EXTENSIONS = Object.keys(ATTACHMENT_TYPES);
export const ATTACHMENT_IN_WORDS = "PDF, ZIP, EPUB, Word, Excel, PowerPoint, MP3, M4A, CSV or text";

function startsWith(bytes, signature, offset = 0) {
	return [...signature].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function isMp3(bytes) {
	return startsWith(bytes, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

// UTF-8 text, without the NUL bytes binary files have.
function isText(bytes) {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

// The extension a file name ends with, or null.
export function readExtension(fileName) {
	return /\.([a-z0-9]{2,5})$/i.exec(String(fileName ?? "").trim())?.[1]?.toLowerCase() ?? null;
}

// { extension, contentType } when the bytes are what the name says, else null.
export function detectAttachmentType(bytes, fileName) {
	const extension = readExtension(fileName);
	const type = extension && ATTACHMENT_TYPES[extension];
	if (!type || bytes.length === 0) return null;
	const matches = type.signature ? startsWith(bytes, type.signature) : type.check(bytes);
	return matches ? { extension, contentType: type.contentType } : null;
}

// The name a download is saved under: the uploaded one, in plain characters, with RFC 6266's UTF-8 form beside it.
export function getContentDisposition(fileName) {
	const name = String(fileName ?? "file").replace(/[\r\n"\\]/g, "").slice(0, 120) || "file";
	const ascii = name.replace(/[^\x20-\x7e]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
