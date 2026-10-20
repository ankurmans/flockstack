// How much of the day's AI requests the account has used, from the usage a tool answered with.
export default function NoteAiUsage({ usage }) {
	if (!usage) return null;
	return (
		<p className="text-xs text-muted-foreground tabular-nums">
			{usage.limit === null ? `${usage.used} AI requests today` : `${usage.used} of ${usage.limit} AI requests used today`}
		</p>
	);
}
