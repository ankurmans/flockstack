import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { runDashboardAction } from "@/lib/actions/dashboard";
import FormReaderSettings from "@/components/FormReaderSettings";
export default async function ReaderSettingsPage() {
	const { selected } = await getSelectedNewsletter();
	const { output, failure } = await runDashboardAction("get_reader_settings", { newsletter: String(selected._id) });
	return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6"><h1 className="text-2xl font-semibold">Reader settings</h1>{output ? <FormReaderSettings settings={output} /> : <p>{failure.message}</p>}</main>;
}
