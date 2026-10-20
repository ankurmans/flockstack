import { AUDIO_CONTENT_TYPE, readAudioFile, statAudioFile } from "@/lib/audio-storage";

// An audio file as a response: podcast apps and iOS ask for it in byte ranges (Range, answered 206 with Content-Range) and
// check it with HEAD, so both work, with an ETag for revalidation.

// "bytes=0-99", "bytes=500-" and "bytes=-200" (the last 200). null: no usable range, so the whole file is sent (several
// ranges and units other than bytes are allowed to be ignored). "unsatisfiable": starts past the end of the file.
export function parseRange(header, size) {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!match || (match[1] === "" && match[2] === "")) return null;
	let start;
	let end;
	if (match[1] === "") {
		const length = Number(match[2]);
		if (length === 0) return "unsatisfiable";
		start = Math.max(0, size - length);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
		if (start >= size) return "unsatisfiable";
		if (end < start) return null;
	}
	return { start, end };
}

export function getAudioEtag(file) {
	return `"${file.readyAt ? new Date(file.readyAt).getTime().toString(36) : "0"}-${file.bytes}"`;
}

// access "public": a shared cache may keep it, for a year when the address carries the file's version (?v=). "private": for
// paid readers, kept by the reader's own browser only.
export async function serveAudio(request, file, { access = "public", version = null } = {}) {
	const etag = getAudioEtag(file);
	const stat = await statAudioFile(file.key);
	if (!stat) return new Response("Not found", { status: 404 });
	const isCurrent = version !== null && String(new Date(file.readyAt).getTime()) === String(version);
	const headers = {
		"Content-Type": AUDIO_CONTENT_TYPE,
		"Accept-Ranges": "bytes",
		ETag: etag,
		"Cache-Control": access === "public" ? `public, max-age=${isCurrent ? 31_536_000 : 3600}${isCurrent ? ", immutable" : ""}` : "private, max-age=3600",
		"Content-Disposition": "inline",
		"X-Content-Type-Options": "nosniff",
		...(access === "public" && { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges" }),
		...(file.readyAt && { "Last-Modified": new Date(file.readyAt).toUTCString() }),
		...(access === "private" && { Vary: "Cookie" }),
	};
	if (request.headers.get("if-none-match")?.split(",").some((value) => value.trim().replace(/^W\//, "") === etag)) {
		return new Response(null, { status: 304, headers });
	}
	// A range is only honored for the version the client asked about.
	const ifRange = request.headers.get("if-range");
	const range = ifRange && ifRange !== etag ? null : parseRange(request.headers.get("range"), stat.size);
	if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
	const partial = range && !(range.start === 0 && range.end === stat.size - 1) ? range : null;
	const length = partial ? partial.end - partial.start + 1 : stat.size;
	const responseHeaders = { ...headers, "Content-Length": String(length), ...(partial && { "Content-Range": `bytes ${partial.start}-${partial.end}/${stat.size}` }) };
	if (request.method === "HEAD") return new Response(null, { status: partial ? 206 : 200, headers: responseHeaders });
	const object = await readAudioFile(file.key, partial);
	if (!object) return new Response("Not found", { status: 404 });
	return new Response(object.body, { status: partial ? 206 : 200, headers: responseHeaders });
}
