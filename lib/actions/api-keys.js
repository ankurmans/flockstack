import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { PRESET_INFO, PRESET_RULES, SCOPE_CLASSES } from "@/lib/action-scopes";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, toIso } from "@/lib/actions/shared";
import { getDayCounts } from "@/lib/agent-activity";
import { notifyActivity } from "@/lib/alerts";
import { generateApiKey, getKeyLevel, listApiKeys } from "@/lib/api-keys";
import { getAppUrl } from "@/lib/config";
import { isObjectIdString } from "@/lib/validation";
import ApiKey, { API_KEY_LEVELS } from "@/models/ApiKey";

const GROUP = "API keys";
// Each key has requests a minute of its own (lib/api/rest.js), and keys can create keys.
export const MAX_ACTIVE_API_KEYS = 20;

const ApiKeySchema = z.object({
	id: z.string(),
	name: z.string(),
	purpose: z.literal("assistant").optional().describe("Internal account assistant grant, with no usable bearer token"),
	prefix: z.string().describe("The key's first characters, to tell keys apart"),
	level: z.enum(API_KEY_LEVELS).describe("read_only, drafts, send_with_approval, full or signups (only add_contact)"),
	scopes: z.array(z.enum(SCOPE_CLASSES)).describe("The classes of actions the level allows (docs/agent-safety). signups has none: it only runs add_contact."),
	approvalRequired: z.array(z.enum(SCOPE_CLASSES)).describe("The classes among them that wait for the owner's approval instead of running"),
	newsletterId: z.string().nullable().describe("The one newsletter the key is limited to, or null for all of the account's"),
	dailyCap: z.number().int().nullable().describe("Calls a day (UTC) it may make, or null for no cap"),
	expiresAt: dateOutput.describe("When the key stops working, or null"),
	callsToday: z.number().int().describe("Calls it made today (UTC)"),
	createdAt: dateOutput,
	lastUsedAt: dateOutput,
	revokedAt: dateOutput,
	isCurrent: z.boolean().describe("The key making this request"),
});

function toApiKey(apiKey, currentKey, today) {
	const level = getKeyLevel(apiKey);
	return {
		id: String(apiKey._id),
		name: apiKey.name,
		...(apiKey.purpose === "assistant" && { purpose: "assistant" }),
		prefix: apiKey.prefix,
		level,
		scopes: [...PRESET_RULES[level].allow],
		approvalRequired: [...PRESET_RULES[level].approve],
		newsletterId: apiKey.newsletterId ? String(apiKey.newsletterId) : null,
		dailyCap: apiKey.dailyCap ?? null,
		expiresAt: toIso(apiKey.expiresAt),
		callsToday: today?.get(String(apiKey._id))?.calls ?? 0,
		createdAt: toIso(apiKey.createdAt),
		lastUsedAt: toIso(apiKey.lastUsedAt),
		revokedAt: toIso(apiKey.revokedAt),
		isCurrent: Boolean(currentKey) && String(currentKey._id) === String(apiKey._id),
	};
}

export const apiKeyActions = [
	defineAction({
		name: "list_api_keys",
		tryWithoutPlan: true,
		title: "List API keys",
		group: GROUP,
		description: "Lists the account's API keys, revoked ones included, with their level, the newsletter they are limited to, their cap and expiry, how many calls they made today and when they were last used. Keys themselves are never shown again.",
		http: { method: "GET", path: "/api-keys" },
		readOnly: true,
		output: z.object({ apiKeys: z.array(ApiKeySchema) }),
		handler: async ({ account, apiKey }) => {
			const keys = await listApiKeys(account);
			const today = await getDayCounts(account, keys.map(({ _id }) => String(_id)));
			return { apiKeys: keys.map((key) => toApiKey(key, apiKey, today)) };
		},
	}),
	defineAction({
		name: "create_api_key",
		title: "Create an API key",
		group: GROUP,
		description: `Creates an API key and returns it once; only its hash is stored. level picks what it may do: read_only reads; drafts also writes drafts that don't go out; send_with_approval also changes settings and contacts, and its sends, schedules and deletes wait for the owner's approval; full does everything, including creating more keys; signups can only add contacts, for keys that end up in website code. It can be limited to one newsletter, capped at a number of calls a day and set to expire. An account has up to ${MAX_ACTIVE_API_KEYS} active keys: one more answers conflict until one is revoked.`,
		http: { method: "POST", path: "/api-keys", status: 201 },
		rateLimit: { limit: 10, window: "1 h" },
		example: { name: "Drafting assistant", level: "drafts" },
		input: z.object({
			name: z.string().trim().min(1).max(60).describe("What the key is for, e.g. Website signups"),
			level: z.enum(API_KEY_LEVELS).describe("read_only, drafts, send_with_approval, full or signups"),
			newsletter: z.string().trim().min(1).max(100).optional().describe("Limit the key to this newsletter (ID or slug): it reaches nothing of the account's others. Default: all of them."),
			dailyCap: z.number().int().min(1).max(1_000_000).optional().describe("Calls a day (UTC) the key may make, reads included. Default: no cap."),
			expiresInDays: z.number().int().min(1).max(730).optional().describe("The key stops working after this many days. Default: it doesn't expire."),
		}),
		output: z.object({ apiKey: ApiKeySchema, key: z.string().describe("The key. Store it now: it isn't shown again.") }),
		handler: async ({ account, apiKey, input }) => {
			if ((await ApiKey.countDocuments(scoped(account, { revokedAt: null }))) >= MAX_ACTIVE_API_KEYS) {
				throw actionError("conflict", `An account has up to ${MAX_ACTIVE_API_KEYS} active API keys. Revoke one to create another.`);
			}
			const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
			const { key, prefix, hash } = generateApiKey();
			const created = await ApiKey.create({
				accountId: account._id,
				name: input.name,
				level: input.level,
				prefix,
				hash,
				...(newsletter && { newsletterId: newsletter._id }),
				...(input.dailyCap && { dailyCap: input.dailyCap }),
				...(input.expiresInDays && { expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000) }),
			});
			await notifyActivity([`API key created: ${input.name} (${PRESET_INFO[input.level].label})`, `${getAppUrl()}/api-keys`], { accountId: account._id });
			return { apiKey: toApiKey(created.toObject(), apiKey), key };
		},
	}),
	defineAction({
		name: "revoke_api_key",
		tryWithoutPlan: true,
		title: "Revoke an API key",
		group: GROUP,
		description: "Revokes an API key for good: requests with it answer unauthorized from now on. A key can revoke itself.",
		http: { method: "DELETE", path: "/api-keys/{id}" },
		destructive: true,
		idempotent: true,
		whileBlocked: true,
		input: z.object({ id: idInput("API key") }),
		output: z.object({ id: z.string(), revoked: z.literal(true) }),
		handler: async ({ account, input }) => {
			const existing = isObjectIdString(input.id) ? await ApiKey.findOne(scoped(account, { _id: input.id })).select({ _id: 1 }).lean() : null;
			if (!existing) throw actionError("not_found", "Key not found");
			await ApiKey.updateOne(scoped(account, { _id: existing._id, revokedAt: null }), { $set: { revokedAt: new Date() } });
			return { id: String(existing._id), revoked: true };
		},
	}),
];
