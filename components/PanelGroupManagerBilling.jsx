"use client";
import PanelGroupInvoices from "@/components/PanelGroupInvoices";

export default function PanelGroupManagerBilling({ token, action, language }) {
	function run(operation, after) {
		const form = new FormData(); form.set("token", token); form.set("operation", operation); if (after) form.set("after", after);
		return action(null, form);
	}
	return <PanelGroupInvoices language={language} load={after => run("invoices", after)} openBilling={async () => { const result = await run("billing"); return result.error ? result : { url: result.billingUrl }; }} />;
}
