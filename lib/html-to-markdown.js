// Issues written in the editor are HTML fragments of a few tags (lib/clean-html.js CONTENT_TAGS); this turns them back into
// Markdown for an export. A tag it doesn't know keeps its text.
const TAG_PATTERN = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)|</gi;
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
const VOID_TAGS = new Set(["br", "hr", "img"]);

function decode(text) {
	return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => ENTITIES[entity]);
}

function readAttribute(attributes, name) {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
	return decode(match?.[1] ?? match?.[2] ?? "");
}

function escapeMarkdown(text) {
	return text.replace(/([\\`*_[\]])/g, "\\$1");
}

function parse(html) {
	const root = { tag: "root", children: [] };
	const stack = [root];
	for (const [, closing, tag, attributes = "", text] of String(html ?? "").matchAll(TAG_PATTERN)) {
		const top = stack.at(-1);
		if (text !== undefined) {
			top.children.push({ text: decode(text) });
		} else if (!tag) {
			top.children.push({ text: "<" });
		} else if (closing) {
			const index = stack.findLastIndex((node) => node.tag === tag.toLowerCase());
			if (index > 0) stack.length = index;
		} else if (VOID_TAGS.has(tag.toLowerCase())) {
			top.children.push({ tag: tag.toLowerCase(), attributes, children: [] });
		} else {
			const node = { tag: tag.toLowerCase(), attributes, children: [] };
			top.children.push(node);
			stack.push(node);
		}
	}
	return root;
}

export function htmlToMarkdown(html) {
	const markdown = render(parse(html).children, { listDepth: 0 });
	return `${markdown.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function render(children, context) {
	return children.map((node) => renderNode(node, context)).join("");
}

function renderList(node, context, isOrdered) {
	const indent = "  ".repeat(context.listDepth);
	let number = Number.parseInt(readAttribute(node.attributes, "start"), 10) || 1;
	const items = node.children
		.filter((child) => child.tag === "li")
		.map((item) => {
			const marker = isOrdered ? `${number++}.` : "-";
			const body = render(item.children, { ...context, listDepth: context.listDepth + 1 }).trim().replace(/\n\n+/g, "\n");
			return `${indent}${marker} ${body}`;
		});
	return context.listDepth > 0 ? `\n${items.join("\n")}\n` : `\n\n${items.join("\n")}\n\n`;
}

function renderNode(node, context) {
	if (node.text !== undefined) return context.isCode ? node.text : escapeMarkdown(node.text.replace(/\s+/g, " "));
	const inner = () => render(node.children, context).trim();
	switch (node.tag) {
		case "p":
		case "div":
			return `\n\n${inner()}\n\n`;
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6":
			return `\n\n${"#".repeat(Number(node.tag[1]))} ${inner()}\n\n`;
		case "strong":
		case "b":
			return `**${inner()}**`;
		case "em":
		case "i":
			return `*${inner()}*`;
		case "del":
		case "s":
			return `~~${inner()}~~`;
		case "code":
			return context.isCode ? inner() : `\`${render(node.children, { ...context, isCode: true })}\``;
		case "pre":
			return `\n\n\`\`\`\n${render(node.children, { ...context, isCode: true }).replace(/\n+$/, "")}\n\`\`\`\n\n`;
		case "a": {
			const href = readAttribute(node.attributes, "href");
			const label = inner();
			return href ? `[${label || href}](${href})` : label;
		}
		case "img": {
			const src = readAttribute(node.attributes, "src");
			return src ? `![${readAttribute(node.attributes, "alt")}](${src})` : "";
		}
		case "br":
			return "  \n";
		case "hr":
			return "\n\n---\n\n";
		case "blockquote":
			return `\n\n${inner().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
		case "ul":
			return renderList(node, context, false);
		case "ol":
			return renderList(node, context, true);
		case "li":
			return `- ${inner()}\n`;
		case "tr":
			return `${node.children.map((cell) => render(cell.children, context).trim().replaceAll("|", "\\|")).join(" | ")}\n`;
		case "table":
			return `\n\n${inner()}\n\n`;
		default:
			return render(node.children, context);
	}
}
