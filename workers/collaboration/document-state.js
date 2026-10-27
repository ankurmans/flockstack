import * as Y from "yjs";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { editorDocumentSchema } from "../../lib/editor-document-schema.js";
export const schema = editorDocumentSchema();
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
function specHtml(spec, content) {
	if (typeof spec === "string") return escape(spec);
	if (!Array.isArray(spec) || typeof spec[0] !== "string" || !/^[a-z][a-z0-9-]*$/.test(spec[0])) throw new Error("Unsupported editor output");
	const [tag, ...tail] = spec;
	const attrs = tail[0] && typeof tail[0] === "object" && !Array.isArray(tail[0]) ? tail.shift() : {};
	const attributes = Object.entries(attrs).filter(([key, value]) => /^[a-zA-Z][\w:-]*$/.test(key) && !/^on/i.test(key) && value !== null && value !== undefined && value !== false).map(([key, value]) => ` ${key}="${escape(value === true ? "" : value)}"`).join("");
	return `<${tag}${attributes}>` + (VOID.has(tag) ? "" : tail.map(child => child === 0 ? content : specHtml(child, content)).join("") + `</${tag}>`);
}
function nodeHtml(node) {
	if (node.isText) {
		let html = escape(node.text);
		for (const mark of [...node.marks].reverse()) html = specHtml(mark.type.spec.toDOM(mark, true), html);
		return html;
	}
	let content = ""; node.forEach(child => { content += nodeHtml(child); });
	return node.type.name === "doc" ? content : specHtml(node.type.spec.toDOM(node), content);
}

export function documentContent(doc) {
	const node = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("default"), schema); node.check();
	const subject = doc.getText("subject").toString(), previewText = doc.getText("previewText").toString(), html = nodeHtml(node);
	if (subject.length > 200 || previewText.length > 300 || new TextEncoder().encode(html).byteLength > 1000000) throw new Error("The collaborative document is too large");
	return { subject, previewText, html };
}
export function documentFromState(state) {
	const doc = new Y.Doc(); Y.applyUpdate(doc, Uint8Array.from(atob(state), char => char.charCodeAt(0))); documentContent(doc); return doc;
}
export const stateBase64 = doc => Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
