import { KeyRound } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonsAiKey from "@/components/ButtonsAiKey";
import FormAiKey from "@/components/FormAiKey";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { AI_PROVIDER_LABELS } from "@/lib/ai-keys";
import { requireAccount } from "@/lib/auth";
import { formatRelative } from "@/lib/format";

export const metadata = { title: "AI keys" };

// The account's own keys for AI providers, which its briefings' steps use, through list_ai_keys: never the key, only its last four characters.
export default async function AiKeysPage() {
	const { account, user } = await requireAccount();
	const { keys } = await runAction("list_ai_keys", { account, user, input: {}, via: "dashboard" });

	return (
		<>
			<HeaderPage title="AI keys" backHref="/briefings" />
			<div className="flex flex-col gap-8">
				<p className="max-w-prose text-sm text-pretty text-muted-foreground">
					Briefings run on your own AI provider&apos;s key, so the model cost is yours and capped per run, and can search with your own search
					key. A key is encrypted when you save it and is never shown again: FlockStack sends it only to the provider it is for.
				</p>
				{keys.length === 0 ? (
					<StateEmpty icon={KeyRound} title="No AI keys yet" />
				) : (
					<div className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Name</TableHead>
									<TableHead>Key</TableHead>
									<TableHead className="hidden sm:table-cell">Last used</TableHead>
									<TableHead className="pr-4 text-right">
										<span className="sr-only">Actions</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{keys.map((key) => (
									<TableRow key={key.id}>
										<TableCell className="max-w-0 py-3 pl-4 font-medium">
											<span className="block truncate">{key.name}</span>
											<span className="block truncate text-xs font-normal text-muted-foreground">
												{key.providerLabel}
												{key.usedBy > 0 && `, used by ${key.usedBy === 1 ? "1 briefing" : `${key.usedBy} briefings`}`}
											</span>
										</TableCell>
										<TableCell>
											<span className="flex flex-col items-start gap-1">
												<code className="text-xs text-muted-foreground">…{key.hint}</code>
												<BadgeStatus status={key.status} />
											</span>
										</TableCell>
										<TableCell className="hidden text-muted-foreground sm:table-cell">{key.lastUsedAt ? formatRelative(key.lastUsedAt) : "Never"}</TableCell>
										<TableCell className="pr-4 text-right">
											<ButtonsAiKey id={key.id} isUsed={key.usedBy > 0} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
				<FormAiKey providers={Object.entries(AI_PROVIDER_LABELS).map(([value, label]) => ({ value, label }))} />
			</div>
		</>
	);
}
