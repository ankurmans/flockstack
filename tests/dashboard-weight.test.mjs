import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { closure, whyLoaded } from "../scripts/page-closure.mjs";

// What a dashboard page evaluates the first time it is asked for in a Worker (scripts/page-closure.mjs): the Worker runs every module a
// page imports before it answers, so a package that only an action, a webhook, an editor or the sign-in flow needs must not sit in the
// import closure of the pages everybody opens. The first dashboard request of an isolate that had answered nothing else cost 0.85 to
// 0.96 s locally before these were made lazy (docs/PERFORMANCE.md); the AWS and Stripe SDKs, the Upstash clients, the action registry
// with its zod schemas and Better Auth's OAuth provider were 1.5 MB of that page's code and none of it was used to show it.
const NEVER_ON_A_PAGE = ["@aws-sdk/", "@smithy/", "node_modules/stripe/", "@upstash/", "node_modules/zod/", "@modelcontextprotocol/", "node_modules/jose/", "@better-auth/oauth-provider", "@better-auth/mcp", "@better-auth/cimd", "better-auth/dist/api/", "lib/docs/reference.js", "lib/actions/registry.js", "lib/mcp/"];
const EDITOR_STACK = ["@tiptap/", "prosemirror-"];
const PAGES = {
	"the layout": "app/(app)/layout.js",
	"the overview": "app/(app)/(overview)/page.js",
	"campaigns": "app/(app)/campaigns/(list)/page.js",
	"the calendar": "app/(app)/campaigns/calendar/page.js",
	"contacts": "app/(app)/contacts/page.js",
	"reports": "app/(app)/reports/page.js",
	"issue reports": "app/(app)/reports/issues/page.js",
	"segments": "app/(app)/segments/page.js",
	"forms": "app/(app)/forms/page.js",
	"domains": "app/(app)/domains/page.js",
	"comments": "app/(app)/comments/page.js",
	"automations": "app/(app)/automations/page.js",
	"API keys": "app/(app)/api-keys/page.js",
	"agent activity": "app/(app)/agent-activity/page.js",
	"the account page": "app/(account)/account/page.js",
	"billing": "app/(account)/billing/page.js",
	"the sign-in page": "app/signin/page.js",
};
const EDITORS = { "the campaign editor": "app/(app)/campaigns/[id]/page.js", "the automation editor": "app/(app)/automations/[id]/page.js" };
// MB of code in the closure. The sign-in page and the layout are every visit's; the rest has room for the page itself.
const LIMITS = { "the layout": 1.35, "the sign-in page": 1.1 };
const DEFAULT_LIMIT = 1.9;

describe("the pages everybody opens", () => {
	for (const [name, entry] of Object.entries(PAGES)) {
		test(`${name} loads no SDK, no schemas, no editor and no OAuth code, and stays small`, async () => {
			const result = await closure(entry);
			const packages = [...result.packages.keys()];
			const forbidden = [...NEVER_ON_A_PAGE, ...EDITOR_STACK].filter((needle) => [...result.prev.keys()].some((file) => file.includes(needle)));
			assert.deepEqual(
				forbidden.map((needle) => `${needle}: ${whyLoaded(result, needle)?.slice(0, 5).join(" -> ")}`),
				[],
				`${entry} imports statically what it does not use`
			);
			assert.ok(result.bytes / 1e6 < (LIMITS[name] ?? DEFAULT_LIMIT), `${entry}: ${(result.bytes / 1e6).toFixed(2)} MB, from ${packages.length} packages`);
		});
	}
});

describe("the editors", () => {
	for (const [name, entry] of Object.entries(EDITORS)) {
		test(`${name} has the editor stack and still none of the SDKs`, async () => {
			const result = await closure(entry);
			assert.ok([...result.prev.keys()].some((file) => file.includes("@tiptap/")), "the editor is here");
			const forbidden = ["@aws-sdk/", "@smithy/", "node_modules/stripe/", "@upstash/", "@modelcontextprotocol/", "node_modules/jose/", "@better-auth/oauth-provider", "lib/actions/registry.js"].filter((needle) => [...result.prev.keys()].some((file) => file.includes(needle)));
			assert.deepEqual(forbidden, []);
		});
	}
});
