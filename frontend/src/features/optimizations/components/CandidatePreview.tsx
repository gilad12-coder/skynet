"use client";

import { Carousel } from "@/features/agent-panel";
import { Code } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { formatMsg, msg } from "@/shared/lib/messages";
import type { CandidateVersion } from "../lib/blackbox-versions";
import {
  detectRenderKind,
  isDrawable,
  sideInfoImages,
  type RenderKind,
} from "@/shared/lib/candidate-render";
import { RenderedText } from "@/shared/ui/rendered-text";

interface PartSlide {
  type: "part";
  key: string;
  label: string | null;
  text: string;
  kind: RenderKind;
}

interface ImageSlide {
  type: "image";
  key: string;
  label: string;
  src: string;
}

type Slide = PartSlide | ImageSlide;

function SlideView({ slide, title }: { slide: Slide; title: string }) {
  // The carousel root is select-none so arrow-key paging never fights text
  // selection; the slide itself must stay copyable.
  return (
    <div className="select-text">
      {slide.type === "part" && slide.label && (
        <p className="mb-1 font-mono text-xs font-semibold text-muted-foreground">{slide.label}</p>
      )}
      {slide.type === "image" ? (
        <div className="overflow-hidden rounded-lg border border-border/50 bg-white" dir="ltr">
          {/* Renders are data URLs the scorer built; a plain <img> shows
              them without a next/image loader round-trip. */}
          <img
            src={slide.src}
            alt={slide.label}
            className="mx-auto max-h-[28rem] max-w-full object-contain"
          />
        </div>
      ) : (
        <RenderedText text={slide.text} kind={slide.kind} title={`${title} ${slide.label ?? ""}`} />
      )}
    </div>
  );
}

export function CandidatePreview({
  version,
  kind,
  onShowCode,
}: {
  version: CandidateVersion;
  kind: RenderKind;
  onShowCode: () => void;
}) {
  const parts =
    typeof version.candidate === "string"
      ? [{ name: null, text: version.candidate, kind }]
      : Object.entries(version.candidate).map(([name, text]) => ({
          name,
          text,
          kind: detectRenderKind(text),
        }));
  const slides: Slide[] = [
    ...parts
      .filter((part) => isDrawable(part.kind))
      .map<PartSlide>((part) => ({
        type: "part",
        key: `part:${part.name ?? "candidate"}`,
        label: part.name,
        text: part.text,
        kind: part.kind,
      })),
    ...sideInfoImages(version.sideInfo).map<ImageSlide>((image) => ({
      type: "image",
      key: `image:${image.key}`,
      label: image.key,
      src: image.src,
    })),
  ];
  const title = `v${version.number}`;

  if (slides.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-6 py-10 text-center">
        <Code className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-md text-sm text-muted-foreground">
          {msg("optimization.blackbox.versions.no_visual")}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onShowCode}>
          {msg("optimization.blackbox.versions.show_code")}
        </Button>
      </div>
    );
  }

  const only = slides.length === 1 ? slides[0] : undefined;
  if (only) return <SlideView slide={only} title={title} />;

  return (
    <Carousel
      items={slides}
      itemKey={(slide) => slide.key}
      renderItem={(slide) => <SlideView slide={slide} title={title} />}
      fluid
      ariaLabel={formatMsg("optimization.blackbox.versions.carousel_aria", { n: version.number })}
    />
  );
}
