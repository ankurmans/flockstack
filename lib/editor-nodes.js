import { MAX_SNIPPET_CHARS, readHtmlSnippet } from "./html-snippets.js";
import { Node, mergeAttributes } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { parseEmbed } from "./embeds.js";
import { FEED_BLOCK } from "./editor-blocks.js";
import { readSponsorshipBlock } from "./sponsorship-blocks.js";

// The editor's blocks past text and pictures. Each one's HTML is what lib/editor-blocks.js reads; the editor shows a
// plain stand-in for it (a frame or a vote link has no place while writing). A double click on a block, or Enter
// while it's selected, calls onEdit(kind, attrs, pos) so the editor can open its dialog.

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

// A block drawn by draw(dom, attrs), redrawn when its attributes change.
function atomView(kind, draw, getOnEdit) {
	return ({ node, getPos }) => {
		let current = node;
		const dom = element("div", `editor-block editor-block-${kind}`);
		dom.contentEditable = "false";
		dom.dataset.editorBlock = kind;
		const redraw = () => {
			dom.replaceChildren();
			draw(dom, current.attrs);
		};
		redraw();
		dom.addEventListener("dblclick", () => getOnEdit()?.(kind, current.attrs, getPos()));
		return {
			dom,
			update(updated) {
				if (updated.type !== current.type) return false;
				current = updated;
				redraw();
				return true;
			},
		};
	};
}

function editOnEnter(kind) {
	return {
		Enter: ({ editor }) => {
			const { selection } = editor.state;
			if (selection.node?.type.name !== kind) return false;
			editor.storage[kind]?.onEdit?.(kind, selection.node.attrs, selection.from);
			return Boolean(editor.storage[kind]?.onEdit);
		},
	};
}

function blockNode(name, { attributes, parseHTML, renderHTML, draw }) {
	return Node.create({
		name,
		group: "block",
		atom: true,
		selectable: true,
		draggable: true,
		addOptions() {
			return { onEdit: null };
		},
		addStorage() {
			return { onEdit: this.options.onEdit };
		},
		addAttributes: () => attributes,
		parseHTML,
		renderHTML,
		addNodeView() {
			return atomView(name, draw, () => this.options.onEdit);
		},
		addKeyboardShortcuts() {
			return editOnEnter(name);
		},
	});
}

// Attributes the node's own parseHTML and renderHTML handle, never written onto the element as they are.
const plain = () => ({ default: "", parseHTML: () => null, renderHTML: () => ({}) });

export const SponsorPlacement = blockNode("sponsorPlacement", {
	attributes: { source: plain() },
	parseHTML: () => [{ tag: "div[data-sponsorship]", getAttrs: node => ({ source: node.getAttribute("data-sponsorship") ?? "invalid" }) }],
	renderHTML: ({ node }) => ["div", { "data-sponsorship": node.attrs.source }],
	draw: (dom, attrs) => { const data = readSponsorshipBlock(attrs.source); dom.append(element("strong", "editor-block-title", "Sponsored"), element("p", "editor-block-note", data?.creative.headline ?? "Sponsor placement unavailable"), element("p", "editor-block-note", data?.creative.body ?? "")); },
});

export const HtmlSnippet = blockNode("htmlSnippet", {
	attributes: { source: plain() },
	parseHTML: () => [{ tag: "div[data-html]", getAttrs: (node) => ({ source: readHtmlSnippet(node.getAttribute("data-html")) }) }],
	renderHTML: ({ node }) => ["div", { "data-html": encodeURIComponent(String(node.attrs.source ?? "").slice(0, MAX_SNIPPET_CHARS)) }],
	draw: (dom, attrs) => { dom.append(element("strong", "editor-block-title", "HTML snippet"), element("pre", "editor-block-note", String(attrs.source ?? "").slice(0, 250))); },
});

export const CtaButton = blockNode("ctaButton", {
	attributes: { href: plain(), label: plain() },
	parseHTML: () => [
		{
			tag: "div[data-button]",
			getAttrs: (dom) => {
				const link = dom.querySelector("a");
				return { href: link?.getAttribute("href") ?? "", label: (link ?? dom).textContent.trim() };
			},
		},
	],
	renderHTML: ({ node }) => ["div", { "data-button": "" }, ["a", { href: node.attrs.href }, node.attrs.label || "Button"]],
	draw: (dom, { label, href }) => {
		dom.append(element("span", "editor-block-button", label || "Button"), element("span", "editor-block-meta", href || "Add a link"));
	},
});

export const Embed = blockNode("embed", {
	attributes: { url: plain() },
	parseHTML: () => [{ tag: "div[data-embed]", getAttrs: (dom) => ({ url: dom.getAttribute("data-embed") ?? "" }) }],
	renderHTML: ({ node }) => ["div", { "data-embed": node.attrs.url }],
	draw: (dom, { url }) => {
		const embed = parseEmbed(url);
		dom.append(element("span", "editor-block-title", embed ? embed.name : "Embed"), element("span", "editor-block-meta", embed ? embed.url : `Not a link FlockStack can embed: ${url}`));
	},
});

export const TableOfContents = blockNode("tableOfContents", {
	attributes: {},
	parseHTML: () => [{ tag: "div[data-toc]" }],
	renderHTML: () => ["div", { "data-toc": "" }],
	draw: (dom) => { dom.append(element("span", "editor-block-title", "Table of contents"), element("span", "editor-block-meta", "Built from the headings each reader can see")); },
});

export const PaywallBreak = blockNode("paywallBreak", {
	attributes: {},
	parseHTML: () => [{ tag: "div[data-paywall]" }],
	renderHTML: () => ["div", { "data-paywall": "" }],
	draw: (dom) => {
		dom.append(element("span", "editor-block-meta", "Paywall: only paid subscribers read on from here"));
	},
});

export const FileAttachment = blockNode("fileAttachment", {
	attributes: { href: plain(), name: plain(), size: plain() },
	parseHTML: () => [
		{
			tag: "div[data-file]",
			getAttrs: (dom) => {
				const link = dom.querySelector("a");
				return { href: link?.getAttribute("href") ?? "", name: link?.textContent.trim() ?? "", size: dom.getAttribute("data-size") ?? "" };
			},
		},
	],
	renderHTML: ({ node }) => ["div", { "data-file": "", ...(node.attrs.size && { "data-size": String(node.attrs.size) }) }, ["a", { href: node.attrs.href }, node.attrs.name || "Download"]],
	draw: (dom, { name, href }) => {
		dom.append(element("span", "editor-block-title", name || "File"), element("span", "editor-block-meta", href.startsWith("blob:") ? "Uploading…" : "File to download"));
	},
});

export const Poll = blockNode("poll", {
	attributes: { id: plain(), question: plain(), options: { default: [], parseHTML: () => null, renderHTML: () => ({}) } },
	parseHTML: () => [
		{
			tag: "div[data-poll]",
			getAttrs: (dom) => ({
				id: dom.getAttribute("data-poll") ?? "",
				question: dom.querySelector("p")?.textContent.trim() ?? "",
				options: [...dom.querySelectorAll("li")].map((item) => item.textContent.trim()).filter(Boolean),
			}),
		},
	],
	renderHTML: ({ node }) => ["div", { "data-poll": node.attrs.id }, ["p", node.attrs.question], ["ol", ...node.attrs.options.map((option) => ["li", option])]],
	draw: (dom, { question, options }) => {
		dom.append(element("span", "editor-block-title", question || "Poll"));
		const list = element("span", "editor-block-options");
		for (const option of options) list.append(element("span", "editor-block-option", option));
		dom.append(list);
	},
});

const kept = (value) => ({ default: value, parseHTML: () => null, renderHTML: () => ({}) });

// The latest items of an RSS feed, read when the issue is sent (lib/feed-resolve.js).
export const RssFeed = blockNode("rssFeed", {
	attributes: { url: plain(), count: kept(FEED_BLOCK.defaultCount), order: kept("newest"), image: kept(true), excerpt: kept(true), date: kept(true) },
	parseHTML: () => [
		{
			tag: "div[data-rss]",
			getAttrs: (dom) => ({
				url: dom.getAttribute("data-rss") ?? "",
				count: Number.parseInt(dom.getAttribute("data-count") ?? "", 10) || FEED_BLOCK.defaultCount,
				order: dom.getAttribute("data-order") === "oldest" ? "oldest" : "newest",
				image: dom.getAttribute("data-image") !== "0",
				excerpt: dom.getAttribute("data-excerpt") !== "0",
				date: dom.getAttribute("data-date") !== "0",
			}),
		},
	],
	renderHTML: ({ node }) => [
		"div",
		{
			"data-rss": node.attrs.url,
			"data-count": String(node.attrs.count),
			"data-order": node.attrs.order,
			"data-image": node.attrs.image ? "1" : "0",
			"data-excerpt": node.attrs.excerpt ? "1" : "0",
			"data-date": node.attrs.date ? "1" : "0",
		},
	],
	draw: (dom, { url, count, order }) => {
		let host = url;
		try {
			host = new URL(url).hostname;
		} catch {
			// The dialog checks the address; a stand-in shows whatever was saved.
		}
		dom.append(element("span", "editor-block-title", "RSS feed"), element("span", "editor-block-meta", `${count} ${order === "oldest" ? "oldest of the latest" : "latest"} from ${host}, read when the issue is sent`));
	},
});

// Two columns side by side, which stack on a phone.
export const Columns = Node.create({
	name: "columns",
	group: "block",
	content: "column column",
	defining: true,
	isolating: true,
	parseHTML: () => [{ tag: "div[data-columns]" }],
	renderHTML: () => ["div", { "data-columns": "" }, 0],
});

export const Column = Node.create({
	name: "column",
	content: "block+",
	isolating: true,
	parseHTML: () => [{ tag: "div[data-column]" }],
	renderHTML: () => ["div", { "data-column": "" }, 0],
});

// A note at the bottom of the issue, numbered where it's placed. Its text is the element's, so the cleaner keeps it
// like any text.
export const Footnote = Node.create({
	name: "footnote",
	group: "inline",
	inline: true,
	atom: true,
	selectable: true,
	addOptions() {
		return { onEdit: null };
	},
	addAttributes: () => ({ text: plain() }),
	parseHTML: () => [{ tag: "sup[data-footnote]", getAttrs: (dom) => ({ text: dom.textContent.trim() }) }],
	renderHTML({ node, HTMLAttributes }) {
		return ["sup", mergeAttributes(HTMLAttributes, { "data-footnote": "" }), node.attrs.text];
	},
	addNodeView() {
		return ({ node, getPos }) => {
			let current = node;
			const dom = element("sup", "editor-footnote", "note");
			dom.title = node.attrs.text;
			dom.contentEditable = "false";
			dom.addEventListener("dblclick", () => this.options.onEdit?.("footnote", current.attrs, getPos()));
			return {
				dom,
				update(updated) {
					if (updated.type !== current.type) return false;
					current = updated;
					dom.title = updated.attrs.text;
					return true;
				},
			};
		};
	},
});

// onEdit(kind, attrs, pos): opens a block's dialog.
export function createBlockExtensions({ onEdit }) {
	return [
		SponsorPlacement,
		AudienceBlock.configure({ onEdit }),
		HtmlSnippet.configure({ onEdit }),
		CtaButton.configure({ onEdit }),
		Embed.configure({ onEdit }),
		PaywallBreak,
		TableOfContents,
		FileAttachment,
		Poll.configure({ onEdit }),
		RssFeed.configure({ onEdit }),
		Columns,
		Column,
		Footnote.configure({ onEdit }),
		Table.configure({ resizable: false }),
		TableRow,
		TableHeader,
		TableCell,
	];
}

export const AudienceBlock = Node.create({
	name: "audienceBlock", group: "block", content: "block+", defining: true, isolating: true,
	addOptions() { return { onEdit: null }; },
	addAttributes: () => ({ access: { ...plain(), default: "paid" }, minTier: plain() }),
	parseHTML: () => [{ tag: "div[data-access]", getAttrs: (node) => ({ access: node.getAttribute("data-access") ?? "paid", minTier: node.getAttribute("data-min-tier") ?? "" }) }],
	renderHTML: ({ node }) => ["div", { "data-access": node.attrs.access, ...(node.attrs.minTier && { "data-min-tier": node.attrs.minTier }) }, 0],
	addNodeView() {
		return ({ node, getPos }) => {
			let current = node; const dom = element("div", "editor-block editor-block-audience"), label = element("button", "editor-block-title"), contentDOM = element("div", "editor-audience-content");
			label.type = "button"; label.contentEditable = "false";
			const draw = () => { label.textContent = current.attrs.access === "free" ? "Free readers only · edit" : current.attrs.minTier ? "Selected paid tier and above · edit" : "Paid readers only · edit"; };
			label.addEventListener("click", () => this.options.onEdit?.("audienceBlock", current.attrs, getPos())); draw(); dom.append(label, contentDOM);
			return { dom, contentDOM, update(updated) { if (updated.type !== current.type) return false; current = updated; draw(); return true; } };
		};
	},
});
