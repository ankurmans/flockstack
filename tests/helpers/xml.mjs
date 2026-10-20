import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A strict XML 1.0 reader for checking feeds: it throws on anything a validating parser would refuse (a stray & or <, a
// tag that isn't closed or closed in the wrong order, an attribute without quotes or repeated, a prefix nobody declared,
// a control character, two roots, text outside the root) and answers a tree of { name, attributes, children, text }.
const NAME = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y;
const REFERENCE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

function decode(text) {
	return text.replace(REFERENCE, (_, name) => {
		if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
		return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name];
	});
}

export function parseXml(xml) {
	if (!xml.startsWith('<?xml version="1.0"')) throw new Error("the XML declaration has to come first");
	if (INVALID.test(xml)) throw new Error("a control character is not allowed in XML");
	let position = xml.indexOf("?>") + 2;
	if (position < 2) throw new Error("the XML declaration is not closed");
	const stack = [];
	let root = null;

	const fail = (message) => {
		throw new Error(`${message} at ${position}: ${JSON.stringify(xml.slice(position, position + 40))}`);
	};
	const checkText = (text) => {
		for (let index = 0; index < text.length; index += 1) {
			if (text[index] === "<") fail("< in text");
			if (text[index] === "&") {
				ENTITY.lastIndex = index;
				if (!ENTITY.test(text)) fail("a & that is not a character or entity reference");
			}
		}
	};
	const declared = (prefix) => prefix === "xml" || stack.some((element) => element.attributes[`xmlns:${prefix}`] !== undefined);

	while (position < xml.length) {
		if (xml[position] !== "<") {
			const end = xml.indexOf("<", position);
			const text = xml.slice(position, end === -1 ? xml.length : end);
			if (stack.length === 0) {
				if (text.trim()) fail("text outside the root");
			} else {
				checkText(text);
				stack.at(-1).text += decode(text);
			}
			position = end === -1 ? xml.length : end;
			continue;
		}
		if (xml.startsWith("<!--", position)) {
			const end = xml.indexOf("-->", position + 4);
			if (end === -1) fail("a comment that is not closed");
			position = end + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", position)) {
			const end = xml.indexOf("]]>", position);
			if (end === -1 || stack.length === 0) fail("a CDATA section that is not closed or is outside the root");
			stack.at(-1).text += xml.slice(position + 9, end);
			position = end + 3;
			continue;
		}
		if (xml.startsWith("</", position)) {
			NAME.lastIndex = position + 2;
			const name = NAME.exec(xml)?.[0];
			if (!name) fail("a closing tag without a name");
			let end = position + 2 + name.length;
			while (/\s/.test(xml[end])) end += 1;
			if (xml[end] !== ">") fail("a closing tag that is not closed");
			const open = stack.pop();
			if (!open || open.name !== name) fail(`</${name}> closes ${open?.name ?? "nothing"}`);
			position = end + 1;
			continue;
		}
		NAME.lastIndex = position + 1;
		const name = NAME.exec(xml)?.[0];
		if (!name) fail("a tag without a name");
		position += 1 + name.length;
		const element = { name, attributes: {}, children: [], text: "" };
		for (;;) {
			const space = /^\s*/.exec(xml.slice(position))[0].length;
			position += space;
			if (xml.startsWith("/>", position) || xml[position] === ">") break;
			if (space === 0) fail("attributes have to be separated by a space");
			NAME.lastIndex = position;
			const attribute = NAME.exec(xml)?.[0];
			if (!attribute) fail("an attribute without a name");
			position += attribute.length;
			if (xml[position] !== "=") fail("an attribute without a value");
			const quote = xml[position + 1];
			if (quote !== '"' && quote !== "'") fail("an attribute value without quotes");
			const end = xml.indexOf(quote, position + 2);
			if (end === -1) fail("an attribute value that is not closed");
			const value = xml.slice(position + 2, end);
			checkText(value);
			if (attribute in element.attributes) fail(`${attribute} appears twice`);
			element.attributes[attribute] = decode(value);
			position = end + 1;
		}
		stack.push(element);
		const prefixes = [name, ...Object.keys(element.attributes).filter((attribute) => !attribute.startsWith("xmlns"))].filter((value) => value.includes(":")).map((value) => value.split(":")[0]);
		for (const prefix of prefixes) if (!declared(prefix)) fail(`the prefix ${prefix} is not declared`);
		if (stack.length > 1) stack.at(-2).children.push(element);
		else if (root) fail("two root elements");
		else root = element;
		if (xml.startsWith("/>", position)) {
			stack.pop();
			position += 2;
		} else {
			position += 1;
		}
	}
	if (stack.length > 0) throw new Error(`${stack.at(-1).name} is not closed`);
	if (!root) throw new Error("no root element");
	return root;
}

export const childrenOf = (element, name) => element.children.filter((child) => child.name === name);
export const childOf = (element, name) => childrenOf(element, name)[0] ?? null;
export const textOf = (element, name) => childOf(element, name)?.text ?? null;

// A real parser's verdict when the machine has xmllint: null without it.
export function lintXml(xml) {
	const folder = mkdtempSync(join(tmpdir(), "audio-xml-"));
	try {
		const file = join(folder, "feed.xml");
		writeFileSync(file, xml);
		const result = spawnSync("xmllint", ["--noout", file], { encoding: "utf8" });
		if (result.error) return null;
		return { ok: result.status === 0, stderr: result.stderr };
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
