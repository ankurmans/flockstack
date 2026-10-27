"use client";

import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import { Crop } from "lucide-react";
import { RESIZE_PRESETS, canCropImage, getActivePreset, getResizedSize } from "@/lib/image-edit";
import { cn } from "@/lib/utils";

const OPTIONS = { placement: "top", offset: 8, flip: true, shift: { padding: 8 } };

function getBody() {
	return document.body;
}

function shouldShow({ editor, state }) {
	return editor.isEditable && state.selection instanceof NodeSelection && state.selection.node.type.name === "image";
}

// What the editor offers for a selected picture: its size (a few widths, besides dragging its sides) and a crop. A picture
// that is a GIF can be resized but not cropped, which would end its animation. onCrop(src).
export default function MenuImage({ editor, onCrop }) {
	const image = useEditorState({
		editor,
		selector: ({ editor: current }) => {
			const { selection } = current.state;
			if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") return null;
			const { src, width, height } = selection.node.attrs;
			return { src, width, height };
		},
	});

	function resize(preset) {
		const { selection } = editor.state;
		if (!(selection instanceof NodeSelection)) return;
		const element = editor.view.nodeDOM(selection.from);
		const picture = element instanceof HTMLImageElement ? element : element?.querySelector?.("img");
		const natural = picture?.naturalWidth ? { width: picture.naturalWidth, height: picture.naturalHeight } : null;
		const size = getResizedSize(preset.width, { current: { width: Number(image?.width), height: Number(image?.height) }, natural });
		editor.chain().focus().updateAttributes("image", size).run();
	}

	const active = getActivePreset(image?.width);

	return (
		<BubbleMenu editor={editor} shouldShow={shouldShow} appendTo={getBody} options={OPTIONS} className="z-50">
			<div role="toolbar" aria-label="Picture" className="flex items-center gap-0.5 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
				{RESIZE_PRESETS.map((preset) => (
					<button
						key={preset.id}
						type="button"
						aria-pressed={active === preset.id}
						title={`${preset.label}, ${preset.width} pixels wide`}
						onClick={() => resize(preset)}
						className={cn(
							"h-8 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground",
							active === preset.id && "bg-accent text-foreground"
						)}
					>
						{preset.label}
					</button>
				))}
				{image && canCropImage(image.src) && (
					<>
						<span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
						<button
							type="button"
							aria-label="Crop"
							title="Crop"
							onClick={() => onCrop(image.src)}
							className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground [&_svg]:size-4"
						>
							<Crop />
						</button>
					</>
				)}
			</div>
		</BubbleMenu>
	);
}
