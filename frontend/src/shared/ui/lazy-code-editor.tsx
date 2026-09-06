"use client";

import type { CSSProperties } from "react";
import dynamic from "next/dynamic";
import type { CodeEditorProps } from "./code-editor";

const Editor = dynamic(() => import("./code-editor").then((module) => module.CodeEditor), {
  ssr: false,
  loading: () => (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-border/60">
      <div className="border-b border-border/60 bg-muted px-3 py-1.5">
        <div className="size-8 max-lg:size-[44px]" />
      </div>
      <div style={{ height: "var(--editor-loading-height)" }} className="bg-background" />
    </div>
  ),
});

/** Reserve the editor's geometry while its client bundle loads. */
export function LazyCodeEditor({ height = "200px", ...props }: CodeEditorProps) {
  return (
    <div
      className="min-w-0"
      style={
        {
          "--editor-loading-height": props.readOnly ? height : `min(${height}, calc(60vh - 4rem))`,
        } as CSSProperties
      }
    >
      <Editor {...props} height={height} />
    </div>
  );
}
