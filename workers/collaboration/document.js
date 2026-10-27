import { DOMParser } from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "@tiptap/y-tiptap";
import { parseHTML } from "linkedom/worker";
import { schema } from "./document-state.js";
export { documentContent, documentFromState, stateBase64 } from "./document-state.js";
export function newDocument(campaign) {
	const { document } = parseHTML(`<html><head></head><body>${campaign.html ?? ""}</body></html>`);
	const node = DOMParser.fromSchema(schema).parse(document.body), doc = prosemirrorToYDoc(node, "default");
	doc.getText("subject").insert(0, campaign.subject ?? ""); doc.getText("previewText").insert(0, campaign.previewText ?? "");
	return doc;
}
