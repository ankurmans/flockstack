// Compares what the public pages Worker serves with what the app itself renders, for every path in lib/public-routing.js and
// for several visitors (a country that must consent, one that need not, a saved choice). Run it against the same build of
// both, before the router takes a domain, and again after a deploy.
//   node scripts/verify-public.mjs --app <origin> --public <origin> [--region us|eu] [--only /docs/api,/terms] [--without-help-chat]
// --app: an address that reaches the app Worker directly (its workers.dev address, or the domain before it moves).
// --public: an address that reaches the public pages Worker of the same region as --app (they are one pair per region).
// --without-help-chat: for an app with no Workers AI binding (a local one), which does not render the help chat.
// Exits 1 on the first path that differs, and says how.
import { PUBLIC_EXACT_PATHS } from "../lib/public-routing.js";
import { pathToFileURL } from "node:url";

export const VISITORS = [
	{ name: "a visitor with no country", headers: {} },
	{ name: "a visitor in the US", headers: { "cf-ipcountry": "US" } },
	{ name: "a visitor in Germany", headers: { "cf-ipcountry": "DE" } },
	{ name: "a visitor in France who accepted", headers: { "cf-ipcountry": "FR", cookie: "fs_consent=accepted" } },
	{ name: "a visitor in Japan who declined", headers: { "cf-ipcountry": "JP", cookie: "fs_consent=declined" } },
];

// React streams a part of a page that is not ready (a Suspense boundary) as an empty placeholder and sends the part later, in a
// hidden block that a script moves into place. Whether a boundary is ready when the shell is flushed depends on timing, not on
// the page: a page rendered cold has placeholders where the same page rendered warm has none. This puts each late part where
// its placeholder is, which is where the browser puts it, so what is compared is the page the visitor ends up with.
export function resolveStreaming(html) {
	let result = html;
	for (const [, id] of html.matchAll(/<template id="B:(\d+)"><\/template>/g)) {
		const open = `<div hidden id="S:${id}">`;
		const start = result.indexOf(open);
		if (start === -1) continue;
		let depth = 1;
		let cursor = start + open.length;
		while (depth > 0) {
			const next = /<div\b|<\/div>/g;
			next.lastIndex = cursor;
			const match = next.exec(result);
			if (!match) break;
			depth += match[0] === "</div>" ? -1 : 1;
			cursor = match.index + match[0].length;
			if (depth === 0) {
				const content = result.slice(start + open.length, match.index);
				result = result.slice(0, start) + result.slice(cursor);
				result = result.replace(`<!--$?--><template id="B:${id}"></template>`, `<!--$-->${content}`);
			}
		}
	}
	return result.replace(/<script>(?:\$R[A-Z]|requestAnimationFrame\(function\(\)\{\$RT)[^<]*(?:<(?!\/script>)[^<]*)*<\/script>/g, "");
}

// The help chat's button and panel, which only a Worker with Workers AI bound renders (the public pages are rendered as FlockStack
// Cloud shows them, help chat included). Taken out of both sides when the app being compared has no AI binding, as a local one has.
export function removeHelpChat(html) {
	const open = html.search(/<div data-support-chat="true"[^>]*>/);
	if (open === -1) return html;
	const tag = /<div data-support-chat="true"[^>]*>/.exec(html)[0];
	let depth = 1;
	const pattern = /<div\b|<\/div>/g;
	pattern.lastIndex = open + tag.length;
	for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
		depth += match[0] === "</div>" ? -1 : 1;
		if (depth === 0) return removeHelpChat(html.slice(0, open) + html.slice(match.index + match[0].length));
	}
	return html;
}

// Next.js sends a page's data as pieces of script. How the pieces are cut, and in which order their rows arrive, depends on
// timing too, so the pieces are joined and their rows sorted before the pages are compared.
export function normalize(input, { withoutHelpChat = false } = {}) {
	const resolved = resolveStreaming(input);
	const text = withoutHelpChat ? removeHelpChat(resolved) : resolved;
	const chunks = [];
	const body = text.replace(/<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g, (_, quoted) => {
		chunks.push(JSON.parse(quoted));
		return "<!--flight-->";
	});
	// The rows of that data (one numbered line each) arrive in the order their parts finish, so they are put in order too.
	// Their numbers (and the references to them) are given out in that order as well, so they are taken out: what is compared is
	// the content of each row.
	const rows = chunks
		.join("")
		.split(/\n(?=[0-9a-f]+:)/)
		.map((row) => row.replace(/\n+$/, "").replace(/^[0-9a-f]+:/, ":").replace(/\$L?[0-9a-f]+(?![0-9a-zA-Z.])/g, "$ref"))
		.sort();
	return `${body.replace(/(<!--flight-->)+/g, "<!--flight-->")}\n--flight--\n${rows.join("\n")}`;
}

export function firstDifference(a, b) {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) index++;
	if (index === length && a.length === b.length) return null;
	return { index, a: a.slice(Math.max(0, index - 60), index + 100), b: b.slice(Math.max(0, index - 60), index + 100) };
}

const KEPT = ["content-type", "cache-control", "content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "vary", "access-control-allow-origin"];

async function get(origin, path, headers) {
	const response = await fetch(`${origin}${path}`, { redirect: "manual", headers });
	const body = Buffer.from(await response.arrayBuffer());
	return { status: response.status, headers: Object.fromEntries(KEPT.map((name) => [name, response.headers.get(name)]).filter(([, value]) => value)), body };
}

export async function verify({ app, publicOrigin, region = "us", only = null, withoutHelpChat = false, log = console.log }) {
	const paths = only ?? PUBLIC_EXACT_PATHS;
	const problems = [];
	for (const path of paths) {
		for (const visitor of VISITORS) {
			const expected = await get(app, path, visitor.headers);
			const served = await get(publicOrigin, path, visitor.headers);
			const label = `${region} ${path} for ${visitor.name}`;
			if (served.status !== expected.status) problems.push(`${label}: status ${served.status}, the app gives ${expected.status}`);
			for (const name of KEPT) {
				if ((served.headers[name] ?? null) !== (expected.headers[name] ?? null)) problems.push(`${label}: ${name} is ${JSON.stringify(served.headers[name])}, the app gives ${JSON.stringify(expected.headers[name])}`);
			}
			const isText = /^(text|application)\//.test(expected.headers["content-type"] ?? "");
			const same = isText ? firstDifference(normalize(served.body.toString("utf8"), { withoutHelpChat }), normalize(expected.body.toString("utf8"), { withoutHelpChat })) : Buffer.compare(served.body, expected.body) === 0 ? null : { index: 0, a: "(binary)", b: "(binary)" };
			if (same) problems.push(`${label}: the body differs at ${same.index}\n    served: ${JSON.stringify(same.a)}\n    app:    ${JSON.stringify(same.b)}`);
		}
		log(`  ${path}: ${VISITORS.length} visitors checked`);
	}
	return problems;
}

function parse(argv) {
	const options = { region: "us", only: null };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--app") options.app = argv[++index];
		else if (argument === "--public") options.publicOrigin = argv[++index];
		else if (argument === "--region") options.region = argv[++index];
		else if (argument === "--only") options.only = argv[++index].split(",");
		else if (argument === "--without-help-chat") options.withoutHelpChat = true;
		else throw new Error(`Unknown option ${argument}. Options: --app <origin>, --public <origin>, --region us|eu, --only <paths>, --without-help-chat.`);
	}
	if (!options.app || !options.publicOrigin) throw new Error("Give --app and --public.");
	if (!["us", "eu"].includes(options.region)) throw new Error("--region takes us or eu.");
	return { ...options, app: options.app.replace(/\/$/, ""), publicOrigin: options.publicOrigin.replace(/\/$/, "") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const options = parse(process.argv.slice(2));
		const problems = await verify(options);
		if (problems.length > 0) {
			console.error(`\n${problems.length} difference${problems.length === 1 ? "" : "s"}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
			process.exit(1);
		}
		console.log("\nThe public pages Worker serves what the app renders.");
	} catch (error) {
		console.error(`\n${error.message}`);
		process.exit(1);
	}
}
