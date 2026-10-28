import Link from "next/link";
import { redirect } from "next/navigation";
import { MessagesSquare, Users } from "lucide-react";
import FormCreatorMessage from "@/components/FormCreatorMessage";
import FormCreatorProfile from "@/components/FormCreatorProfile";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Creator matches" };
export default async function CreatorMatchesPage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = String(selected._id);
	const query = await searchParams;
	const [profile, matches, inbox] = await Promise.all([
		runDashboardAction("get_creator_match_settings", { newsletter }),
		runDashboardAction("get_creator_matches", { newsletter }),
		runDashboardAction("list_creator_conversations", { newsletter, ...(query?.cursor && { cursor: query.cursor }) }),
	]);
	return <><HeaderPage title="Creator matches" /><div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
		<Link href="/recommending" className="text-sm underline">Recommendations</Link>
		<p className="text-sm text-muted-foreground">Find creators to discuss a recommendation or a swap. Nothing is recommended, scheduled or subscribed automatically. All matching and private conversations stay within this region.</p>
		{[profile, matches, inbox].filter((item) => item.failure).map((item, index) => <p role="alert" key={index}>{item.failure.message}</p>)}
		{profile.output && <FormCreatorProfile key={JSON.stringify(profile.output)} newsletter={newsletter} profile={profile.output} />}
		<section className="flex flex-col gap-3"><h2 className="font-medium">Private conversations</h2>
			{inbox.output?.conversations.length === 0 && <StateEmpty isCompact className="px-0" icon={MessagesSquare} title="No introductions yet" />}
			{inbox.output?.conversations.map((item) => <Link className="rounded-xl border p-4 text-sm hover:bg-muted" key={item.id} href={`/recommending/creators/${item.id}`}>{item.otherName}{item.closed ? " · Closed by you" : ""}</Link>)}
			{inbox.output?.cursor && <Link className="text-sm underline" href={`/recommending/creators?cursor=${encodeURIComponent(inbox.output.cursor)}`}>Older conversations</Link>}
		</section>
		<section className="flex flex-col gap-4"><h2 className="font-medium">Suggested creators</h2>
			<p className="text-xs text-muted-foreground">Ranked by shared topics, language and subscriber range. This is a starting point for a conversation, not an estimate of future subscribers. Three new introductions per account per day.</p>
			{matches.output?.limited && <p className="text-xs text-muted-foreground">Showing the best 50 from a bounded window of 200 candidates; this is not the whole directory.</p>}
			{matches.output?.matches.length === 0 && <StateEmpty isCompact className="px-0" icon={Users} title={matches.output.enabled ? "No opted-in creators available yet" : "Enable your creator profile to see matches"} />}
			{matches.output?.matches.map((item) => <article key={item.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
				<h3 className="font-medium"><a href={item.url} target="_blank" rel="noreferrer">{item.name}</a></h3><p className="text-sm">{item.description}</p>
				<p className="text-xs text-muted-foreground">{item.subscriberRange} subscribers · {item.topics.join(", ")}</p>
				<p className="text-xs text-muted-foreground">{item.reasons.join(" · ") || "Different topics and audience range"}</p>
				{item.recommendation && <p className="text-xs text-muted-foreground">Your recommendation of this newsletter: {item.recommendation.signups} signups, {item.recommendation.confirmed} confirmed, {item.recommendation.impressions} impressions ({item.recommendation.status}).</p>}
				<details><summary className="cursor-pointer text-sm underline">Write an introduction</summary><div className="pt-3"><FormCreatorMessage newsletter={newsletter} to={item.id} /></div></details>
			</article>)}
		</section>
	</div></>;
}
