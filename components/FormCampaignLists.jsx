"use client";
import { useActionState } from "react";
import { setCampaignLists } from "@/app/(app)/campaigns/actions";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
export default function FormCampaignLists({ campaign, lists = [] }) {
	const [state, action, pending] = useActionState(setCampaignLists.bind(null, String(campaign._id)), null);
	const ids = new Set(lists.map(({ id }) => id));
	const choices = [...lists, ...[...new Set([...(campaign.listIds ?? []), ...(campaign.excludeListIds ?? [])])].filter((id) => !ids.has(id)).map((id) => ({ id, name: "Unavailable list", archived: true }))];
	if (!choices.length) return null;
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3 rounded-lg border p-3 text-sm"><p>Mailing list audience</p><p className="text-xs text-muted-foreground">Include any checked list, then exclude members of the excluded lists. With no included lists, all active subscribers are eligible. Tier and segment choices still apply. Up to 10 lists in each group.</p>{["include", "exclude"].map((side) => <fieldset key={side} className="flex flex-col gap-1"><legend className="mb-1 font-medium">{side === "include" ? "Include" : "Exclude"}</legend>{choices.map((list) => <label key={list.id} className="flex gap-2"><input type="checkbox" name={side} value={list.id} disabled={list.archived && !(campaign[side === "include" ? "listIds" : "excludeListIds"] ?? []).includes(list.id)} defaultChecked={(campaign[side === "include" ? "listIds" : "excludeListIds"] ?? []).includes(list.id)} />{list.name}{list.archived && " (archived)"}</label>)}</fieldset>)}<button disabled={pending} className="self-start rounded-md border px-3 py-1.5">Save list audience</button>{state?.error && <p role="alert">{state.error}</p>}{state?.ok && <p role="status">Saved.</p>}</form>;
}
