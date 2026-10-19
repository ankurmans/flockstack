"use client";

import { useImperativeHandle, useState } from "react";
import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import {
	Braces,
	Clapperboard,
	Columns2,
	Heading1,
	Heading2,
	Heading3,
	ImagePlus,
	List,
	ListOrdered,
	Lock,
	Minus,
	MousePointerClick,
	Paperclip,
	Pilcrow,
	RectangleHorizontal,
	Rows3,
	Share2,
	Superscript,
	Table,
	TextQuote,
	Trash2,
	Vote,
} from "lucide-react";
import { RECOMMENDATIONS_TAG } from "@/lib/recommendation-tags";
import { REFERRAL_COUNT_TAG, REFERRAL_LINK_TAG } from "@/lib/referral-tags";
import { cn } from "@/lib/utils";

export default function MenuSlash({ items, command, ref }) {
	const [selection, setSelection] = useState({ items, index: 0 });
	const index = selection.items === items ? selection.index : 0;

	function select(nextIndex) {
		setSelection({ items, index: nextIndex });
	}

	useImperativeHandle(ref, () => ({
		onKeyDown({ event }) {
			if (!items.length) return false;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				const step = event.key === "ArrowDown" ? 1 : -1;
				select((index + step + items.length) % items.length);
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				command(items[index]);
				return true;
			}
			return false;
		},
	}));

	if (!items.length) return null;

	return (
		<div
			role="listbox"
			aria-label="Insert"
			className="max-h-80 w-56 origin-top-left overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg animate-in duration-150 fade-in-0 zoom-in-95"
		>
			{items.map((item, itemIndex) => {
				const isSelected = itemIndex === index;
				return (
					<button
						key={item.title}
						type="button"
						role="option"
						aria-selected={isSelected}
						ref={isSelected ? scrollIntoView : undefined}
						onMouseEnter={() => select(itemIndex)}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => command(item)}
						className={cn(
							"flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm",
							isSelected && "bg-accent text-accent-foreground"
						)}
					>
						<span className="grid size-7 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground">
							<item.icon className="size-4" />
						</span>
						{item.title}
					</button>
				);
			})}
		</div>
	);
}

// Typing "/" at the start of a line or after a space opens the menu; the text after it filters. onBlock(kind) opens a
// block's dialog, onPickFile the file picker. canPoll: the editor knows its newsletter, which a poll belongs to.
export const SlashCommand = Extension.create({
	name: "slashCommand",
	addOptions() {
		return { onPickImage: () => {}, onBlock: () => {}, onPickFile: () => {}, fields: [], canPoll: false };
	},
	addProseMirrorPlugins() {
		return [
			Suggestion({
				editor: this.editor,
				char: "/",
				items: ({ query }) => filterItems(query, this.options),
				command: ({ editor, range, props: item }) => {
					item.run(editor.chain().focus().deleteRange(range)).run();
					if (item.isImage) this.options.onPickImage(editor);
					if (item.isFile) this.options.onPickFile(editor);
					if (item.dialog) this.options.onBlock(item.dialog);
				},
				render: renderMenu,
			}),
		];
	},
});

function renderMenu() {
	let component;
	let unmount;
	return {
		onStart(props) {
			component = new ReactRenderer(MenuSlash, { props, editor: props.editor });
			component.element.style.zIndex = "50";
			unmount = props.mount(component.element);
		},
		onUpdate(props) {
			component.updateProps(props);
		},
		onKeyDown(props) {
			return component.ref?.onKeyDown(props) ?? false;
		},
		onExit() {
			unmount?.();
			component.destroy();
		},
	};
}

const POLL_ITEM = { title: "Poll", keywords: "vote survey question answer", icon: Vote, run: (chain) => chain, dialog: "poll" };

// Merge tags (lib/merge-tags.js) for the email address and each custom field of the newsletter, with the words
// to print when a contact has no value.
function getMergeItems(fields) {
	const tags = [
		{ title: "Merge tag: email", text: "{{email}}" },
		...fields.map(({ key, label }) => ({ title: `Merge tag: ${label}`, text: key === "first_name" ? "{{first_name|there}}" : `{{${key}|}}` })),
	];
	return tags.map(({ title, text }) => ({
		title,
		keywords: "merge tag personalize field name",
		icon: Braces,
		run: (chain) => chain.insertContent(text),
	}));
}

function filterItems(query, { fields = [], canPoll = false } = {}) {
	const search = query.toLowerCase().trim();
	return [...SLASH_ITEMS, ...(canPoll ? [POLL_ITEM] : []), ...getMergeItems(fields)].filter(({ title, keywords }) => `${title} ${keywords}`.toLowerCase().includes(search));
}

function scrollIntoView(element) {
	element?.scrollIntoView({ block: "nearest" });
}

const SLASH_ITEMS = [
	{ title: "Text", keywords: "paragraph", icon: Pilcrow, run: (chain) => chain.setParagraph() },
	{ title: "Heading 1", keywords: "title h1 big", icon: Heading1, run: (chain) => chain.setHeading({ level: 1 }) },
	{ title: "Heading 2", keywords: "subtitle h2", icon: Heading2, run: (chain) => chain.setHeading({ level: 2 }) },
	{ title: "Heading 3", keywords: "h3 small", icon: Heading3, run: (chain) => chain.setHeading({ level: 3 }) },
	{ title: "Bulleted list", keywords: "ul unordered", icon: List, run: (chain) => chain.toggleBulletList() },
	{ title: "Numbered list", keywords: "ol ordered", icon: ListOrdered, run: (chain) => chain.toggleOrderedList() },
	{ title: "Image", keywords: "picture photo upload library", icon: ImagePlus, run: (chain) => chain, isImage: true },
	{ title: "Quote", keywords: "blockquote", icon: TextQuote, run: (chain) => chain.setBlockquote() },
	{ title: "Divider", keywords: "hr separator line", icon: Minus, run: (chain) => chain.setHorizontalRule() },
	{
		title: "Box",
		keywords: "callout container update promo",
		icon: RectangleHorizontal,
		run: (chain) => chain.wrapIn("callout"),
	},
	{
		title: "Referral block",
		keywords: "share refer friends rewards invite",
		icon: Share2,
		run: (chain) =>
			chain.insertContent({
				type: "callout",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: `Share this newsletter and get rewards. You've referred ${REFERRAL_COUNT_TAG} so far. ` },
							{ type: "text", text: "Your link", marks: [{ type: "link", attrs: { href: REFERRAL_LINK_TAG } }] },
						],
					},
				],
			}),
	},
	{ title: "Button", keywords: "call to action cta link", icon: MousePointerClick, run: (chain) => chain, dialog: "ctaButton" },
	{
		title: "Embed",
		keywords: "youtube video x twitter tweet instagram tiktok bluesky spotify apple podcast audio",
		icon: Clapperboard,
		run: (chain) => chain,
		dialog: "embed",
	},
	{ title: "File", keywords: "attachment download pdf upload", icon: Paperclip, run: (chain) => chain, isFile: true },
	{
		title: "Two columns",
		keywords: "columns side layout grid",
		icon: Columns2,
		run: (chain) =>
			chain.insertContent({
				type: "columns",
				content: [
					{ type: "column", content: [{ type: "paragraph" }] },
					{ type: "column", content: [{ type: "paragraph" }] },
				],
			}),
	},
	{ title: "Table", keywords: "grid rows cells", icon: Table, run: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
	{ title: "Table: add a row", keywords: "table row insert", icon: Rows3, run: (chain) => chain.addRowAfter() },
	{ title: "Table: add a column", keywords: "table column insert", icon: Columns2, run: (chain) => chain.addColumnAfter() },
	{ title: "Table: delete the row", keywords: "table row remove", icon: Trash2, run: (chain) => chain.deleteRow() },
	{ title: "Table: delete the column", keywords: "table column remove", icon: Trash2, run: (chain) => chain.deleteColumn() },
	{ title: "Table: delete the table", keywords: "table remove", icon: Trash2, run: (chain) => chain.deleteTable() },
	{ title: "Footnote", keywords: "note reference citation", icon: Superscript, run: (chain) => chain, dialog: "footnote" },
	{
		title: "Paywall break",
		keywords: "paid subscribers premium upgrade lock",
		icon: Lock,
		run: (chain) => chain.insertContent({ type: "paywallBreak" }),
	},
	{
		title: "Recommended newsletters",
		keywords: "recommendations recommend newsletters share",
		icon: Share2,
		run: (chain) => chain.insertContent({ type: "paragraph", content: [{ type: "text", text: RECOMMENDATIONS_TAG }] }),
	},
];
