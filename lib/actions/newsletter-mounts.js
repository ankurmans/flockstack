import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter } from "@/lib/actions/shared";
import { MountSchema } from "@/lib/mount-schema";
import { checkMount, removeMount, rotateMountToken, setMount, toMountOutput } from "@/lib/mounts";

const GROUP = "Newsletters";
const id = z.string().trim().min(1).max(100).describe("The newsletter's ID or slug");
const TokenOutput = z.string().describe("The mount token, fsm_ and base64url, for the proxy's X-FlockStack-Mount header. Store it now: it isn't shown again.");

export const newsletterMountActions = [
	defineAction({
		name: "set_newsletter_mount",
		title: "Put the website in a subfolder",
		group: GROUP,
		description:
			"Serves the newsletter's website at a path of a site you run, like https://example.com/newsletter: your site's reverse proxy strips the path and forwards the rest to the upstream with the token in an X-FlockStack-Mount header. Returns the token once. Setting it again, to the same address or another, makes a new token and waits for a new check; the website's links stay where they were until check_newsletter_mount sees the proxy work. A newsletter with its own archive subdomain can't have one. The links in emails never move.",
		http: { method: "POST", path: "/newsletters/{id}/mount" },
		rateLimit: { limit: 20, window: "1 h" },
		example: { url: "https://example.com/newsletter" },
		input: z.object({
			id,
			url: z.string().trim().max(300).describe("https://, a public name, the default port, a path of one to three parts and no query"),
		}),
		output: z.object({ mount: MountSchema, token: TokenOutput }),
		handler: async ({ account, input }) => {
			const { newsletter, token } = await setMount({ account, newsletter: await findNewsletter(account, input.id), url: input.url });
			return { mount: toMountOutput(newsletter), token };
		},
	}),
	defineAction({
		name: "check_newsletter_mount",
		title: "Check the subfolder",
		group: GROUP,
		description:
			"Asks <url>/.well-known/flockstack-mount through your site and expects FlockStack's own signed answer, which proves the proxy forwards that path with the token. The first check that passes moves the website's pages, canonical addresses and feeds to the subfolder; problem says what to fix when it doesn't pass, or that the proxy still sends the previous token.",
		http: { method: "POST", path: "/newsletters/{id}/mount/check" },
		openWorld: true,
		idempotent: true,
		rateLimit: { limit: 30, window: "1 h" },
		input: z.object({ id }),
		output: z.object({
			mount: MountSchema,
			verified: z.boolean().describe("This check saw FlockStack's answer through your site"),
			token: z.enum(["current", "previous"]).nullable().describe("Which token your proxy sent"),
			problem: z.string().nullable(),
		}),
		handler: async ({ account, input }) => {
			const { newsletter, verified, token, problem } = await checkMount({ account, newsletter: await findNewsletter(account, input.id) });
			return { mount: toMountOutput(newsletter), verified, token, problem };
		},
	}),
	defineAction({
		name: "rotate_newsletter_mount_token",
		title: "Rotate the subfolder's token",
		group: GROUP,
		description: "Makes a new mount token and returns it once. The previous token keeps working for 24 hours, so the proxy's secret can change without the website going down.",
		http: { method: "POST", path: "/newsletters/{id}/mount/rotate-token" },
		rateLimit: { limit: 10, window: "1 h" },
		input: z.object({ id }),
		output: z.object({ mount: MountSchema, token: TokenOutput, previousTokenUntil: z.string().describe("When the previous token stops working") }),
		handler: async ({ account, input }) => {
			const { newsletter, token, previousTokenUntil } = await rotateMountToken({ account, newsletter: await findNewsletter(account, input.id) });
			return { mount: toMountOutput(newsletter), token, previousTokenUntil };
		},
	}),
	defineAction({
		name: "remove_newsletter_mount",
		title: "Take the website out of the subfolder",
		group: GROUP,
		description:
			"Removes the subfolder and its tokens: the website's pages go back to the newsletter's own address at once, and requests with the old token are refused. Your proxy's route is yours to take down.",
		http: { method: "DELETE", path: "/newsletters/{id}/mount" },
		destructive: true,
		idempotent: true,
		input: z.object({ id }),
		output: z.object({ removed: z.boolean().describe("false when there was none") }),
		handler: async ({ account, input }) => {
			const { removed } = await removeMount({ account, newsletter: await findNewsletter(account, input.id) });
			return { removed };
		},
	}),
];
