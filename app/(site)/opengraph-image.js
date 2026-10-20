import { ImageResponse } from "next/og";
import { LOGO_SHAPES, LOGO_TILE, LOGO_VIEWBOX } from "@/components/LogoFlockstack";
import { getAppHost } from "@/lib/config";
import { getShareFonts } from "@/lib/og-image";

// The docs' card on every server: what they cover and the server's own address. FlockStack Cloud's marketing
// website has its own cards.
export const alt = "FlockStack docs: the REST API and the MCP server";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// Rendered on request: the card prints the address of the Worker it's on, which a build doesn't know.
export const dynamic = "force-dynamic";

// Night lime: the app icon's ink and lime, with white text.
const COLORS = { site: LOGO_TILE.background, text: "#fafafa", muted: "#a3a3a3", lime: LOGO_TILE.lime };

function Logo() {
	return (
		<svg width="48" height="48" viewBox={LOGO_VIEWBOX}>
			{LOGO_SHAPES.map(({ d, tone }) => (
				<path key={d} d={d} fill={LOGO_TILE[tone]} />
			))}
		</svg>
	);
}

export default function Image() {
	return new ImageResponse(
		<div
			style={{
				display: "flex",
				width: "100%",
				height: "100%",
				backgroundColor: COLORS.site,
				backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.08) 1.5px, transparent 0)",
				backgroundSize: "28px 28px",
				fontFamily: "Geist",
				color: COLORS.text,
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 1056, height: "100%", padding: "64px 0 60px 72px" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 16 }}>
					<Logo />
					<span style={{ fontSize: 32, fontWeight: 600, letterSpacing: -1 }}>FlockStack</span>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
					<span style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.06, letterSpacing: -2.4 }}>Everything the dashboard does, from code or an AI agent</span>
					<span style={{ fontSize: 30, lineHeight: 1.35, color: COLORS.muted }}>The REST API and the MCP server, documented.</span>
				</div>
				<span style={{ fontSize: 24, color: COLORS.lime }}>{getAppHost()}</span>
			</div>
		</div>,
		{
			...size,
			fonts: getShareFonts(),
		}
	);
}
