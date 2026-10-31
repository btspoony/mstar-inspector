/**
 * The closed chart vocabulary (D14): six slots, each with two faces. A large
 * fill paints the quieter `--chart-{n}`; a legend swatch (or a stroke) paints
 * the louder `--chart-{n}-mark`, because a whole stacked bar in the mark's 700
 * step reads as a warning light.
 *
 * A page maps its semantics onto a slot and nothing else — `ChartSlot` closes
 * the set, so a seventh value is a type error rather than a class no
 * stylesheet answers.
 */
export const CHART_SLOTS = [1, 2, 3, 4, 5, 6] as const;

export type ChartSlot = (typeof CHART_SLOTS)[number];

/** The two charts.css classes one slot owns: the fill rule and the mark rule. */
export function chartClasses(slot: ChartSlot): { fill: string; swatch: string } {
  return { fill: `chart-fill-${slot}`, swatch: `chart-swatch-${slot}` };
}
