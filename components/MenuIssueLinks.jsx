"use client";
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import { Link2 } from "lucide-react";
import MenuSlash from "@/components/MenuSlash";
import { searchIssueLinks } from "@/app/(app)/campaigns/actions";
export const IssueLinkCommand = Extension.create({
	name: "issueLinkCommand",
	addOptions() { return { newsletterId: null, campaignId: null }; },
	addGlobalAttributes() { return [{ types: ["link"], attributes: { issueId: { default: null, parseHTML: (element) => element.getAttribute("data-issue-link"), renderHTML: (attributes) => /^[a-f0-9]{24}$/.test(attributes.issueId ?? "") ? { "data-issue-link": attributes.issueId } : {} } } }]; },
	addProseMirrorPlugins() {
		if (!this.options.newsletterId) return [];
		return [Suggestion({
			editor: this.editor, pluginKey: new PluginKey("issueLinkSuggestions"), char: "[[", allowSpaces: true,
			items: async ({ query }) => { try { const result = await searchIssueLinks(this.options.newsletterId, query.replace(/\]\]$/, "").slice(0, 100)); return (result.issues ?? []).filter((issue) => issue.id !== String(this.options.campaignId)).map((issue) => ({ ...issue, title: issue.title || "Untitled issue", icon: Link2 })); } catch { return []; } },
			command: ({ editor, range, props }) => editor.chain().focus().deleteRange(range).insertContent([{ type: "text", text: props.title, marks: [{ type: "link", attrs: { href: props.url, issueId: props.id } }] }, { type: "text", text: " " }]).run(),
			render() {
				let component, unmount;
				return { onStart(props) { component = new ReactRenderer(MenuSlash, { props, editor: props.editor }); component.element.style.zIndex = "50"; unmount = props.mount(component.element); }, onUpdate(props) { component?.updateProps(props); }, onKeyDown(props) { return component?.ref?.onKeyDown(props) ?? false; }, onExit() { unmount?.(); component?.destroy(); } };
			},
		})];
	},
});
