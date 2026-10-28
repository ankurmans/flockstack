import * as z from "zod";

// A newsletter's subfolder (lib/mounts.js toMountOutput), in the newsletter and mount actions' answers.
export const MountSchema = z
	.object({
		url: z.string().describe("The address on the owner's site, like https://example.com/newsletter"),
		path: z.string().describe("Its path: what the proxy strips before forwarding"),
		upstream: z.string().describe("Where the proxy forwards the rest: the newsletter's shared host, or its archive under the app's address on a server without a shared domain"),
		verified: z.boolean().describe("A check saw the proxy forward with the token. Until then the website's links stay where they were."),
		verifiedAt: z.string().nullable(),
		previousTokenUntil: z.string().nullable().describe("Until when the token before the last rotation still works, or null"),
	})
	.nullable();
