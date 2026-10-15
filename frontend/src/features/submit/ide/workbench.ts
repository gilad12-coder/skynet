/**
 * VS Code's workbench, booted once per page into a container the IDE pop-up
 * borrows while it is open. Its `file://` scheme is the wizard's workspace,
 * through `WorkspaceFs`: the explorer, editors and search all read and write
 * the same files the wizard holds.
 *
 * Client-only and heavy: the pop-up loads this module with a dynamic import.
 */
import "@codingame/monaco-vscode-python-default-extension";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import { initialize, getService } from "@codingame/monaco-vscode-api";
import type { IMonacoEnvironment } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/browser";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import {
  Disposable,
  type IDisposable,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { ICommandService } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { IWorkbenchLayoutService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService.service";
import getConfigurationServiceOverride, {
  initUserConfiguration,
  updateUserConfiguration,
} from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getFilesServiceOverride, {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  registerCustomProvider,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
} from "@codingame/monaco-vscode-files-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import { workspacePathIssue } from "../lib/wizard-v2";
import {
  IDE_ROOT,
  WorkspaceFs,
  WorkspaceFsError,
  workspacePathOf,
  type WorkspaceFsChange,
  type WorkspaceTexts,
} from "../lib/ide-workspace";

/** What the pop-up drives the booted workbench with. */
export interface IdeWorkbench {
  /** The workbench's own element; the pop-up mounts it and gives it back. */
  readonly element: HTMLElement;
  /** Mirror the wizard's files into the IDE. */
  load(texts: WorkspaceTexts): void;
  /** Where the IDE's edits go: the whole workspace after each one. */
  onEdit(sink: ((texts: Record<string, string>) => void) | null): void;
  setDark(dark: boolean): void;
  layout(): void;
  /** Write every unsaved editor to the workspace. */
  saveAll(): Promise<void>;
  openFile(path: string): Promise<void>;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const FS_CODES: Record<WorkspaceFsError["code"], FileSystemProviderErrorCode> = {
  "not-found": FileSystemProviderErrorCode.FileNotFound,
  exists: FileSystemProviderErrorCode.FileExists,
  "not-a-folder": FileSystemProviderErrorCode.FileNotADirectory,
  "is-a-folder": FileSystemProviderErrorCode.FileIsADirectory,
  refused: FileSystemProviderErrorCode.NoPermissions,
};

/**
 * `file://` as the workspace: `/` holds only the workspace folder, and
 * everything under it is `WorkspaceFs`. Refusals carry the localized reason,
 * which VS Code shows in its error notification.
 */
class WorkspaceFsProvider
  extends Disposable
  implements IFileSystemProviderWithFileReadWriteCapability
{
  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
  readonly onDidChangeCapabilities = Event.None;
  private readonly changes = this._register(new Emitter<readonly IFileChange[]>());
  readonly onDidChangeFile = this.changes.event;
  private readonly fs: WorkspaceFs;
  private readonly describe: (issue: string) => string;

  constructor(fs: WorkspaceFs, describe: (issue: string) => string) {
    super();
    this.fs = fs;
    this.describe = describe;
  }

  fire(changes: WorkspaceFsChange[]): void {
    const kinds = {
      added: FileChangeType.ADDED,
      changed: FileChangeType.UPDATED,
      deleted: FileChangeType.DELETED,
    };
    this.changes.fire(
      changes.map((change) => ({
        type: kinds[change.kind],
        resource: URI.file(change.path ? `${IDE_ROOT}/${change.path}` : IDE_ROOT),
      })),
    );
  }

  private run<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof WorkspaceFsError)) throw error;
      const message = error.issue ? this.describe(error.issue) : error.code;
      throw FileSystemProviderError.create(message, FS_CODES[error.code]);
    }
  }

  private path(resource: URI): string {
    const path = workspacePathOf(resource.path);
    if (path === null)
      throw FileSystemProviderError.create("not found", FileSystemProviderErrorCode.FileNotFound);
    return path;
  }

  watch(): IDisposable {
    return Disposable.None;
  }

  async stat(resource: URI): Promise<IStat> {
    if (resource.path === "/") return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const stat = this.run(() => this.fs.stat(this.path(resource)));
    return {
      type: stat.kind === "file" ? FileType.File : FileType.Directory,
      ctime: 0,
      mtime: stat.mtime,
      size: stat.size,
    };
  }

  async readdir(resource: URI): Promise<Array<[string, FileType]>> {
    if (resource.path === "/") return [[IDE_ROOT.slice(1), FileType.Directory]];
    return this.run(() => this.fs.readdir(this.path(resource))).map(([name, kind]) => [
      name,
      kind === "file" ? FileType.File : FileType.Directory,
    ]);
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    return ENCODER.encode(this.run(() => this.fs.read(this.path(resource))));
  }

  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    this.run(() => this.fs.write(this.path(resource), DECODER.decode(content), opts));
  }

  async mkdir(resource: URI): Promise<void> {
    this.run(() => this.fs.mkdir(this.path(resource)));
  }

  async delete(resource: URI, _opts: IFileDeleteOptions): Promise<void> {
    this.run(() => this.fs.delete(this.path(resource)));
  }

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    this.run(() => this.fs.rename(this.path(from), this.path(to), opts));
  }
}

function settings(dark: boolean): string {
  return JSON.stringify({
    "workbench.colorTheme": dark ? "Default Dark Modern" : "Default Light Modern",
    // The wizard's state is the workspace, so an edit reaches it without a save.
    "files.autoSave": "afterDelay",
    "files.autoSaveDelay": 300,
    "workbench.startupEditor": "none",
    "workbench.layoutControl.enabled": false,
    "window.commandCenter": false,
    "security.workspace.trust.enabled": false,
    "editor.minimap.enabled": false,
    "editor.fontSize": 13,
  });
}

// Workers by the label VS Code asks for. Each entry file only imports the
// package's worker, so the bundler emits it as its own module-worker chunk.
function workerFor(label: string): Worker {
  if (label === "TextMateWorker") {
    return new Worker(new URL("./workers/textmate.worker.ts", import.meta.url), { type: "module" });
  }
  return new Worker(new URL("./workers/editor.worker.ts", import.meta.url), { type: "module" });
}

let booted: Promise<IdeWorkbench> | null = null;

/**
 * The page's one workbench; VS Code can be initialized only once, so later
 * calls get the same one. `describe` turns a refusal's i18n key into text.
 */
export function bootWorkbench(
  dark: boolean,
  describe: (issue: string) => string,
): Promise<IdeWorkbench> {
  booted ??= boot(dark, describe).catch((error: unknown) => {
    booted = null;
    throw error;
  });
  return booted;
}

async function boot(dark: boolean, describe: (issue: string) => string): Promise<IdeWorkbench> {
  (window as Window & { MonacoEnvironment?: IMonacoEnvironment }).MonacoEnvironment = {
    getWorker: (_moduleId, label) => workerFor(label),
  };

  let sink: ((texts: Record<string, string>) => void) | null = null;
  let provider: WorkspaceFsProvider | null = null;
  const fs = new WorkspaceFs(
    workspacePathIssue,
    (changes) => provider?.fire(changes),
    (texts) => sink?.(texts),
  );
  provider = new WorkspaceFsProvider(fs, describe);
  registerCustomProvider("file", provider);

  const element = document.createElement("div");
  element.style.width = "100%";
  element.style.height = "100%";
  // VS Code lays itself out against the container, so it must be in the
  // document while it boots; it stays hidden until the pop-up moves it into place.
  element.style.position = "fixed";
  element.style.inset = "0";
  element.style.visibility = "hidden";
  document.body.append(element);

  await initUserConfiguration(settings(dark));
  await initialize(
    {
      ...getConfigurationServiceOverride(),
      ...getFilesServiceOverride(),
      ...getModelServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getSearchServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getWorkbenchServiceOverride(),
    },
    element,
    {
      workspaceProvider: {
        trusted: true,
        workspace: { folderUri: URI.file(IDE_ROOT) },
        open: async () => false,
      },
    },
  );

  const layoutService = await getService(IWorkbenchLayoutService);
  const commandService = await getService(ICommandService);
  const editorService = await getService(IEditorService);
  let darkNow = dark;

  return {
    element,
    load: (texts) => fs.load(texts),
    onEdit: (next) => {
      sink = next;
    },
    setDark: (next) => {
      if (next === darkNow) return;
      darkNow = next;
      void updateUserConfiguration(settings(next));
    },
    layout: () => layoutService.layout(),
    saveAll: async () => {
      await commandService.executeCommand("workbench.action.files.saveAll");
    },
    openFile: async (path) => {
      await editorService.openEditor({
        resource: URI.file(`${IDE_ROOT}/${path}`),
        options: { pinned: true },
      });
    },
  };
}
