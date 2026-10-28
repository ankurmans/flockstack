import { AsyncLocalStorage } from "node:async_hooks";

// A request for the code that runs inside it: its headers, and a cookie jar that cookies().set() writes
// to, the way a browser keeps the session cookie between requests.
const storage = new AsyncLocalStorage();
// The options each cookie was last set with, per jar, for the tests that check a cookie's path.
const options = new WeakMap();

export function readCookieOptions(jar, name) {
	return options.get(jar)?.get(name);
}

export function runWithRequest({ jar = new Map(), headers = {} } = {}, run) {
	const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
	const requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.10", "user-agent": "node-test", ...headers });
	if (cookie) requestHeaders.set("cookie", cookie);
	return storage.run({ jar, headers: requestHeaders }, run);
}

function current() {
	const request = storage.getStore();
	if (!request) throw new Error("`headers` was called outside a request scope.");
	return request;
}

export async function headers() {
	return current().headers;
}

export async function cookies() {
	const { jar } = current();
	return {
		get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
		getAll: () => [...jar].map(([name, value]) => ({ name, value })),
		has: (name) => jar.has(name),
		set(name, value, setOptions = {}) {
			if (!options.has(jar)) options.set(jar, new Map());
			options.get(jar).set(name, setOptions);
			const isExpired = setOptions.maxAge === 0 || (setOptions.expires && new Date(setOptions.expires) <= new Date());
			if (isExpired || value === "") jar.delete(name);
			else jar.set(name, value);
		},
		delete: (name) => jar.delete(typeof name === "string" ? name : name.name),
	};
}
