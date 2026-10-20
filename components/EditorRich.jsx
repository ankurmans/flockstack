"use client";

import { useId, useState } from "react";
import { rewriteSelection } from "@/app/(app)/campaigns/actions";
import { EditorContent, useEditor } from "@tiptap/react";
import FileHandler from "@tiptap/extension-file-handler";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import DialogAiRewrite from "@/components/DialogAiRewrite";
import DialogEditorBlock from "@/components/DialogEditorBlock";
import DialogImagePicker from "@/components/DialogImagePicker";
import MenuFormat from "@/components/MenuFormat";
import { SlashCommand } from "@/components/MenuSlash";
import { canReplace, readSelection, textToContent } from "@/lib/ai-client";
import { LIMITS } from "@/lib/ai-writing";
import { ATTACHMENT_EXTENSIONS } from "@/lib/attachment-files";
import { Callout } from "@/lib/editor-callout";
import { createBlockExtensions } from "@/lib/editor-nodes";
import { toast } from "@/lib/toast";
import { useAiRun } from "@/lib/use-ai-run";
import { IMAGE_TYPES, getDisplaySize, prepareImage, uploadAttachment, uploadImage } from "@/lib/upload-image";

const MIN_HEIGHT = "min-h-[560px]";

// newsletterId and campaignId: where a poll made in this editor belongs. Without a newsletter, there's no poll block.
// isAiEnabled: the selection's AI menu (rewrite, shorten, tone, translate), only where the server has Workers AI.
export default function EditorRich({ content, onChange, fields = [], newsletterId = null, campaignId = null, isAiEnabled = false }) {
	const [isEditingLink, setIsEditingLink] = useState(false);
	const [isPickingImage, setIsPickingImage] = useState(false);
	// The block whose dialog is open: { kind, attrs, pos }, pos null for a new one.
	const [block, setBlock] = useState(null);
	const fileInputId = useId();
	// The selection the AI is rewriting: { style, language, text, from, to }.
	const [rewrite, setRewrite] = useState(null);
	const rewriting = useAiRun();
	const editor = useEditor({
		immediatelyRender: false,
		content,
		extensions: [
			StarterKit.configure({
				heading: { levels: [1, 2, 3] },
				codeBlock: false,
				link: { openOnClick: false, defaultProtocol: "https" },
				dropcursor: { color: "var(--ring)", width: 2 },
			}),
			Image.configure({
				resize: {
					enabled: true,
					directions: ["left", "right"],
					minWidth: 80,
					minHeight: 40,
					alwaysPreserveAspectRatio: true,
				},
			}),
			Callout,
			...createBlockExtensions({ onEdit: (kind, attrs, pos) => setBlock({ kind, attrs, pos }) }),
			Placeholder.configure({
				placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : "Write, or press / for commands"),
			}),
			FileHandler.configure({
				allowedMimeTypes: IMAGE_TYPES,
				consumePasteEvent: true,
				onDrop: (current, files, position) => insertImages(current, files, position),
				onPaste: (current, files) => insertImages(current, files),
			}),
			SlashCommand.configure({
				onPickImage: () => setIsPickingImage(true),
				onBlock: (kind) => setBlock({ kind, attrs: {}, pos: null }),
				onPickFile: () => document.getElementById(fileInputId)?.click(),
				fields,
				canPoll: Boolean(newsletterId),
			}),
		],
		editorProps: {
			attributes: { class: `prose-issue ${MIN_HEIGHT} px-5 py-5 outline-none`, "aria-label": "Content" },
			handleKeyDown: (view, event) => {
				const isLinkShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
				if (!isLinkShortcut || view.state.selection.empty) return false;
				setIsEditingLink(true);
				return true;
			},
		},
		onUpdate: ({ editor: current }) => onChange(current.getHTML()),
	});

	if (!editor) return <div className={MIN_HEIGHT} />;

	function askRewrite(request) {
		setRewrite(request);
		rewriting.run(() => rewriteSelection(request));
	}

	function startRewrite({ style, language }) {
		const { from, to } = editor.state.selection;
		const text = readSelection(editor.state.doc, from, to);
		if (!text) return;
		if (text.length > LIMITS.selectionChars) return void toast.error(`Select ${LIMITS.selectionChars.toLocaleString("en-US")} characters or fewer`);
		askRewrite({ style, language, text, from, to });
	}

	function closeRewrite() {
		rewriting.reset();
		setRewrite(null);
		editor.commands.focus();
	}

	function replaceSelection(text) {
		const { from, to } = rewrite;
		const blocks = textToContent(text);
		const isInline = blocks.length === 1 && editor.state.doc.resolve(from).sameParent(editor.state.doc.resolve(to));
		editor.chain().focus().insertContentAt({ from, to }, isInline ? blocks[0].content : blocks).run();
		closeRewrite();
	}

	function insertBelow(text) {
		const $to = editor.state.doc.resolve(rewrite.to);
		editor.chain().focus().insertContentAt($to.depth >= 1 ? $to.after(1) : $to.pos, textToContent(text)).run();
		closeRewrite();
	}

	return (
		<>
			<EditorContent editor={editor} />
			<MenuFormat editor={editor} isEditingLink={isEditingLink} onEditLink={setIsEditingLink} onAi={isAiEnabled ? startRewrite : null} />
			{isAiEnabled && (
				<DialogAiRewrite
					request={rewrite}
					run={rewriting}
					canReplace={rewrite ? canReplace(editor.state.doc, rewrite) : false}
					onReplace={replaceSelection}
					onInsertBelow={insertBelow}
					onRetry={() => askRewrite(rewrite)}
					onClose={closeRewrite}
				/>
			)}
			<DialogImagePicker
				open={isPickingImage}
				onOpenChange={setIsPickingImage}
				onSelect={(image) => insertImage(editor, image)}
			/>
			<DialogEditorBlock
				block={block}
				newsletterId={newsletterId}
				campaignId={campaignId}
				fields={fields}
				onOpenChange={(isOpen) => !isOpen && setBlock(null)}
				onSave={(attrs) => {
					saveBlock(editor, block, attrs);
					setBlock(null);
				}}
			/>
			<input
				id={fileInputId}
				type="file"
				hidden
				accept={ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
				onChange={(event) => {
					const [file] = event.target.files;
					event.target.value = "";
					if (file) insertAttachment(editor, file);
				}}
			/>
		</>
	);
}

// A new block goes where the slash command was typed; an edited one keeps its place.
function saveBlock(editor, block, attrs) {
	if (editor.isDestroyed || !block) return;
	if (block.pos === null) {
		editor.chain().focus().insertContent({ type: block.kind, attrs }).run();
		return;
	}
	const node = editor.state.doc.nodeAt(block.pos);
	if (node?.type.name !== block.kind) return;
	editor.view.dispatch(editor.state.tr.setNodeMarkup(block.pos, undefined, { ...node.attrs, ...attrs }));
	editor.commands.focus();
}

// The block shows once the file is stored, with the name it was uploaded under.
async function insertAttachment(editor, file) {
	const toastId = toast.loading(`Uploading ${file.name}`);
	try {
		const { url, name, bytes } = await uploadAttachment(file);
		if (editor.isDestroyed) return;
		editor.chain().focus().insertContent({ type: "fileAttachment", attrs: { href: url, name, size: String(bytes) } }).run();
		toast.dismiss(toastId);
	} catch (error) {
		toast.error(error.message, { id: toastId });
	}
}

// Where the slash command was typed: the editor keeps its selection while the picker has focus.
function insertImage(editor, { url, width, height }) {
	if (editor.isDestroyed) return;
	const size = width && height ? getDisplaySize({ width, height }) : {};
	editor.chain().focus().insertContent({ type: "image", attrs: { src: url, alt: "", ...size } }).run();
}

// Each picture shows right away from the local file and switches to its CDN URL once uploaded. The
// switch stays out of the undo history, so undo never brings back the local preview.
async function insertImages(editor, files, position) {
	for (const file of files) {
		let image;
		try {
			image = await prepareImage(file);
		} catch (error) {
			toast.error(error.message);
			continue;
		}
		if (editor.isDestroyed) return;

		const previewUrl = URL.createObjectURL(image.file);
		const node = { type: "image", attrs: { src: previewUrl, alt: "", ...getDisplaySize(image) } };
		const chain = editor.chain().focus();
		(position === undefined ? chain.insertContent(node) : chain.insertContentAt(position, node)).run();
		position = undefined;

		uploadImage(image.file)
			.then((url) => updateImages(editor, previewUrl, (tr, pos, attrs) => tr.setNodeMarkup(pos, undefined, { ...attrs, src: url })))
			.catch((error) => {
				updateImages(editor, previewUrl, (tr, pos, _attrs, size) => tr.delete(pos, pos + size));
				toast.error(error.message);
			});
	}
}

function updateImages(editor, src, change) {
	if (editor.isDestroyed) return;
	const matches = [];
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "image" && node.attrs.src === src) matches.push({ node, pos });
	});
	if (!matches.length) return;
	const { tr } = editor.state;
	for (const { node, pos } of matches.reverse()) change(tr, pos, node.attrs, node.nodeSize);
	editor.view.dispatch(tr.setMeta("addToHistory", false));
}
