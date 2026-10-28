import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { afterCursor, encodeCursor, findNewsletter, idInput, newsletterInput } from "@/lib/actions/shared";
import { conversationOutput, creatorProfile, findCreatorConversation, getCreatorMatches, readCreatorConversation, saveCreatorProfile, sendCreatorMessage } from "@/lib/creator-matches";
import CreatorConversation from "@/models/CreatorConversation";

const group = "Creator matches";
const profileFields = "accountId name slug language creatorMatch recommendations archiveEnabled archiveHost mount fromEmail replyTo requireConfirmation sharedSender";
const Profile = z.object({ enabled: z.boolean(), topics: z.array(z.string()), emailNotifications: z.boolean() });
const Conversation = z.object({ id: z.string(), newsletterId: z.string(), otherNewsletterId: z.string(), otherName: z.string(), closed: z.boolean(), lastMessageAt: z.string().nullable() });
const Accepted = z.object({ conversationId: z.string(), messageId: z.string(), accepted: z.literal(true).describe("Saved in both private inboxes; does not confirm email delivery or a reply") });
const Body = z.string().trim().min(1).max(2000).describe("Your private message, shared with the other creator; plain text, up to 2,000 characters");
const ExternalId = z.string().trim().min(1).max(100).describe("A unique ID for this message. Retry with the same ID and words; reuse with different words is refused.");

const getProfile = defineAction({
	name: "get_creator_match_settings", title: "Get creator profile", group,
	description: "Reads a newsletter's opt-in creator matching profile and optional email notification preference. Both are off by default. Topics and subscriber ranges are shared with other opted-in creators in this region.",
	http: { method: "GET", path: "/creator-matches/settings" }, readOnly: true,
	input: z.object({ newsletter: newsletterInput }), output: Profile,
	handler: async ({ account, input }) => creatorProfile(await findNewsletter(account, input.newsletter, profileFields)),
});
const setProfile = defineAction({
	name: "set_creator_match_settings", title: "Set creator profile", group,
	description: "Opts a newsletter into topic and audience-range matching, or turns it off. Needs its public recommendation listing, confirmed signups, verified sender and published website. Never enables the directory for you. Turning matching off stops new introductions, while existing private conversations remain open until you close them. Optional email notifications go to the account owner, with no account address shared with the sender.",
	http: { method: "PATCH", path: "/creator-matches/settings" }, idempotent: true,
	input: z.object({ newsletter: newsletterInput, enabled: z.boolean().optional().describe("Show this newsletter to opted-in creators and accept new introductions"), topics: z.array(z.string().min(2).max(30)).max(10).optional().describe("Up to ten topics, shared with other opted-in creators"), emailNotifications: z.boolean().optional().describe("Email the account owner about private messages, at most once per conversation per hour; off by default") }), output: Profile,
	handler: async ({ account, input }) => saveCreatorProfile(await findNewsletter(account, input.newsletter, profileFields), input),
});
const matches = defineAction({
	name: "get_creator_matches", title: "Get creator matches", group,
	description: "Ranks up to 50 opted-in creators in this region from a stable window of 200 candidates. Topic overlap, shared language, subscriber range and up to five points from your own prior confirmed recommendation signups determine the score; it is not a prediction. Shows only public profile fields and your own outgoing recommendation counts. No contacts or exact audience counts are shared. Matching must be enabled for your newsletter.",
	http: { method: "GET", path: "/creator-matches" }, readOnly: true, rateLimit: { limit: 120, window: "1 h" }, limitDashboard: true,
	input: z.object({ newsletter: newsletterInput }),
	output: z.object({ enabled: z.boolean(), limited: z.boolean().describe("More candidates exist than the bounded matching window or result limit"), matches: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string(), imageUrl: z.string().nullable(), url: z.string(), language: z.string(), topics: z.array(z.string()), subscriberRange: z.string(), score: z.number(), reasons: z.array(z.string()), recommendation: z.object({ status: z.string(), impressions: z.number(), signups: z.number(), confirmed: z.number() }).nullable() })) }),
	handler: async ({ account, input }) => getCreatorMatches(await findNewsletter(account, input.newsletter, profileFields)),
});
const conversations = defineAction({
	name: "list_creator_conversations", title: "List creator conversations", group,
	description: "Lists this newsletter's private creator conversations, newest message first, 50 at a time. Each account owns its own copy; neither account email address is returned. Follow the cursor for older conversations.",
	http: { method: "GET", path: "/creator-conversations" }, readOnly: true,
	input: z.object({ newsletter: newsletterInput, cursor: z.string().max(500).optional().describe("The next cursor from the previous page") }), output: z.object({ conversations: z.array(Conversation), cursor: z.string().nullable() }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, "accountId");
		const rows = await CreatorConversation.find(scoped(account, { newsletterId: newsletter._id, lastMessageAt: { $exists: true }, ...(input.cursor && afterCursor(input.cursor, "lastMessageAt")) })).sort({ lastMessageAt: -1, _id: -1 }).limit(51).lean();
		return { conversations: rows.slice(0, 50).map(conversationOutput), cursor: rows.length > 50 ? encodeCursor(rows[49].lastMessageAt, rows[49]._id) : null };
	},
});
const getConversation = defineAction({
	name: "get_creator_conversation", title: "Get creator conversation", group,
	description: "Reads your copy of a private creator conversation, 50 messages at a time. The optional before cursor reads older messages. No account addresses are returned; anything a creator chose to write in their message remains in its text.",
	http: { method: "GET", path: "/creator-conversations/{id}" }, readOnly: true,
	input: z.object({ id: idInput("conversation"), before: z.string().max(100).optional().describe("The before cursor from the previous result, for older messages") }),
	output: z.object({ conversation: Conversation, messages: z.array(z.object({ id: z.string(), direction: z.enum(["incoming", "outgoing"]), fromName: z.string(), body: z.string(), createdAt: z.string().nullable() })), before: z.string().nullable() }),
	handler: async ({ account, input }) => readCreatorConversation(await findCreatorConversation(account, input.id), input.before),
});
const introduce = defineAction({
	name: "send_creator_intro", title: "Send creator introduction", group,
	description: "Sends the words you supply to another opted-in creator in this region. Both newsletters must be listed and eligible for recommendations. Saves one private inbox copy per account and optionally emails the recipient owner; no account address is exposed. At most three new introductions per account per day, subject to the server's rate-limit storage. Does not create a recommendation or subscribe anyone. Agents with send approval must wait for the owner's approval.",
	http: { method: "POST", path: "/creator-conversations" }, openWorld: true, idempotent: true, rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ newsletter: newsletterInput, to: idInput("recipient newsletter").describe("The creator newsletter ID from get_creator_matches"), body: Body, externalId: ExternalId }), output: Accepted,
	handler: async ({ account, input }) => sendCreatorMessage({ newsletter: await findNewsletter(account, input.newsletter, profileFields), body: input.body, externalId: input.externalId, to: input.to }),
});
const reply = defineAction({
	name: "reply_creator_intro", title: "Reply to creator introduction", group,
	description: "Sends your words into an existing private creator conversation, with an optional recipient email notification. Existing conversations may continue after matching is turned off. Either side can close its copy to stop new messages. At most 30 replies per account per hour, subject to the server's rate-limit storage. No recommendation or signup is created. Agents with send approval must wait for owner approval.",
	http: { method: "POST", path: "/creator-conversations/{id}/messages" }, openWorld: true, idempotent: true, rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ id: idInput("conversation"), body: Body, externalId: ExternalId }), output: Accepted,
	handler: async ({ account, input }) => {
		const row = await findCreatorConversation(account, input.id);
		return sendCreatorMessage({ newsletter: await findNewsletter(account, String(row.newsletterId), profileFields), to: String(row.otherNewsletterId), body: input.body, externalId: input.externalId, reply: true });
	},
});
const close = defineAction({
	name: "set_creator_conversation", title: "Close or reopen creator conversation", group,
	description: "Closes your side of a private creator conversation to refuse new messages, or reopens your side. The other creator's closure stays in force. Messages already accepted remain in each account's private copy. This changes only your conversation state and sends no email.",
	http: { method: "PATCH", path: "/creator-conversations/{id}" }, idempotent: true, whileBlocked: true,
	input: z.object({ id: idInput("conversation"), closed: z.boolean().describe("True to stop new messages; false to reopen your side") }), output: Conversation,
	handler: async ({ account, input }) => {
		const row = await findCreatorConversation(account, input.id);
		await CreatorConversation.updateOne(scoped(account, { _id: row._id }), { $set: { closed: input.closed } });
		return conversationOutput({ ...row, closed: input.closed });
	},
});
export const creatorMatchActions = [getProfile, setProfile, matches, conversations, getConversation, introduce, reply, close];
