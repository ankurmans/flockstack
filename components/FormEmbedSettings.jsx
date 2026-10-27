"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createForm, deleteForm, updateForm } from "@/app/(app)/forms/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import FieldsSignupFlow from "@/components/FieldsSignupFlow";
import FormEmbed from "@/components/FormEmbed";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_BUTTON_TEXT, DEFAULT_SUCCESS_MESSAGE, MAX_FORM_FIELDS, getFormColors } from "@/lib/form-rules";
import { toast } from "@/lib/toast";

const COLORS = [
	["button", "Button", "The newsletter's accent color"],
	["buttonText", "Button text", "Black or white, whichever reads better"],
	["background", "Background", "None: it takes the page's"],
	["text", "Text and borders", "Near-black"],
];

function fromForm(form) {
	return {
		name: form?.name ?? "",
		buttonText: form?.buttonText ?? "",
		fields: form?.fields ?? [],
		colors: { button: "", buttonText: "", background: "", text: "", ...form?.colors },
		successMessage: form?.successMessage ?? "",
		redirectUrl: form?.redirectUrl ?? "",
		flow: form?.flow ?? [],
		archiveDefault: form?.archiveDefault === true,
	};
}

// A signup form for other sites, drawn as it will look. fields: the newsletter's custom fields it can ask for; accent:
// the newsletter's accent color, the button's unless a color is chosen.
export default function FormEmbedSettings({ newsletterId, form, fields, accent, surveys = [] }) {
	const router = useRouter();
	const [draft, setDraft] = useState(() => fromForm(form));
	const [isPending, startTransition] = useTransition();
	const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
	const setColor = (key, value) => setDraft((current) => ({ ...current, colors: { ...current.colors, [key]: value } }));
	const toggleField = (key) =>
		set("fields", draft.fields.includes(key) ? draft.fields.filter((item) => item !== key) : [...draft.fields, key]);

	const colors = getFormColors({ colors: Object.fromEntries(Object.entries(draft.colors).filter(([, value]) => /^#[0-9a-f]{6}$/i.test(value))) }, { accentColor: accent });
	const asked = draft.fields.map((key) => fields.find((field) => field.key === key)).filter(Boolean);

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = form ? await updateForm(form.id, draft) : await createForm(newsletterId, draft);
			if (result?.error) return void toast.error(result.error);
			toast.success("Form saved");
			if (!form) router.push(`/forms/${result.id}`);
			else router.refresh();
		});
	}

	function remove() {
		if (!window.confirm("Delete this form? Copies of it on other sites stop working. It can't be undone.")) return;
		startTransition(async () => {
			const result = await deleteForm(form.id);
			if (result?.error) return void toast.error(result.error);
			router.push("/forms");
		});
	}

	return (
		<form onSubmit={save} className="flex flex-col gap-4">
			<CardSettings title="Form">
				<RowSettings label="Name" hint="For you: the dashboard and reports. Visitors don't see it." isLabel>
					<Input value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={80} required />
				</RowSettings>
				<RowSettings label="Button" isLabel>
					<Input value={draft.buttonText} onChange={(event) => set("buttonText", event.target.value)} maxLength={30} placeholder={DEFAULT_BUTTON_TEXT} />
				</RowSettings>
				<RowSettings
					label="Also ask for"
					hint={fields.length === 0 ? "A name or any other question is a custom field. Add one from Contacts, then ask for it here." : `After the email, ${MAX_FORM_FIELDS} at most.`}
				>
					{fields.map(({ key, label }) => (
						<label key={key} className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={draft.fields.includes(key)}
								disabled={!draft.fields.includes(key) && draft.fields.length >= MAX_FORM_FIELDS}
								onChange={() => toggleField(key)}
								className="size-4 accent-foreground"
							/>
							{label}
						</label>
					))}
				</RowSettings>
			</CardSettings>

			<CardSettings title="Colors">
				{COLORS.map(([key, label, hint]) => (
					<RowSettings key={key} label={label} hint={draft.colors[key] ? null : hint}>
						<span className="flex items-center gap-2">
							<input
								type="color"
								value={/^#[0-9a-f]{6}$/i.test(draft.colors[key]) ? draft.colors[key] : colors[key].startsWith("#") ? colors[key] : "#ffffff"}
								onChange={(event) => setColor(key, event.target.value)}
								aria-label={`Pick the ${label.toLowerCase()} color`}
								className="size-9 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-1"
							/>
							<Input value={draft.colors[key]} onChange={(event) => setColor(key, event.target.value.trim())} placeholder="Default" maxLength={7} className="w-32 font-mono" aria-label={`${label} color`} />
							{draft.colors[key] && (
								<Button type="button" variant="ghost" size="sm" onClick={() => setColor(key, "")}>
									Reset
								</Button>
							)}
						</span>
					</RowSettings>
				))}
			</CardSettings>

			<CardSettings title="After a signup">
				<RowSettings label="Message" hint="A signup that has to be confirmed always says to check the inbox." isLabel>
					<Textarea value={draft.successMessage} onChange={(event) => set("successMessage", event.target.value)} maxLength={200} rows={2} placeholder={DEFAULT_SUCCESS_MESSAGE} />
				</RowSettings>
				<RowSettings label="Or go to" hint="An https:// page of yours after the optional steps. With confirmed opt-in, remind readers there to confirm their email." isLabel>
					<Input type="url" value={draft.redirectUrl} onChange={(event) => set("redirectUrl", event.target.value.trim())} maxLength={500} placeholder="https://example.com/thanks" />
				</RowSettings>
			</CardSettings>

			<CardSettings title="After-signup steps" stagger={3}><FieldsSignupFlow value={draft.flow} onChange={(flow) => set("flow", flow)} surveys={surveys} /><label className="flex items-center gap-2 px-4 pb-4 text-sm"><input type="checkbox" checked={draft.archiveDefault} onChange={(event) => set("archiveDefault", event.target.checked)} />Use these steps after archive and popup signups</label></CardSettings>
			<section className="rounded-xl bg-card shadow-border animate-enter">
				<h2 className="flex h-12 items-center px-4 text-sm font-medium">Preview</h2>
				<div className="border-t border-border/60 bg-white p-4">
					<div className="mx-auto max-w-md">
						<FormEmbed
							key={JSON.stringify([asked, draft.buttonText, colors])}
							fields={asked}
							buttonText={draft.buttonText.trim() || DEFAULT_BUTTON_TEXT}
							colors={colors}
							message={draft.successMessage.trim() || DEFAULT_SUCCESS_MESSAGE}
						/>
					</div>
				</div>
			</section>

			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" disabled={isPending}>
					{isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
				{form && (
					<Button type="button" variant="ghost" onClick={remove} disabled={isPending} className="ml-auto text-muted-foreground hover:text-destructive">
						Delete
					</Button>
				)}
			</div>
		</form>
	);
}
