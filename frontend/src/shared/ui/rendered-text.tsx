"use client";

import { MessageMarkdown } from "@/shared/ui/agent/message-markdown";
import { msg } from "@/shared/lib/messages";
import { formatJson, svgDocument, type RenderKind } from "@/shared/lib/candidate-render";

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

/**
 * Draw a candidate's text by kind: markdown as prose, SVG and HTML in a
 * sandboxed frame, JSON pretty-printed. Code kinds have no drawing and render
 * nothing — check `isDrawable` first.
 */
export function RenderedText({
  text,
  kind,
  title,
}: {
  text: string;
  kind: RenderKind;
  title: string;
}) {
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
