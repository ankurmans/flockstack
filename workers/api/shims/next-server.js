// next/server in the lean API Worker: after() is the runtime hook's, NextResponse is a Response with the statics routes use.
export { after } from "../runtime-hooks.js";

export class NextResponse extends Response {
	static json(body, init) {
		return Response.json(body, init);
	}
	static redirect(url, status = 307) {
		return Response.redirect(String(url), status);
	}
	static next() {
		return new Response(null);
	}
}

export class NextRequest extends Request {}
