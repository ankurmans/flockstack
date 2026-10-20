"use client";

import { useMemo, useState } from "react";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import { Bold, ChevronLeft, CornerDownLeft, Heading1, Heading2, Italic, Link, Sparkles, Strikethrough, TextQuote, Unlink } from "lucide-react";
import { LANGUAGES } from "@/lib/ai-writing";
import { isReferralLinkTag } from "@/lib/referral-tags";
import { cn } from "@/lib/utils";

const AI_QUICK = [
	{ style: "rewrite", label: "Rewrite" },
	{ style: "shorten", label: "Shorten" },
	{ style: "expand", label: "Expand" },
	{ style: "fix_grammar", label: "Fix grammar" },
];
const AI_TONES = [
	{ value: "friendly", label: "Friendly" },
	{ value: "formal", label: "Formal" },
	{ value: "punchy", label: "Punchy" },
];

// onAi({ style, language }): given only where the server has Workers AI and the account a plan; without it there is no AI button.
export default function MenuFormat({ editor, isEditingLink, onEditLink, onAi = null }) {
	const [isAiOpen, setIsAiOpen] = useState(false);
	const state = useEditorState({
		editor,
		selector: ({ editor: current }) => ({
			isBold: current.isActive("bold"),
			isItalic: current.isActive("italic"),
			isStrike: current.isActive("strike"),
			isLink: current.isActive("link"),
			href: current.getAttributes("link").href ?? "",
			isTitle: current.isActive("heading", { level: 1 }),
			isHeading: current.isActive("heading", { level: 2 }),
			isQuote: current.isActive("blockquote"),
		}),
	});
	const options = useMemo(
		() => ({ placement: "top", offset: 8, flip: true, shift: { padding: 8 }, onHide: () => {
				onEditLink(false);
				setIsAiOpen(false);
			},
		}),
		[onEditLink]
	);

	function closeLink() {
		onEditLink(false);
		editor.commands.focus();
	}

	function applyLink(event) {
		event.preventDefault();
		const href = normalizeUrl(new FormData(event.currentTarget).get("href"));
		const chain = editor.chain().focus().extendMarkRange("link");
		(href ? chain.setLink({ href }) : chain.unsetLink()).run();
		onEditLink(false);
	}

	function removeLink() {
		editor.chain().focus().extendMarkRange("link").unsetLink().run();
		onEditLink(false);
	}

	return (
		<BubbleMenu editor={editor} shouldShow={shouldShowMenu} appendTo={getBody} options={options} className="z-50">
			<div className="flex items-center gap-0.5 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
				{isAiOpen && onAi ? (
					<div className="flex items-center gap-0.5" role="group" aria-label="Write with AI">
						<ButtonFormat label="Back" onClick={() => setIsAiOpen(false)}>
							<ChevronLeft />
						</ButtonFormat>
						{AI_QUICK.map(({ style, label }) => (
							<button key={style} type="button" onClick={() => onAi({ style })} className={AI_BUTTON}>
								{label}
							</button>
						))}
						<SelectAi label="Tone" options={AI_TONES} onPick={(style) => onAi({ style })} />
						<SelectAi label="Translate" options={LANGUAGES.map((language) => ({ value: language, label: language }))} onPick={(language) => onAi({ style: "translate", language })} />
					</div>
				) : isEditingLink ? (
					<form onSubmit={applyLink} className="flex items-center gap-0.5">
						<input
							name="href"
							type="text"
							inputMode="url"
							autoFocus
							defaultValue={state.href}
							placeholder="Paste a link"
							aria-label="Link"
							onKeyDown={(event) => event.key === "Escape" && closeLink()}
							className="h-8 w-60 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
						/>
						{state.isLink && (
							<ButtonFormat label="Remove link" onClick={removeLink}>
								<Unlink />
							</ButtonFormat>
						)}
						<ButtonFormat label="Apply link" type="submit">
							<CornerDownLeft />
						</ButtonFormat>
					</form>
				) : (
					<>
						<ButtonFormat label="Bold" isActive={state.isBold} onClick={() => editor.chain().focus().toggleBold().run()}>
							<Bold />
						</ButtonFormat>
						<ButtonFormat
							label="Italic"
							isActive={state.isItalic}
							onClick={() => editor.chain().focus().toggleItalic().run()}
						>
							<Italic />
						</ButtonFormat>
						<ButtonFormat
							label="Strikethrough"
							isActive={state.isStrike}
							onClick={() => editor.chain().focus().toggleStrike().run()}
						>
							<Strikethrough />
						</ButtonFormat>
						<ButtonFormat label="Link (⌘K)" isActive={state.isLink} onClick={() => onEditLink(true)}>
							<Link />
						</ButtonFormat>
						<span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
						<ButtonFormat
							label="Heading 1"
							isActive={state.isTitle}
							onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
						>
							<Heading1 />
						</ButtonFormat>
						<ButtonFormat
							label="Heading 2"
							isActive={state.isHeading}
							onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
						>
							<Heading2 />
						</ButtonFormat>
						<ButtonFormat
							label="Quote"
							isActive={state.isQuote}
							onClick={() => editor.chain().focus().toggleBlockquote().run()}
						>
							<TextQuote />
						</ButtonFormat>
						{onAi && (
							<>
								<span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
								<ButtonFormat label="Write with AI" onClick={() => setIsAiOpen(true)}>
									<Sparkles />
								</ButtonFormat>
							</>
						)}
					</>
				)}
			</div>
		</BubbleMenu>
	);
}

const AI_BUTTON = "h-8 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground";

// A native select inside the menu keeps the editor's selection and the menu open while it is used.
function SelectAi({ label, options, onPick }) {
	return (
		<select
			aria-label={label}
			value=""
			onChange={(event) => event.target.value && onPick(event.target.value)}
			className={`${AI_BUTTON} cursor-pointer bg-transparent`}
		>
			<option value="">{label}</option>
			{options.map(({ value, label: text }) => (
				<option key={value} value={value}>
					{text}
				</option>
			))}
		</select>
	);
}

function ButtonFormat({ label, isActive, type = "button", onClick, children }) {
	return (
		<button
			type={type}
			aria-label={label}
			title={label}
			aria-pressed={isActive}
			onClick={onClick}
			className={cn(
				"grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground [&_svg]:size-4",
				isActive && "bg-accent text-foreground"
			)}
		>
			{children}
		</button>
	);
}

// The editor's card clips its overflow, which would cut the menu off at the top of the content.
function getBody() {
	return document.body;
}

// Text selections only: images and dividers have nothing to format.
function shouldShowMenu({ editor, view, state, from, to }) {
	if (!editor.isEditable || from === to || state.selection instanceof NodeSelection) return false;
	return view.hasFocus();
}

function normalizeUrl(value) {
	const url = String(value ?? "").trim();
	if (!url || /^(https?:|mailto:)/i.test(url) || isReferralLinkTag(url)) return url;
	if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
	return `https://${url}`;
}
