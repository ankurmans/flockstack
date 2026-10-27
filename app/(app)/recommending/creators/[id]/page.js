import Link from "next/link";
import { notFound } from "next/navigation";
import FormCreatorMessage, { FormCreatorConversation } from "@/components/FormCreatorMessage";
import HeaderPage from "@/components/HeaderPage";
import { runDashboardAction } from "@/lib/actions/dashboard";

export const metadata = { title: "Creator conversation" };
export default async function CreatorConversationPage({ params, searchParams }) {
	const { id } = await params;
	const { before } = await searchParams;
	const { output, failure } = await runDashboardAction("get_creator_conversation", { id, ...(before && { before }) });
	if (failure?.code === "not_found") notFound();
	return <><HeaderPage title="Creator conversation" /><div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
		<Link href="/recommending/creators" className="text-sm underline">Creator matches and inbox</Link>
		{failure && <p role="alert">{failure.message}</p>}
		{output && <><h2 className="font-medium">{output.conversation.otherName}</h2>
			<p className="text-xs text-muted-foreground">Each account keeps a private copy, including after the other account is deleted. Closing stops messages accepted after that closure is checked; it does not recall messages already accepted.</p>
			{output.before && <Link className="text-sm underline" href={`?before=${output.before}`}>Older messages</Link>}
			<ol className="flex flex-col gap-3">{output.messages.map((message) => <li key={message.id} className="rounded-xl border bg-card p-4">
				<p className="mb-2 text-xs text-muted-foreground">{message.direction === "outgoing" ? "You" : message.fromName} · {message.createdAt && new Date(message.createdAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</p>
				<p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
			</li>)}</ol>
			<FormCreatorConversation key={String(output.conversation.closed)} id={id} closed={output.conversation.closed} />
			{!output.conversation.closed && <FormCreatorMessage key={output.messages.at(-1)?.id || id} conversation={id} />}
		</>}
	</div></>;
}
