"use client";
import { useComments } from "@/components/ProviderComments";
import useReaderText from "@/components/useReaderText";

export default function NoticeReplyRules({ id }) {
	const t = useReaderText();
	const { viewer } = useComments();
	const rules = viewer.replyRules;
	if (!rules?.enabled) return null;
	return <div className="rounded-xl border p-3 text-sm">
		<p>{t("Reply Rules checks this comment with AI. Uncertain decisions wait for the owner, who can reverse a decision.")}</p>
		{rules.rules.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{rules.rules.map(rule => <li key={rule.id}>{rule.text}</li>)}</ul>}
		{rules.learnFromHides && <p className="mt-2">{t("Consenting comments the owner manually hides may be used as recent examples for this newsletter. This is classification, not model training.")}</p>}
		<label htmlFor={`${id}-ai-consent`} className="mt-3 flex items-start gap-2">
			<input key={rules.revision} id={`${id}-ai-consent`} type="checkbox" name="replyRulesConsent" value={rules.revision} required className="mt-1 size-4 shrink-0" />
			<span>{t("I agree to Cloudflare AI processing my comment outside the newsletter's storage region.")}</span>
		</label>
	</div>;
}
