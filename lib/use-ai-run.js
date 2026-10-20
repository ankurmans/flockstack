import { useCallback, useRef, useState } from "react";

// One AI request at a time for a dialog: run(request) calls the server action, keeps the answer or the error, and drops an
// answer the writer already moved past (a newer run, or reset). Started from a click, never from an effect, so a request
// that costs one of the day's allowance is never made twice by a re-render.
export function useAiRun() {
	const [state, setState] = useState({ status: "idle" });
	const latest = useRef(0);

	const run = useCallback(async (request) => {
		const mine = ++latest.current;
		setState({ status: "loading" });
		let result;
		try {
			result = await request();
		} catch {
			result = { error: "Couldn't reach the server. Try again." };
		}
		if (mine !== latest.current) return;
		setState(result?.error ? { status: "error", error: result.error, code: result.code } : { status: "done", data: result });
	}, []);

	const reset = useCallback(() => {
		latest.current++;
		setState({ status: "idle" });
	}, []);

	return { ...state, run, reset };
}
