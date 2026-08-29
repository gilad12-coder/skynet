"use client";

import { Code, Image as ImageIcon } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { MessageMarkdown } from "@/shared/ui/agent/message-markdown";
import { msg } from "@/shared/lib/messages";
import type { CandidateVersion } from "../lib/blackbox-versions";
import {
  detectRenderKind,
  formatJson,
  sideInfoImages,
  sideInfoNotes,
  svgDocument,
  type RenderKind,
} from "../lib/candidate-render";

function SandboxFrame({ doc, scripts, title }: { doc: string; scripts: boolean; title: string }) {
  // Candidates are model-written: HTML may run its own scripts but never
  // shares this origin, and SVG gets no scripts at all.
  return (
    <div className="space-y-1">
      <iframe
        title={title}
        srcDoc={doc}
        sandbox={scripts ? "allow-scripts" : ""}
        referrerPolicy="no-referrer"
        className="h-[28rem] w-full rounded-lg border border-border/50 bg-white"
      />
      <p className="text-[0.6875rem] text-muted-foreground">
        {msg("optimization.blackbox.versions.sandboxed")}
      </p>
    </div>
  );
}

export function isDrawable(kind: RenderKind): boolean {
  return kind !== "python" && kind !== "code";
}

function RenderedText({ text, kind, title }: { text: string; kind: RenderKind; title: string }) {
  switch (kind) {
    case "markdown":
      return (
        <div className="rounded-lg border border-border/50 bg-background/80 px-5 py-4 text-sm leading-relaxed">
          <MessageMarkdown content={text} />
        </div>
      );
    case "svg":
      return <SandboxFrame doc={svgDocument(text)} scripts={false} title={title} />;
    case "html":
      return <SandboxFrame doc={text} scripts title={title} />;
    case "json":
      return (
        <pre
          className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-4 font-mono text-[0.8125rem] leading-relaxed"
          dir="ltr"
        >
          {formatJson(text)}
        </pre>
      );
    default:
      return null;
  }
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
  const images = sideInfoImages(version.sideInfo);
  const notes = sideInfoNotes(version.sideInfo);
  const drawable = parts.some((part) => isDrawable(part.kind));
  const title = `v${version.number}`;

  return (
    <div className="space-y-4">
      {drawable &&
        parts.map((part) => (
          <div key={part.name ?? "candidate"}>
            {part.name && (
              <p className="mb-1 font-mono text-xs font-semibold text-muted-foreground">
                {part.name}
              </p>
            )}
            <RenderedText text={part.text} kind={part.kind} title={`${title} ${part.name ?? ""}`} />
          </div>
        ))}

      {images.length > 0 && (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            <ImageIcon className="size-3.5" aria-hidden="true" />
            {msg("optimization.blackbox.versions.renders")}
          </h4>
          <div className="flex flex-wrap gap-3" dir="ltr">
            {images.map((image) => (
              <figure
                key={image.key}
                className="max-w-full overflow-hidden rounded-lg border border-border/50 bg-white"
              >
                {/* Renders are data URLs the scorer built; a plain <img> shows
                    them without a next/image loader round-trip. */}
                <img
                  src={image.src}
                  alt={image.key}
                  className="max-h-80 max-w-full object-contain"
                />
                <figcaption className="border-t border-border/40 px-2 py-1 font-mono text-[0.6875rem] text-muted-foreground">
                  {image.key}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {!drawable && images.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-6 py-10 text-center">
          <Code className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="max-w-md text-sm text-muted-foreground">
            {msg("optimization.blackbox.versions.no_visual")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onShowCode}>
            {msg("optimization.blackbox.versions.show_code")}
          </Button>
        </div>
      )}

      {notes.length > 0 && (
        <details open={!drawable} className="rounded-lg border border-border/50 bg-muted/20">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-muted-foreground">
            {msg("optimization.blackbox.versions.feedback")}
          </summary>
          <dl className="grid gap-3 px-3 pb-3">
            {notes.map(([key, value]) => (
              <div key={key}>
                <dt className="mb-0.5 font-mono text-[0.6875rem] text-muted-foreground">{key}</dt>
                <dd className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}
