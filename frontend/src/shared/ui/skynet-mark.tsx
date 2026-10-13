import type { SVGProps } from "react";

/**
 * Skynet's brand mark: a Hoatzin (Opisthocomus hoazin) head as minimal geometric line art.
 * It is built from a few primitives in a 512-unit drawing:
 * - the face is a circle (centre 288,288, r 70) cut by a straight bill base;
 * - the bill is the top terminal of the wordmark's default "S": an outer arc, a flat cut at
 *   the tip and a concave arc back to the face, so the tip hooks below the gape;
 * - the crest is an even radial fan centred on the face circle, longest in the middle;
 * - the neck is one curve and the same curve shifted forward.
 * Every stroke is `currentColor`, so the mark takes the surrounding text colour in both
 * themes. The neck runs off the bottom edge on purpose; round containers clip it there.
 *
 * Two levels of detail, picked by rendered size:
 * - "full" (about 64px and up): seven lozenge feathers with spines, a ringed eye, three
 *   neck bands and one faint guide circle around the eye.
 * - "simple" (icon sizes, and the favicons): five single-stroke feathers, a solid eye and
 *   strokes that scale with the mark so they stay distinct at 16-32px.
 */

export type HoatzinDetail = "full" | "simple";

// Square crop of the 512-unit drawing, centred on the bird.
export const HOATZIN_VIEWBOX = "-2 12 500 500";

// Tight crop for the wordmark lockup: crest tips to mid-neck, no side padding.
export const HOATZIN_LOCKUP_VIEWBOX = "48 12 400 432";

// The wordmark lockup aligns the letters' centre line to this point.
const EYE = { cx: 306.9, cy: 285.2 };

// The face circle is closed by the bill base, a chord between its points at -30° and +30°.
const FACE = "M348.6 253A70 70 0 1 0 348.6 323Z";
// Outer arc (r 74, centre 348.3,327, like the S's top) to a tip 4° below its centre, a flat
// cut a third of that radius (the S's terminal), then a concave r 60 arc back to the face
// (the S's counter). The bill reaches about 64 units past the face, with its tip just below the gape.
const BILL = "M348.6 253A74 74 0 0 1 422.1 332.2H396.9A60 60 0 0 0 348.6 323";
const NECK = "M222.2 311.9Q200 410 190 524M298.3 357.2Q277.6 415.1 268 524";
const NECK_BANDS = "M219.4 418L269.6 406M214.3 454L262.6 442M209.9 490L257.3 478";

// Seven feathers 20° apart (168° to 48°), each a lozenge from r 84 around the face centre.
// Lengths follow a sine curve, longest in the middle (r 236) and r 168 at both ends.
const CREST =
  "M205.8 270.5L178.5 278 123.7 253.1 183.9 252.6Z" +
  "M216.8 243.5L179.9 235.8 116.7 181 193.6 213.7Z" +
  "M236.3 221.8L199.6 196 148.3 109.2 220.1 180Z" +
  "M262 208.1L235.6 168.8 215.1 63.6 260.3 160.7Z" +
  "M290.9 204.1L279.4 160.8 295.9 61.2 305.4 161.7Z" +
  "M319.5 210.1L320.7 172.4 363.7 100.7 344.8 182.2Z" +
  "M344.2 225.6L351.4 198.1 400.4 163.2 370.7 215.5Z";
const CREST_SPINES =
  "M205.8 270.5L154.9 259.7M216.8 243.5L154.7 204.7M236.3 221.8L181.7 152M262 208.1L232.9 118.5" +
  "M290.9 204.1L294 115.5M319.5 210.1L346.9 142.3M344.2 225.6L379.1 186.9";

// Five feathers 30° apart on the same fan, as single strokes from r 90, graduated r 228 to r 170.
const CREST_SIMPLE =
  "M200 269.3L121.7 252.7M221.1 227.8L131.2 146.8M260.2 202.4L217.5 71.2M306.7 200L331.9 81.6M348.2 221.1L401.8 161.7";

/**
 * The bird's strokes in the 512-unit drawing, for embedding in another SVG (the wordmark
 * lockup). Renders at any size; the caller picks the detail level for its size.
 */
export function HoatzinShapes({ detail = "full" }: { detail?: HoatzinDetail }) {
  if (detail === "simple") {
    return (
      <g fill="none" stroke="currentColor" strokeWidth={26} strokeLinecap="round" strokeLinejoin="round">
        <path d={CREST_SIMPLE + FACE + BILL + NECK} />
        <circle {...EYE} r={26} fill="currentColor" stroke="none" />
      </g>
    );
  }
  const line = { vectorEffect: "non-scaling-stroke" } as const;
  return (
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle {...EYE} r={44} strokeWidth={0.75} strokeOpacity={0.35} {...line} />
      <path d={CREST_SPINES + NECK_BANDS} strokeWidth={1} {...line} />
      <path d={CREST + FACE + BILL + NECK} strokeWidth={1.5} {...line} />
      <circle {...EYE} r={26} strokeWidth={1.5} {...line} />
      <circle {...EYE} r={15} strokeWidth={1} {...line} />
      <circle {...EYE} r={6} fill="currentColor" stroke="none" />
    </g>
  );
}

/** The standalone mark. Defaults to the reduced detail its icon-sized call sites need. */
export function SkynetMark({ detail = "simple", ...props }: SVGProps<SVGSVGElement> & { detail?: HoatzinDetail }) {
  return (
    <svg viewBox={HOATZIN_VIEWBOX} xmlns="http://www.w3.org/2000/svg" {...props}>
      <HoatzinShapes detail={detail} />
    </svg>
  );
}
