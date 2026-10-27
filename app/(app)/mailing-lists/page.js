import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { runDashboardAction } from "@/lib/actions/dashboard";
import FormMailingLists from "@/components/FormMailingLists";
export default async function MailingListsPage() {
	const { selected } = await getSelectedNewsletter(); const newsletter = String(selected._id);
	const { output, failure } = await runDashboardAction("list_mailing_lists", { newsletter });
	return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6"><h1 className="text-2xl font-semibold">Mailing lists</h1>{output ? <FormMailingLists newsletter={newsletter} lists={output.lists} /> : <p>{failure?.message}</p>}</main>;
}
