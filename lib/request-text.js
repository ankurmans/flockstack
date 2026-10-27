// Stop reading before an unauthenticated request can fill a Worker's memory.
export async function readBoundedText(request, limit) {
	if (Number(request.headers.get("content-length")) > limit) throw new RangeError("Request too large");
	if (!request.body) return "";
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) { await reader.cancel(); throw new RangeError("Request too large"); }
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally { reader.releaseLock(); }
}
