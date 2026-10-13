import type { SVGProps } from "react";

/**
 * Skynet's brand mark: a Hoatzin (Opisthocomus hoazin) head as minimal geometric line art.
 * It is built from a few primitives in a 512-unit drawing:
 * - the face is a circle (centre 288,288, r 70) cut by a straight bill base;
 * - the bill is two arcs meeting at the tip;
 * - the crest is an even radial fan centred on the face circle;
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

const FACE = "M341.6 243A70 70 0 1 0 341.6 333Z";
const BILL = "M341.6 243A105 105 0 0 1 436 330A260 260 0 0 0 341.6 333";
const NECK = "M222.2 311.9Q200 410 190 524M298.3 357.2Q277.6 415.1 268 524";
const NECK_BANDS = "M219.4 418L269.6 406M214.3 454L262.6 442M209.9 490L257.3 478";

// Seven feathers 20° apart (168° to 48°), each a lozenge from r 84 to r 236 around the face centre.
const CREST =
  "M205.8 270.5L158.5 273.8 57.2 238.9 163.9 248.3Z" +
  "M216.8 243.5L171.2 230.3 87.9 162.9 185 208.3Z" +
  "M236.3 221.8L198 193.9 142.7 102 218.5 177.9Z" +
  "M262 208.1L235.6 168.8 215.1 63.6 260.3 160.7Z" +
  "M290.9 204.1L279.5 158 296.2 52.1 305.5 158.9Z" +
  "M319.5 210.1L324.5 163 376.4 69.2 348.6 172.7Z" +
  "M344.2 225.6L365.1 183 445.9 112.6 384.4 200.4Z";
const CREST_SPINES =
  "M205.8 270.5L113.7 250.9M216.8 243.5L136.8 193.5M236.3 221.8L178.3 147.5M262 208.1L232.9 118.5" +
  "M290.9 204.1L294.2 109.9M319.5 210.1L354.8 122.7M344.2 225.6L407.3 155.5";

// Five feathers 30° apart on the same fan, as single strokes from r 90 to r 228.
const CREST_SIMPLE =
  "M200 269.3L65 240.6M221.1 227.8L118.6 135.4M260.2 202.4L217.5 71.2M306.7 200L335.4 65M348.2 221.1L440.6 118.6";

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
