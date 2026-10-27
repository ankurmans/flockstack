import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Callout } from "./editor-callout.js";
import { createBlockExtensions } from "./editor-nodes.js";
// These are the content nodes/marks of EditorRich; menus and node views add no persistent schema.
export function editorDocumentSchema() {
	return getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, defaultProtocol: "https" } }), Image, Callout, ...createBlockExtensions({ onEdit() {} })]);
}
