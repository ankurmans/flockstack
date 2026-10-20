import { redirect } from "next/navigation";
import FormEmbedSettings from "@/components/FormEmbedSettings";
import HeaderPage from "@/components/HeaderPage";
import { getAccent } from "@/lib/editor-blocks";
import { listCustomFields } from "@/lib/custom-fields";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "New form" };

export default async function NewFormPage() {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect("/forms");
	const fields = await listCustomFields(account, selected._id);

	return (
		<>
			<HeaderPage title="New form" backHref="/forms" />
			<div className="max-w-3xl">
				<FormEmbedSettings
					newsletterId={String(selected._id)}
					form={null}
					fields={fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }))}
					accent={getAccent(selected)}
				/>
			</div>
		</>
	);
}
