import type { ConnectorProvider } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";

/**
 * The Google Picker, loaded on demand. The Drive and Sheets connectors link
 * with the ``drive.file`` scope, so a file becomes readable to Skynet only once
 * the user picks it here.
 */

const GAPI_SRC = "https://apis.google.com/js/api.js";

export interface PickedFile {
  id: string;
  name: string;
}

interface PickerDoc {
  id: string;
  name?: string;
}

interface PickerData {
  action: string;
  docs?: PickerDoc[];
}

interface DocsView {
  setIncludeFolders(on: boolean): DocsView;
  setSelectFolderEnabled(on: boolean): DocsView;
}

interface PickerBuilder {
  setAppId(id: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setCallback(callback: (data: PickerData) => void): PickerBuilder;
  build(): { setVisible(on: boolean): void };
}

interface PickerNamespace {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: string) => DocsView;
  ViewId: { DOCS: string; SPREADSHEETS: string };
  Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
  Action: { PICKED: string; CANCEL: string };
}

interface GoogleWindow {
  gapi?: { load(name: string, options: { callback: () => void; onerror: () => void }): void };
  google?: { picker?: PickerNamespace };
}

let loading: Promise<PickerNamespace> | null = null;

function loadPicker(): Promise<PickerNamespace> {
  if (loading) return loading;
  const win = window as unknown as GoogleWindow;
  loading = new Promise<PickerNamespace>((resolve, reject) => {
    const loadModule = () =>
      win.gapi?.load("picker", {
        callback: () =>
          win.google?.picker
            ? resolve(win.google.picker)
            : reject(new Error(msg("connector_import.pick_error"))),
        onerror: () => reject(new Error(msg("connector_import.pick_error"))),
      });
    if (win.gapi) {
      loadModule();
      return;
    }
    const script = document.createElement("script");
    script.src = GAPI_SRC;
    script.async = true;
    script.onload = loadModule;
    script.onerror = () => reject(new Error(msg("connector_import.pick_error")));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    // Let the next click retry instead of replaying a failed load forever.
    loading = null;
    throw err;
  });
  return loading;
}

/** Open the Picker as the linked account; resolves with the picked files, empty when cancelled. */
export async function pickGoogleFiles(
  provider: ConnectorProvider,
  config: { access_token: string; developer_key: string; app_id: string },
): Promise<PickedFile[]> {
  const picker = await loadPicker();
  const view =
    provider === "google_sheets"
      ? new picker.DocsView(picker.ViewId.SPREADSHEETS)
      : new picker.DocsView(picker.ViewId.DOCS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(false);
  return new Promise<PickedFile[]>((resolve) => {
    new picker.PickerBuilder()
      .setAppId(config.app_id)
      .setOAuthToken(config.access_token)
      .setDeveloperKey(config.developer_key)
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve((data.docs ?? []).map((d) => ({ id: d.id, name: d.name ?? d.id })));
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build()
      .setVisible(true);
  });
}
