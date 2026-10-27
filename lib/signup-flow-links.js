import { getLinkBaseUrl } from "./archive-hosts.js";
import { createContactToken } from "./contact-token.js";

export const FLOW_KEY = "flockstack-signup-flow-v1";
export const SIGNUP_FLOW_MAX_AGE_MS = 60 * 60 * 1000;

export function getSignupFlowUrl({ form, newsletter, contact = null, step = 0, token = null, now = Date.now() }) {
	const url = new URL(`${getLinkBaseUrl(newsletter)}/signup-flow`);
	url.searchParams.set("f", String(form._id));
	url.searchParams.set("step", String(step));
	if (contact) token = createContactToken({ info: FLOW_KEY, contactId: contact._id, newsletterId: newsletter._id }, now);
	if (token) url.searchParams.set("token", token);
	return url.toString();
}

// Only a newly created contact receives a capability at signup. Re-entering an existing address opens a public flow.
export function getSignupFlowEntry({ form, newsletter, contact, created }) {
	return form.flow?.length ? getSignupFlowUrl({ form, newsletter, contact: created && ["active", "pending"].includes(contact?.status) ? contact : null }) : null;
}
