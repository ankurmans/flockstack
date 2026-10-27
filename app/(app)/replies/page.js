import Link from "next/link";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { archiveReply } from "./actions";
export default async function RepliesPage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	const query = await searchParams;
	const archived = query.archived === "true";
	const { output, failure } = await runDashboardAction("list_replies", { newsletter: String(selected._id), archived, ...(query.before && { before: String(query.before) }) });
	return <main className="mx-auto flex max-w-3xl flex-col gap-5 p-6"><h1 className="text-2xl font-semibold">Replies</h1><p className="text-sm text-muted-foreground">Plain text only, kept for 90 days. Sender identity is not independently verified. Replies never send a response automatically.</p><Link href="/reader-settings" className="underline">Reader settings</Link><Link href={archived ? "/replies" : "/replies?archived=true"} className="underline">{archived ? "Inbox" : "Archived replies"}</Link>{(failure || query.error) && <p role="alert">{failure?.message ?? String(query.error).slice(0, 300)}</p>}{output?.replies.length === 0 && <p>No replies yet.</p>}{output?.replies.map((reply) => <article className="rounded-lg border p-4" key={reply.id}><h2 className="font-medium">{reply.subject || "Reply"}</h2><p className="text-xs text-muted-foreground">{reply.from} · {reply.receivedAt}</p><p className="my-4 whitespace-pre-wrap break-words text-sm">{reply.text}</p><form action={archiveReply}><input type="hidden" name="id" value={reply.id} /><input type="hidden" name="archived" value={String(!archived)} /><button className="rounded-md border px-3 py-2 text-sm">{archived ? "Restore" : "Archive"}</button></form></article>)}{output?.next && <Link href={`/replies?archived=${archived}&before=${output.next}`}>Older replies</Link>}</main>;
}
