"use client";

import { useEffect, useRef, useState } from "react";

const PARENT_PATTERN = /^https?:\/\/[^/\s?#]+$/i;

// A signup form as another site shows it, in a frame: drawn from the form's own colors (never the theme's), posting to
// the form's address, and telling the page around it how tall it is. Without formId it is the dashboard's preview and
// sends nothing. state: "pending" or "done" when a plain form post came back to this page; errorText: why that post was refused.
export default function FormEmbed({ formId, fields = [], buttonText, colors, message, parent = "", utm = {}, state = "", errorText = "", className }) {
	const [result, setResult] = useState(state ? { ok: true, pending: state === "pending", message } : null);
	const [problem, setProblem] = useState(errorText);
	const [isSending, setIsSending] = useState(false);
	const [email, setEmail] = useState("");
	const rootRef = useRef(null);
	const target = PARENT_PATTERN.test(parent) ? parent : "*";

	// The page that shows the frame sets its height from this, and the script checks who sent it.
	useEffect(() => {
		if (!formId || window.parent === window) return;
		const send = (message) => window.parent.postMessage({ source: "flockstack-form", form: formId, ...message }, target);
		const report = () => send({ type: "resize", height: Math.ceil(rootRef.current?.getBoundingClientRect().height ?? document.body.scrollHeight) });
		const observer = new ResizeObserver(report);
		observer.observe(rootRef.current);
		report();
		return () => observer.disconnect();
	}, [formId, target]);

	async function submit(event) {
		event.preventDefault();
		if (!formId || isSending) return;
		setIsSending(true);
		setProblem("");
		const body = Object.fromEntries(new FormData(event.currentTarget).entries());
		const multiple = fields.filter((field) => field.multiple).map((field) => `field_${field.key}`);
		const data = new FormData(event.currentTarget);
		for (const name of multiple) body[name] = data.getAll(name);
		try {
			const response = await fetch(`/f/${formId}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ ...body, ...utm, ...(parent && { page: parent }) }),
			});
			const answer = await response.json();
			if (!answer.ok) return setProblem(answer.error || "Something went wrong. Try again.");
			if (answer.redirectUrl) {
				if (window.parent === window) return void window.location.assign(answer.redirectUrl);
				window.parent.postMessage({ source: "flockstack-form", form: formId, type: "redirect", url: answer.redirectUrl }, target);
			}
			setResult(answer);
		} catch {
			setProblem("Something went wrong. Try again.");
		} finally {
			setIsSending(false);
		}
	}

	const field = "box-border w-full rounded-lg border bg-transparent px-3 text-base outline-none placeholder:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2";
	const fieldStyle = { height: 44, color: "inherit", borderColor: `color-mix(in srgb, ${colors.text} 30%, transparent)`, outlineColor: colors.button };

	return (
		<div
			ref={rootRef}
			className={className}
			style={{ background: colors.background, color: colors.text, padding: 4, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}
		>
			{result ? (
				<div role="status" className="flex items-start gap-3" style={{ padding: "10px 4px", fontSize: 16, lineHeight: 1.5 }}>
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={colors.button} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0">
						<circle cx="12" cy="12" r="10" />
						<path d="m8 12.5 3 3 5-6" />
					</svg>
					<p className="m-0">
						{result.pending
							? `Almost there. Click the link we just emailed to ${email || "you"} to confirm.`
							: result.message || message}
					</p>
				</div>
			) : (
				<form onSubmit={submit} action={formId ? `/f/${formId}` : undefined} method="post" className="m-0 flex flex-col gap-2">
					{fields.map(({ key, label, type, options = [], multiple }) => {
						const name = `field_${key}`;
						if (type === "boolean") {
							return (
								<label key={key} className="flex items-center gap-2 text-sm">
									<input type="checkbox" name={name} value="true" style={{ accentColor: colors.button }} />
									{label}
								</label>
							);
						}
						if (type === "list") {
							return (
								<select key={key} name={name} multiple={multiple} aria-label={label} defaultValue={multiple ? [] : ""} className={field} style={{ ...fieldStyle, height: multiple ? "auto" : 44 }}>
									{!multiple && <option value="">{label}</option>}
									{options.map((option) => (
										<option key={option}>{option}</option>
									))}
								</select>
							);
						}
						return (
							<input
								key={key}
								type={{ number: "number", date: "date", datetime: "datetime-local" }[type] ?? "text"}
								name={name}
								placeholder={label}
								aria-label={label}
								maxLength={type === "text" ? 500 : undefined}
								className={field}
								style={fieldStyle}
							/>
						);
					})}
					<div className="flex gap-2 max-[420px]:flex-col">
						<input
							type="email"
							name="email"
							required
							autoComplete="email"
							placeholder="you@example.com"
							aria-label="Email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							className={`${field} min-w-0 flex-1`}
							style={fieldStyle}
						/>
						<button
							type="submit"
							disabled={isSending}
							className="box-border shrink-0 cursor-pointer rounded-lg border-0 px-5 text-base font-medium outline-none focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
							style={{ height: 44, background: colors.button, color: colors.buttonText, outlineColor: colors.button }}
						>
							{buttonText}
						</button>
					</div>
					<div aria-hidden="true" style={{ position: "absolute", left: -10000, width: 1, height: 1, overflow: "hidden" }}>
						<input type="text" name="website" tabIndex={-1} autoComplete="off" />
					</div>
					{problem && (
						<p role="alert" className="m-0 text-sm" style={{ color: "#b91c1c" }}>
							{problem}
						</p>
					)}
				</form>
			)}
		</div>
	);
}
