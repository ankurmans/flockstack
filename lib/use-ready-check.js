import { useEffect, useState } from "react";
import { checkCampaign } from "@/app/(app)/campaigns/actions";

const POLL_MS = 2000;
// Long enough for the claim check (lib/claim-check-rules.js CLAIM_CHECK.timeMs, plus its last requests) to finish.
const MAX_POLLS = 25;

// The review step's ready-to-send check (lib/ready-check.js): asked for each time the step opens, with the draft saved first,
// and asked again every couple of seconds while the server is still opening the links or running the claim check. key: what
// the draft was when the check ran, so a result of words that have changed since doesn't keep the Send button off.
export function useReadyCheck({ campaignId, isActive, persist, key }) {
	const [state, setState] = useState({ result: null, error: null, key: null, isLoading: false });
	// Asked again on demand, like after a test email was sent.
	const [round, setRound] = useState(0);

	useEffect(() => {
		if (!isActive) return;
		let isCancelled = false;
		let timer;

		async function run(attempt) {
			if (attempt === 0) {
				if (!(await persist())) return;
				if (!isCancelled) setState((current) => ({ ...current, isLoading: true, error: null }));
			}
			const result = await checkCampaign(campaignId);
			if (isCancelled) return;
			if (result?.error) return setState((current) => ({ ...current, isLoading: false, error: result.error }));
			setState({ result, error: null, key, isLoading: false });
			if (result.isChecking && attempt < MAX_POLLS) timer = setTimeout(() => run(attempt + 1), POLL_MS);
		}

		// The first look waits a moment: opening the step also saves the draft, and the key settles.
		timer = setTimeout(() => run(0), 0);
		return () => {
			isCancelled = true;
			clearTimeout(timer);
		};
		// key is read when the run starts, not a reason to start another.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [campaignId, isActive, round]);

	const isFresh = state.result !== null && state.key === key;
	return { ...state, isFresh, refresh: () => setRound((current) => current + 1) };
}
