// next/server in the lean API Worker: after() is the runtime hook's, NextResponse is a Response with the statics routes use.
export { after } from "../runtime-hooks.js";

export class NextResponse extends Response {
	static json(body, init) {
		return Response.json(body, init);
	}
	// Not Response.redirect(): its headers are immutable, and routes set Cache-Control on the answer, as they can on Next.js's.
	static redirect(url, init) {
		const status = typeof init === "number" ? init : (init?.status ?? 307);
		if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Failed to execute "redirect" on "response": Invalid status code');
		const headers = new Headers(typeof init === "object" ? init.headers : undefined);
		headers.set("Location", String(new URL(String(url))));
		return new NextResponse(null, { status, headers });
	}
	static next() {
		return new Response(null);
	}
}

export class NextRequest extends Request {}
