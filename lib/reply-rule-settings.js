export const REPLY_RULE_LIMITS = { rules: 10, ruleChars: 200 };

export function getReplyRules(newsletter) {
	const value = newsletter?.replyRules ?? {};
	return { enabled: value.enabled === true, rules: (value.rules ?? []).map(({ id, text }) => ({ id, text })), learnFromHides: value.learnFromHides === true, revision: value.revision ?? "" };
}
