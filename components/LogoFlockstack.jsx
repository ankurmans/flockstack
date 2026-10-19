import { cn } from "@/lib/utils";

// Rising flock: two stacked chevrons, the upper one lime. A V of birds, layers, and an arrow up. The share images and
// app icons draw the same shapes, so they import these (scripts/make-logo.py makes them and the icon files).
// tone: "ink" is the text color, "lime" is --logo-lime (#b6d600 on light, #d4ff3a on dark; a newsletter's own pages
// set it back to the text color at half strength). LOGO_TILE: the app icon's colors, the same in either theme.
export const LOGO_VIEWBOX = "0 0 48 48";
export const LOGO_SHAPES = [
	{ d: "M4.68 35.38L21.68 20.38A3.50 3.50 0 0 1 26.32 20.38L43.32 35.38A3.50 3.50 0 0 1 38.68 40.62L24.00 27.67L9.32 40.62A3.50 3.50 0 0 1 4.68 35.38Z", tone: "ink" },
	{ d: "M4.68 22.38L21.68 7.38A3.50 3.50 0 0 1 26.32 7.38L43.32 22.38A3.50 3.50 0 0 1 38.68 27.62L24.00 14.67L9.32 27.62A3.50 3.50 0 0 1 4.68 22.38Z", tone: "lime" },
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
