import { redirect } from "next/navigation";
import CardPostImport from "@/components/CardPostImport";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getImportLimits } from "@/lib/plans";
import { MAX_IMPORT_FILE_BYTES } from "@/lib/post-import-report";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Import posts" };

// The open newsletter's post imports: upload an export, check the preview, start it and follow it to its report.
export default async function ImportPostsPage() {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const { output } = await runDashboardAction("list_post_imports", { newsletter: String(selected._id) });

	return (
		<LayoutNarrow>
			<HeaderPage title="Import posts" backHref="/newsletters" />
			<CardPostImport
				key={String(selected._id)}
				newsletter={{ id: String(selected._id), name: selected.name, archiveEnabled: Boolean(selected.archiveEnabled) }}
				initialImports={output?.imports ?? []}
				limits={getImportLimits(account)}
				maxFileBytes={MAX_IMPORT_FILE_BYTES}
			/>
		</LayoutNarrow>
	);
}
