// A mounted answer as the owner's site serves it (lib/mount-rules.js): worker-entry.mjs passes it through here when proxy.js said
// the request was mounted. Root-relative URLs in the HTML go under the mount path, and so do the build's files named in Next.js's
// scripts and in React Server Components data; absolute and protocol-relative URLs stay as they are. Workers only: HTMLRewriter
// is the runtime's. Under `next dev` nothing is rewritten.
import {
	ASSET_REF_TAIL,
	MOUNTED_RESPONSE_HEADER,
	MOUNTED_SLUG_RESPONSE_HEADER,
	getChunkBaseScript,
	toMountedAssetRefs,
	toMountedLocation,
	toMountedSrcset,
	toMountedUrl,
} from "./mount-rules.js";

const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "poster"];
const SRCSET_ATTRIBUTES = ["srcset", "imagesrcset"];

class AttributeRewriter {
	constructor(context) {
		this.context = context;
	}

	element(element) {
		for (const name of URL_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (value) element.setAttribute(name, toMountedUrl(value, this.context));
		}
		for (const name of SRCSET_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (value) element.setAttribute(name, toMountedSrcset(value, this.context));
		}
	}
}

// A script's or a style's text arrives in pieces: it is held until its last piece so a name cut in two is still found.
class TextRewriter {
	constructor(mountPath) {
		this.mountPath = mountPath;
		this.buffer = "";
	}

	text(chunk) {
		this.buffer += chunk.text;
		if (!chunk.lastInTextNode) {
			chunk.remove();
			return;
		}
		chunk.replace(toMountedAssetRefs(this.buffer, this.mountPath), { html: true });
		this.buffer = "";
	}
}

export function createMountRewriter(context) {
	return new HTMLRewriter()
		.on("html", {
			element(element) {
				// Read by the reader pages' own requests (lib/reader-base.js).
				element.setAttribute("data-base", context.mountPath);
			},
		})
		.on("head", {
			element(element) {
				element.prepend(getChunkBaseScript(context.mountPath), { html: true });
			},
		})
		.on(URL_ATTRIBUTES.concat(SRCSET_ATTRIBUTES).map((name) => `[${name}]`).join(", "), new AttributeRewriter(context))
		.on("script", new TextRewriter(context.mountPath))
		.on("style", new TextRewriter(context.mountPath));
}

// Where a quote that could start "/_next/ sits in the last few characters: the text from there waits for the next chunk.
function holdFrom(text) {
	for (let index = Math.max(0, text.length - ASSET_REF_TAIL); index < text.length; index += 1) {
		if (text[index] === '"' || text[index] === "'" || text[index] === "(") return index;
	}
	return text.length;
}

export function createAssetRefStream(mountPath) {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let held = "";
	return new TransformStream({
		transform(chunk, controller) {
			const text = held + decoder.decode(chunk, { stream: true });
			const cut = holdFrom(text);
			held = text.slice(cut);
			if (cut > 0) controller.enqueue(encoder.encode(toMountedAssetRefs(text.slice(0, cut), mountPath)));
		},
		flush(controller) {
			const text = held + decoder.decode();
			if (text) controller.enqueue(encoder.encode(toMountedAssetRefs(text, mountPath)));
		},
	});
}

// context: { mountPath, slug, upstreamOrigin }, the origin the owner's proxy forwarded to.
export function rewriteMountedResponse(response, context) {
	const headers = new Headers(response.headers);
	headers.delete(MOUNTED_RESPONSE_HEADER);
	headers.delete(MOUNTED_SLUG_RESPONSE_HEADER);
	const location = headers.get("location");
	if (location) headers.set("location", toMountedLocation(location, context));
	const init = { status: response.status, statusText: response.statusText, headers };
	const type = headers.get("content-type") ?? "";
	if (response.body && /^text\/html\b/i.test(type)) {
		headers.delete("content-length");
		return createMountRewriter(context).transform(new Response(response.body, init));
	}
	if (response.body && /^text\/x-component\b/i.test(type)) {
		headers.delete("content-length");
		return new Response(response.body.pipeThrough(createAssetRefStream(context.mountPath)), init);
	}
	return new Response(response.body, init);
}
