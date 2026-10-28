import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import FormBriefing from "@/components/FormBriefing";
import HeaderPage from "@/components/HeaderPage";
import { runAction } from "@/lib/actions/run-action";
import { READER_LANGUAGES } from "@/lib/reader-language-copy";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { TIME_ZONE_COOKIE, resolveTimeZone } from "@/lib/time-zone";

export const metadata = { title: "New briefing" };

export default async function NewBriefingPage() {
	const [{ account, user, selected }, cookieStore] = await Promise.all([getSelectedNewsletter(), cookies()]);
	if (!selected) redirect("/briefings");
	const { keys } = await runAction("list_ai_keys", { account, user, input: {}, via: "dashboard" });

	return (
		<>
			<HeaderPage title="New briefing" backHref="/briefings" />
			<div className="max-w-3xl">
				<FormBriefing
					newsletterId={String(selected._id)}
					briefing={null}
					keys={keys}
					languages={READER_LANGUAGES}
					defaultTimeZone={resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value)}
					defaultEmail={user?.email ?? ""}
				/>
			</div>
		</>
	);
}
