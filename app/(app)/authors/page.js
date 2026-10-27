import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { runDashboardAction } from "@/lib/actions/dashboard";
import FormAuthors from "@/components/FormAuthors";
export default async function AuthorsPage() {
	const { selected } = await getSelectedNewsletter();
	const { output, failure } = await runDashboardAction("list_newsletter_authors", { newsletter: String(selected._id) });
	return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6"><h1 className="text-2xl font-semibold">Authors</h1>{output ? <FormAuthors newsletter={String(selected._id)} authors={output.authors} /> : <p>{failure.message}</p>}</main>;
}
