import "server-only";
import { ImageResponse } from "next/og";
import { getReadableAccent } from "@/lib/brand";
import { getTextOn } from "@/lib/editor-blocks";
import { formatDate } from "@/lib/format";
import { getShareFonts, readLogo } from "@/lib/og-image";
import { CARD_SIZE } from "@/lib/share-card";
import { sectionIconDataUri, sectionIconPng } from "@/lib/section-icon-png";

// The share card and the section icon PNGs (docs/VISUALS-DESIGN.md), drawn with next/og as PNG bytes. What they show comes from
// lib/share-card.js, so a card's hash names exactly what is drawn.
const COLORS = { foreground: "#0a0a0a", muted: "#5f5f66", border: "#e5e5e5", page: "#ffffff" };
const MAX_TITLE = 140;

// A plain 1200 by 630 card in the page's gray: what a card answers when even the newsletter's own card can't be drawn.
export const FALLBACK_CARD_PNG = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2AQMAAAB1jukfAAAAA1BMVEX09PWosMT8AAAAc0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXg1zqQAB6RqMPAAAAABJRU5ErkJggg=="
	),
	(character) => character.charCodeAt(0)
);

function mix(hex, target, share) {
	const channels = (value) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
	const to = channels(target);
	return `#${channels(hex)
		.map((channel, index) => Math.round(channel + (to[index] - channel) * share).toString(16).padStart(2, "0"))
		.join("")}`;
}

async function toBytes(response) {
	return new Uint8Array(await response.arrayBuffer());
}

function clip(text, limit) {
	const value = String(text ?? "").trim();
	return value.length <= limit ? value : `${value.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`;
}

function titleSize(title) {
	if (title.length <= 48) return 66;
	if (title.length <= 90) return 56;
	return 46;
}

function Mark({ logo, name, accent, size }) {
	if (logo) {
		// eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img>
		return <img src={logo} width={size} height={size} style={{ borderRadius: Math.round(size * 0.22), border: `1px solid ${COLORS.border}` }} alt="" />;
	}
	return (
		<div style={{ width: size, height: size, borderRadius: Math.round(size * 0.22), backgroundColor: accent, color: getTextOn(accent), display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.5), fontWeight: 600 }}>
			{(name.trim().charAt(0) || "?").toUpperCase()}
		</div>
	);
}

// inputs: from getCardInputs. logo: the newsletter's logo as a data URL (readLogo), or null. icons: each section icon key's PNG as a
// data URL (an SVG image comes out blank on Workers).
function ShareCard({ inputs, logo, icons }) {
	const isIssue = typeof inputs.title === "string";
	const ink = getReadableAccent(inputs.accent, COLORS.page);
	const tint = mix(inputs.accent, COLORS.page, 0.88);
	const title = clip(isIssue ? inputs.title : inputs.name, MAX_TITLE);
	const date = isIssue && inputs.date ? formatDate(`${inputs.date}T12:00:00Z`) : "";
	return (
		<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", backgroundColor: COLORS.page, fontFamily: "Geist", color: COLORS.foreground }}>
			<div style={{ display: "flex", height: 18, backgroundColor: inputs.accent }} />
			<div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "space-between", padding: "52px 72px 56px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 22 }}>
					<Mark logo={logo} name={inputs.name} accent={inputs.accent} size={isIssue ? 76 : 104} />
					{isIssue && (
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							<span style={{ fontSize: 34, fontWeight: 600, lineHeight: 1.15 }}>{clip(inputs.name, 60)}</span>
							{inputs.publisher && <span style={{ fontSize: 24, color: COLORS.muted }}>{clip(inputs.publisher, 60)}</span>}
						</div>
					)}
				</div>

				<div style={{ display: "flex", flexDirection: "column", gap: isIssue ? 18 : 10, maxWidth: 1050 }}>
					<span style={{ fontSize: isIssue ? titleSize(title) : 84, fontWeight: 600, lineHeight: 1.1, letterSpacing: isIssue ? -1.5 : -3 }}>{title}</span>
					{!isIssue && inputs.publisher && <span style={{ fontSize: 32, color: COLORS.muted }}>{clip(inputs.publisher, 60)}</span>}
					{!isIssue && inputs.description && <span style={{ fontSize: 32, lineHeight: 1.35, color: COLORS.muted, marginTop: 14 }}>{clip(inputs.description, 150)}</span>}
				</div>

				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 26, color: COLORS.muted }}>
					<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
						{(inputs.icons ?? []).map((key) => (
							<div key={key} style={{ display: "flex", width: 56, height: 56, borderRadius: 14, backgroundColor: tint, alignItems: "center", justifyContent: "center" }}>
								{/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders plain <img> */}
								<img src={icons[key]} width={30} height={30} alt="" />
							</div>
						))}
						{date && <span style={{ marginLeft: inputs.icons?.length ? 10 : 0 }}>{date}</span>}
					</div>
					<span style={{ color: ink, fontWeight: 600 }}>{inputs.host}</span>
				</div>
			</div>
		</div>
	);
}

export async function drawShareCard(inputs) {
	const logo = await readLogo(inputs.logo).catch(() => null);
	const ink = getReadableAccent(inputs.accent, COLORS.page);
	const icons = Object.fromEntries(await Promise.all((inputs.icons ?? []).map(async (key) => [key, await sectionIconDataUri(key, ink)])));
	return toBytes(new ImageResponse(<ShareCard inputs={inputs} logo={logo} icons={icons} />, { ...CARD_SIZE, fonts: getShareFonts() }));
}

// One section icon at 48 by 48 (shown at 24 in email) in color, on a transparent background.
export function drawSectionIcon(key, color) {
	return sectionIconPng(key, color);
}
