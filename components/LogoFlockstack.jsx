import { cn } from "@/lib/utils";

// Stack F: three bars shrinking like a list, the top one lime, reading as an F for FlockStack. The share images and
// app icons draw the same shapes, so they import these (scripts/make-logo.py makes them and the icon files).
// tone: "ink" is the text color, "lime" is --logo-lime (#b6d600 on light, #d4ff3a on dark; a newsletter's own pages
// set it back to the text color at half strength). LOGO_TILE: the app icon's colors, the same in either theme.
export const LOGO_VIEWBOX = "0 0 48 48";
export const LOGO_SHAPES = [
	{ d: "M10.50 7.00H37.50A4.50 4.50 0 0 1 37.50 16.00H10.50A4.50 4.50 0 0 1 10.50 7.00Z", tone: "lime" },
	{ d: "M10.50 20.00H27.50A4.50 4.50 0 0 1 27.50 29.00H10.50A4.50 4.50 0 0 1 10.50 20.00Z", tone: "ink" },
	{ d: "M10.50 33.00H10.50A4.50 4.50 0 0 1 10.50 42.00H10.50A4.50 4.50 0 0 1 10.50 33.00Z", tone: "ink" },
];
export const LOGO_TILE = { background: "#0b0b0b", ink: "#f2f2f2", lime: "#d4ff3a" };

export default function LogoFlockstack({ className }) {
	return (
		<svg viewBox={LOGO_VIEWBOX} aria-hidden="true" className={cn("size-6 shrink-0 text-foreground", className)}>
			{LOGO_SHAPES.map(({ d, tone }) => (
				<path key={d} d={d} fill={tone === "lime" ? "var(--logo-lime)" : "currentColor"} />
			))}
		</svg>
	);
}
