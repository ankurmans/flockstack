import HeaderPage from "@/components/HeaderPage";
import PanelAccountAssistant from "@/components/PanelAccountAssistant";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { isAccountOwner } from "@/lib/team";

export const metadata = { title: "Account assistant" };

export default async function AssistantPage() {
	const { user, account, selected } = await getSelectedNewsletter();
	if (!isAccountOwner(account, user)) return <><HeaderPage title="Account assistant" /><p>The account assistant is available to the account owner.</p></>;
	if (!selected) return <><HeaderPage title="Account assistant" /><p>Create a newsletter first.</p></>;
	const { output, failure } = await runDashboardAction("get_assistant_settings", { newsletter: String(selected._id) });
	return <><HeaderPage title="Account assistant" /><p className="mb-6 max-w-2xl text-sm text-muted-foreground">Work on {selected.name} with a bounded agent. Review each result below; sends and schedules wait on the Approvals page.</p>{failure ? <p role="alert">{failure.message}</p> : <PanelAccountAssistant key={String(selected._id)} newsletterId={String(selected._id)} settings={output} />}</>;
}
