import "server-only";
import { scoped } from "@/lib/account-scope";
import {
	DRAFT_ONLY,
	NEWSLETTER_APPROVAL_CLASSES,
	PRESET_INFO,
	PRESET_RULES,
	SCALE_COUNTS,
	SCALE_LIMITS,
	SCOPE_CLASS_INFO,
	getActionClass,
	getNewsletterTarget,
	isPresetAllowed,
	normalizePreset,
	presetNeedsApproval,
} from "@/lib/action-scopes";
import { actionError } from "@/lib/actions/errors";
import { countCall, getDayCounts, recordActivity } from "@/lib/agent-activity";
import { isLoggedCall, summarizeCall } from "@/lib/agent-activity-rules";
import { proposeApproval } from "@/lib/approvals";
import { getKeyLevel } from "@/lib/api-key-tokens";
import { isObjectIdString } from "@/lib/validation";
import Automation from "@/models/Automation";
import Campaign from "@/models/Campaign";
import Comment from "@/models/Comment";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Order from "@/models/Order";
import Pledge from "@/models/Pledge";
import Poll from "@/models/Poll";
import Product from "@/models/Product";
import Segment from "@/models/Segment";
import SitePage from "@/models/SitePage";
import Survey from "@/models/Survey";

// Everything between "an API key or a connected app called an action" and "the action's handler runs": what its level
// allows, the one newsletter it may be limited to, the daily cap, the owner's approval, and the record of what happened.
// runAction calls it for keys and apps only: the dashboard is a signed-in person.

const MODELS = { Automation, Campaign, Comment, Contact, Order, Pledge, Poll, Product, Segment, SitePage, Survey };
// The models whose documents the registry names but this module only reads for their newsletter, loaded when asked.
const LAZY_MODELS = {
	EditorThread: () => import("@/models/EditorThread"),
	CreatorConversation: () => import("@/models/CreatorConversation"),
	Reply: () => import("@/models/Reply"),
	AudioVersion: () => import("@/models/AudioVersion"),
	BulkRemoval: () => import("@/models/BulkRemoval"),
	ContentItem: () => import("@/models/ContentItem"),
	EditorialBatch: () => import("@/models/EditorialBatch"),
	Form: () => import("@/models/Form"),
	SponsorshipBooking: () => import("@/models/SponsorshipBooking"),
	GroupSubscription: () => import("@/models/GroupSubscription"),
	Gift: () => import("@/models/Gift"),
	GiftLink: () => import("@/models/GiftLink"),
	IssueTemplate: () => import("@/models/IssueTemplate"),
	Offer: () => import("@/models/Offer"),
	PostImport: () => import("@/models/PostImport"),
	Redirect: () => import("@/models/Redirect"),
	SeriesPlan: () => import("@/models/SeriesPlan"),
	Snippet: () => import("@/models/Snippet"),
};

async function getModel(name) {
	if (MODELS[name]) return MODELS[name];
	return (await LAZY_MODELS[name]()).default;
}

// The caller as the guard sees it: an API key, or an app connected with OAuth (its consent). Null for the dashboard.
export function describeAgent({ apiKey, connection }) {
	if (apiKey) {
		return {
			type: "key",
			id: String(apiKey._id),
			name: apiKey.name,
			preset: getKeyLevel(apiKey),
			newsletterId: apiKey.newsletterId ? String(apiKey.newsletterId) : null,
			dailyCap: apiKey.dailyCap ?? null,
		};
	}
	if (connection) {
		// A connection from before access levels has no level and counts as full, as it always did.
		return { type: "app", id: String(connection.id), name: connection.name ?? "An app", preset: normalizePreset(connection.level ?? "full"), newsletterId: null, dailyCap: null };
	}
	return null;
}

// The lowest level that can run an action of this class, for the message that says what to ask for.
function getLowestPreset(className) {
	return ["read_only", "drafts", "send_with_approval", "full"].find((preset) => PRESET_RULES[preset].allow.includes(className)) ?? "full";
}

function deny(message) {
	return actionError("forbidden", message);
}

// Throws forbidden when the caller's level doesn't allow the action. input: as sent, which can raise the class (publishing a page).
export function assertAllowed(agent, action, input) {
	if (isPresetAllowed(agent.preset, action, input)) return;
	if (agent.preset === "signups") throw deny(`This key can only add contacts: ${action.name} needs a full access key`);
	const className = getActionClass(action.name, input);
	const what = agent.type === "key" ? "key" : "app";
	if (!className) throw deny(`This ${what} can't run ${action.name}: the action has no access class, so only full access can`);
	const needed = PRESET_INFO[getLowestPreset(className)].label;
	throw deny(
		`This ${what} has ${PRESET_INFO[agent.preset].label.toLowerCase()} access, which can't ${SCOPE_CLASS_INFO[className].label.toLowerCase()}: ${action.name} needs a key with ${needed.toLowerCase()} access or more`
	);
}

// What a key limited to one newsletter may reach is decided by where the action's newsletter comes from (lib/action-scopes.js).
async function findNewsletterOf(account, target, input, action) {
	try {
		if (target.kind === "input") {
			const ref = input.newsletter?.trim?.().toLowerCase();
			if (!ref) return null;
			const found = await Newsletter.findOne(scoped(account, isObjectIdString(ref) ? { $or: [{ _id: ref }, { slug: ref }] } : { slug: ref })).select({ _id: 1 }).lean();
			return found ? String(found._id) : null;
		}
		if (target.kind === "newsletter") {
			const ref = String(input.id ?? "").toLowerCase();
			const found = await Newsletter.findOne(scoped(account, isObjectIdString(ref) ? { $or: [{ _id: ref }, { slug: ref }] } : { slug: ref })).select({ _id: 1 }).lean();
			return found ? String(found._id) : null;
		}
		const id = target.kind === "model" ? input.id : input[target.field];
		if (target.kind === "model" || target.kind === "field") {
			if (!isObjectIdString(String(id ?? ""))) return null;
			const doc = await (await getModel(target.model)).findOne(scoped(account, { _id: id })).select({ newsletterId: 1 }).lean();
			return doc?.newsletterId ? String(doc.newsletterId) : null;
		}
	} catch (error) {
		console.error(`[agent-guard] Could not find the newsletter of ${action.name}:`, error?.message);
	}
	return null;
}

async function firstNewsletterId(account) {
	const first = await Newsletter.findOne(scoped(account)).sort({ createdAt: 1, _id: 1 }).select({ _id: 1 }).lean();
	return first ? String(first._id) : null;
}

// Limits a call to the key's newsletter: a call that names no newsletter gets it, one that names another is forbidden, and
// one that reaches the whole account is too. Returns the input to run, and the newsletter the call is about.
async function restrictToNewsletter(account, agent, action, input) {
	const hasNewsletterInput = Object.hasOwn(action.input.shape, "newsletter");
	const target = getNewsletterTarget(action.name, hasNewsletterInput);
	const limitedTo = agent.newsletterId;
	const refuse = () => deny(`This key is limited to one newsletter: ${action.name} reaches something outside it`);
	if (target.kind === "open" || target.kind === "list_newsletters") return { input, newsletterId: target.kind === "open" ? null : limitedTo };
	if (target.kind === "account") throw refuse();
	let next = input;
	if (target.kind === "input") {
		if (!input.newsletter?.trim?.()) next = { ...input, newsletter: limitedTo };
		else if ((await findNewsletterOf(account, target, input, action)) !== limitedTo) throw refuse();
	} else if (target.kind !== "ids" && (await findNewsletterOf(account, target, input, action)) !== limitedTo) throw refuse();
	if (target.kind === "ids" || (target.kind === "input" && target.model)) {
		const ids = (Array.isArray(next[target.field]) ? next[target.field] : []).map(String).filter(isObjectIdString);
		if (ids.length > 0) {
			const docs = await (await getModel(target.model)).find(scoped(account, { _id: { $in: ids } })).select({ newsletterId: 1 }).lean();
			if (docs.some((doc) => String(doc.newsletterId) !== limitedTo)) throw refuse();
		}
	}
	return { input: next, newsletterId: limitedTo };
}

// Whether the owner asked for approval before an agent sends or deletes: for this newsletter, or, for what reaches the account, any.
async function isNewsletterGated(account, newsletterId) {
	if (newsletterId) {
		const newsletter = await Newsletter.findOne(scoped(account, { _id: newsletterId })).select({ agentApproval: 1 }).lean();
		return Boolean(newsletter?.agentApproval);
	}
	return (await Newsletter.countDocuments(scoped(account, { agentApproval: true }))) > 0;
}

// A scheduled campaign was approved as it was and an active automation is already sending: agents change drafts only.
async function assertDraftOnly(account, agent, action, input, isGated) {
	const rule = DRAFT_ONLY[action.name];
	if (!rule || !(rule.presets.includes(agent.preset) || (rule.gated && isGated))) return;
	if (!isObjectIdString(String(input.id ?? ""))) return;
	const doc = await (await getModel(rule.model)).findOne(scoped(account, { _id: input.id })).select({ status: 1 }).lean();
	if (doc && !rule.statuses.includes(doc.status)) {
		throw actionError("conflict", `An agent can change this only while it is ${rule.statuses.join(" or ")}, and it is ${doc.status}. Unschedule or pause it first, or ask the owner.`);
	}
}

function getScaleCount(action, input) {
	return SCALE_COUNTS[action.name]?.(input) ?? 0;
}

// Why the call waits for a person, or null. key: the level sends this class to the owner. newsletter: the newsletter asks. scale:
// a send with approval key changing a lot of contacts.
async function getApprovalReason({ account, agent, className, action, input, isGated }) {
	if (presetNeedsApproval(agent.preset, className)) return "key";
	if (isGated && NEWSLETTER_APPROVAL_CLASSES.includes(className)) return "newsletter";
	const count = getScaleCount(action, input);
	if (count > 0 && agent.preset !== "signups" && (agent.preset === "send_with_approval" || isGated)) {
		const today = (await getDayCounts(account, [agent.id])).get(agent.id)?.scaled ?? 0;
		if (count > SCALE_LIMITS.perCall || today + count > SCALE_LIMITS.perDay) return "scale";
	}
	return null;
}

// A signups only key is a website's: its thousands of signups are counted in the day's numbers, not listed one by one.
async function record(account, agent, action, className, newsletterId, requestId, via, input, status, errorCode) {
	if (agent.preset === "signups" || !isLoggedCall(action, input)) return;
	await recordActivity(account, {
		kind: "call",
		actorType: agent.type,
		actorId: agent.id,
		actorName: agent.name,
		via,
		action: action.name,
		className: className ?? undefined,
		newsletterId: newsletterId ?? undefined,
		status,
		errorCode,
		summary: summarizeCall(action, input),
		requestId,
	});
}

// The first check, before the account's own: a call the level doesn't allow is recorded as denied and answers forbidden.
export async function rejectDisallowed({ account, agent, action, input, via, requestId }) {
	try {
		assertAllowed(agent, action, input);
	} catch (error) {
		await countCall(account, agent, { denied: true });
		await record(account, agent, action, getActionClass(action.name, input), null, requestId, via, input, "denied", error.code);
		throw error;
	}
}

// Called before the handler, once the level has allowed the call. Throws when something else stops it. Returns { response } when the call waits for approval, else
// { input, finish }: the input to run, and finish(output | error) to call after, which records the call and returns the
// output (a limited key sees only its newsletter in list_newsletters).
export async function guardCall({ account, agent, action, input, via, requestId, isApproved = false }) {
	const className = getActionClass(action.name, input);
	let newsletterId = null;
	let next = input;
	try {
		if (agent.newsletterId) ({ input: next, newsletterId } = await restrictToNewsletter(account, agent, action, input));
		const target = getNewsletterTarget(action.name, Object.hasOwn(action.input.shape, "newsletter"));
		const isLogged = isLoggedCall(action, next);
		const isGateable = NEWSLETTER_APPROVAL_CLASSES.includes(className);
		if (!newsletterId && (isLogged || isGateable)) {
			newsletterId = (await findNewsletterOf(account, target, next, action)) ?? (target.kind === "input" && !next.newsletter?.trim?.() ? await firstNewsletterId(account) : null);
		}
		const needsGateCheck = isGateable || Boolean(DRAFT_ONLY[action.name]) || getScaleCount(action, next) > 0;
		const isGated = needsGateCheck ? await isNewsletterGated(account, newsletterId) : false;
		await assertDraftOnly(account, agent, action, next, isGated);
		const reason = isApproved ? null : await getApprovalReason({ account, agent, className, action, input: next, isGated });
		if (reason) {
			if (!(await countCall(account, agent, { cap: agent.dailyCap }))) throw capReached(agent);
			const response = await proposeApproval({
				account,
				agent,
				action,
				className,
				input: next,
				newsletterId,
				via,
				requestId,
				reason,
				summary: summarizeCall(action, next),
			});
			await record(account, agent, action, className, newsletterId, requestId, via, next, "approval_required");
			return { response };
		}
		if (!(await countCall(account, agent, { cap: isApproved ? null : agent.dailyCap, isChange: className !== "read", scaled: getScaleCount(action, next) }))) throw capReached(agent);
	} catch (error) {
		if (error?.isActionError) await record(account, agent, action, className, newsletterId, requestId, via, input, error.code === "forbidden" ? "denied" : "failed", error.code);
		throw error;
	}

	const limitedTo = agent.newsletterId;
	return {
		input: next,
		finish: async (output, error) => {
			await record(account, agent, action, className, newsletterId, requestId, via, next, error ? "failed" : "ok", error?.code);
			if (limitedTo && action.name === "list_newsletters" && output?.newsletters) {
				return { ...output, newsletters: output.newsletters.filter(({ id }) => id === limitedTo) };
			}
			return output;
		},
	};
}

function capReached(agent) {
	return actionError("daily_cap_reached", `This ${agent.type === "key" ? "key" : "app"} used its ${agent.dailyCap} calls for today (UTC). It can call again after midnight UTC, or the owner can raise the cap.`);
}
