import { cn } from "@/lib/utils";

// Rising flock: two stacked chevrons, the upper one fainter. A V of birds, layers, and an arrow up. The
// share images and app icons draw the same shapes, so they import these (scripts/make-logo.py makes them).
export const LOGO_VIEWBOX = "0 0 48 48";
export const LOGO_SHAPES = [
	{ d: "M4.68 35.38L21.68 20.38A3.50 3.50 0 0 1 26.32 20.38L43.32 35.38A3.50 3.50 0 0 1 38.68 40.62L24.00 27.67L9.32 40.62A3.50 3.50 0 0 1 4.68 35.38Z", opacity: 1.0 },
	{ d: "M4.68 22.38L21.68 7.38A3.50 3.50 0 0 1 26.32 7.38L43.32 22.38A3.50 3.50 0 0 1 38.68 27.62L24.00 14.67L9.32 27.62A3.50 3.50 0 0 1 4.68 22.38Z", opacity: 0.5 },
];

export default function LogoFlockstack({ className }) {
	return (
		<svg viewBox={LOGO_VIEWBOX} aria-hidden="true" className={cn("size-6 shrink-0 text-foreground", className)}>
			{LOGO_SHAPES.map(({ d, opacity }) => (
				<path key={d} d={d} fill="currentColor" fillOpacity={opacity} />
			))}
		</svg>
	);
}
