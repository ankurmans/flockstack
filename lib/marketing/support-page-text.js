// A page's words, read from the React elements its server component returns, one section per heading: what the support
// assistant searches (lib/marketing/support-corpus.js). No react-dom/server, which the server components' layer doesn't
// have. Client components can't run outside a render, so only their children are read.
const ELEMENT_TYPES = new Set([Symbol.for("react.transitional.element"), Symbol.for("react.element")]);
const CLIENT_REFERENCE = Symbol.for("react.client.reference");
const HEADINGS = new Set(["h1", "h2", "h3"]);
const BLOCKS = new Set(["p", "div", "section", "header", "footer", "main", "article", "ul", "ol", "li", "table", "tr", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "blockquote", "pre"]);
const SKIPPED = new Set(["nav", "svg", "script", "style", "button", "form", "input", "select", "textarea", "img"]);
// Code samples are long and say little a person asks about; their start is enough to find them.
const MAX_CODE_CHARS = 400;

const isElement = (node) => node !== null && typeof node === "object" && ELEMENT_TYPES.has(node.$$typeof);

// [{ heading, anchor, text }] in page order. The text before the first heading is under the page's own (heading null).
export async function readPageSections(element) {
	const sections = [{ heading: null, anchor: null, parts: [] }];
	let anchor = null;
	const current = () => sections.at(-1);
	const write = (text) => current().parts.push(text);

	async function walk(node) {
		if (node === null || node === undefined || typeof node === "boolean") return;
		if (typeof node === "string" || typeof node === "number") return write(String(node));
		if (Array.isArray(node)) {
			for (const child of node) await walk(child);
			return;
		}
		if (typeof node?.then === "function") return walk(await node);
		if (!isElement(node)) return;
		const { type, props = {} } = node;
		if (typeof type === "string") return walkHost(type, props);
		if (typeof type === "function" && type.$$typeof !== CLIENT_REFERENCE) {
			let rendered;
			try {
				rendered = await callQuietly(type, props);
			} catch {
				return walk(props.children);
			}
			return walk(rendered);
		}
		return walk(props.children);
	}

	// Outside the server components' layer (tests, scripts) a client component is a plain function, and its first hook
	// throws after React logs it: only that log is dropped. The call is synchronous, so nothing else logs meanwhile.
	function callQuietly(type, props) {
		const log = console.error;
		console.error = (...args) => {
			if (!String(args[0]).startsWith("Invalid hook call")) log(...args);
		};
		try {
			return type(props);
		} finally {
			console.error = log;
		}
	}

	async function walkHost(type, props) {
		if (SKIPPED.has(type)) return;
		if (type === "section" && props.id) anchor = props.id;
		if (HEADINGS.has(type)) {
			const heading = cleanText((await textOf(props.children)).join(" "));
			const own = typeof props.id === "string" ? props.id.replace(/-title$/, "") : null;
			sections.push({ heading, anchor: own ?? anchor, parts: [] });
			return;
		}
		if (type === "pre" || type === "code") {
			const code = cleanText((await textOf(props.children)).join(""));
			write(type === "pre" ? `\n${code.slice(0, MAX_CODE_CHARS)}\n` : `\`${code}\``);
			return;
		}
		if (type === "br") return write("\n");
		const isBlock = BLOCKS.has(type);
		if (isBlock) write(type === "li" ? "\n- " : "\n");
		await walk(props.children);
		if (isBlock) write("\n");
		if (type === "section") anchor = null;
	}

	// Text alone, for a heading or code, without starting sections.
	async function textOf(node) {
		const saved = sections.length;
		sections.push({ heading: null, anchor: null, parts: [] });
		await walk(node);
		const parts = sections.slice(saved).flatMap((section) => section.parts);
		sections.length = saved;
		return parts;
	}

	await walk(element);
	return sections
		.map(({ heading, anchor: id, parts }) => ({ heading, anchor: id, text: cleanText(parts.join("")) }))
		.filter(({ heading, text }) => heading || text);
}

export function cleanText(text) {
	return String(text)
		.replace(/[ \t ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n- \n/g, "\n")
		.replace(/\n+(?=- )/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
