import { FetchProblem, getAddressProblem } from "./fetch.js";

// The engine's fetch on a self-hosted Node server (docs/BRIEFINGS-SAFETY.md, DNS rebinding). Node's own fetch looks a name up
// again when it connects, so a name that answered the fetcher's check with a public address could answer the connection with a
// private one. This one checks every address as the connection opens and connects only to an address it checked, as
// lib/remote-image.js does. It never follows a redirect (the fetcher follows them by hand) and sends no cookies. A Worker has no
// network of its own to reach and keeps the platform's fetch.

// dns.lookup with every answer held to the public-address rule: one private address refuses the name.
export function publicLookup(lookup) {
	return (hostname, options, callback) => {
		lookup(hostname, { ...options, all: true }, (error, addresses) => {
			if (error) return callback(error);
			if (!addresses?.length || addresses.some(({ address }) => getAddressProblem(address))) {
				return callback(Object.assign(new FetchProblem("the name points inside a private network", { final: true }), { code: "EPRIVATE" }));
			}
			if (options?.all) return callback(null, addresses);
			return callback(null, addresses[0].address, addresses[0].family);
		});
	};
}

const NO_BODY = new Set([101, 204, 205, 304]);

// A fetch(input, init) for the engine: GET, HEAD or POST with a string body, the answer as a web Response with its body streamed.
export async function createPinnedFetch({ lookup } = {}) {
	const [http, https, dns, net, { Readable }] = await Promise.all([import("node:http"), import("node:https"), import("node:dns"), import("node:net"), import("node:stream")]);
	const checked = publicLookup(lookup ?? dns.lookup);
	return (input, init = {}) =>
		new Promise((resolve, reject) => {
			const url = new URL(String(input));
			const literal = url.hostname.replace(/^\[|\]$/g, "");
			// An address written as one is never looked up, so it is checked here.
			if (net.isIP(literal) && getAddressProblem(literal)) return reject(new FetchProblem("the address is inside a private network", { final: true }));
			const client = url.protocol === "http:" ? http : https;
			const method = init.method ?? "GET";
			const hasBody = init.body !== undefined && init.body !== null;
			const headers = { ...init.headers, ...(hasBody && { "content-length": String(Buffer.byteLength(init.body)) }) };
			const request = client.request(url, { method, headers, lookup: checked, signal: init.signal, agent: false }, (response) => {
				const answer = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					for (const each of Array.isArray(value) ? value : [value]) if (each !== undefined) answer.append(name, String(each));
				}
				const empty = method === "HEAD" || NO_BODY.has(response.statusCode);
				if (empty) response.resume();
				resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers: answer }));
			});
			request.on("error", reject);
			if (hasBody) request.write(init.body);
			request.end();
		});
}
