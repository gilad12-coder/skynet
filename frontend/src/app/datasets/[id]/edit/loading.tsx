import { DatasetEditorSkeleton } from "@/features/datasets";

// Without its own boundary this route inherits /datasets/loading.tsx, which
// flashes the library list and Data hub tabs before the editor.
export default function Loading() {
  return <DatasetEditorSkeleton />;
}
