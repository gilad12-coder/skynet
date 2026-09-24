"use client";

import * as React from "react";
import {
  Aws,
  Azure,
  Github,
  Google,
  GoogleCloud,
  HuggingFace,
  Langfuse,
  LangSmith,
  Microsoft,
  Notion,
  Snowflake,
} from "@lobehub/icons";
import { Brain, Database, Table, Trophy } from "@/shared/ui/icons";
import {
  removeConnector,
  removeHuggingFaceConnector,
  saveConnectorCredentials,
  saveHuggingFaceToken,
  startConnectorOAuth,
  startHuggingFaceOAuth,
  type ConnectorListResponse,
  type ConnectorProvider,
} from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";

/** One input of a provider's pasted-credentials form. */
export interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
  /** Rendered as a password input (or a masked textarea) and never echoed back. */
  secret?: boolean;
  /** Multi-line paste target: service-account keys, connection strings. */
  multiline?: boolean;
  required?: boolean;
}

/** Section a provider is listed under, in menus and on the Connectors tab. */
export type ProviderCategory = "hubs" | "files" | "docs" | "databases" | "traces";

/** Everything the UI needs to draw and drive one connector. */
export interface ProviderMeta {
  id: ConnectorProvider;
  category: ProviderCategory;
  name: string;
  blurb: string;
  /** Round brand mark for cards and dialog headers. */
  Avatar: React.ComponentType<{ size: number }>;
  /** Flat brand mark for menu rows. */
  Mark: React.ComponentType<{ size: number }>;
  /** Label of the OAuth button; absent for providers that only take credentials. */
  oauthButton?: string;
  credentialsHelp: string;
  helpUrl?: string;
  helpUrlLabel?: string;
  fields: CredentialField[];
  reconnectHint: string;
  toastConnected: string;
  toastDisconnected: string;
  startOAuth: () => Promise<{ authorize_url: string }>;
  saveCredentials: (fields: Record<string, string>) => Promise<ConnectorListResponse>;
  remove: () => Promise<ConnectorListResponse>;
}

/** Display order of the sections, with the providers each one lists. */
export const PROVIDER_GROUPS: Array<{
  category: ProviderCategory;
  providers: ConnectorProvider[];
}> = [
  { category: "hubs", providers: ["huggingface", "kaggle"] },
  {
    category: "files",
    providers: ["google_drive", "onedrive", "github", "s3", "gcs", "azure_blob"],
  },
  { category: "docs", providers: ["google_sheets", "notion"] },
  { category: "databases", providers: ["postgres", "mysql", "bigquery", "snowflake"] },
  { category: "traces", providers: ["langfuse", "langsmith", "braintrust"] },
];

/** Every provider, in display order. */
export const ALL_PROVIDERS: ConnectorProvider[] = PROVIDER_GROUPS.flatMap((g) => g.providers);

/** Providers that browse through the generic import dialog (Hugging Face has its own). */
export const BROWSE_PROVIDERS: ConnectorProvider[] = ALL_PROVIDERS.filter(
  (id) => id !== "huggingface",
);

/** Translated heading of one section. */
export function categoryLabel(category: ProviderCategory): string {
  return msg(`connectors.category.${category}`);
}

/** Brand-coloured disc around a Phosphor glyph, for services without a shipped logo. */
const glyphAvatar =
  (
    Glyph: React.ComponentType<{ size?: number | string; className?: string }>,
    background: string,
  ) =>
  ({ size }: { size: number }) => (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-white"
      style={{ width: size, height: size, background }}
    >
      <Glyph size={Math.round(size * 0.55)} />
    </span>
  );

/** Flat Phosphor glyph tinted in a brand colour, for menu rows. */
const glyphMark =
  (
    Glyph: React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>,
    color: string,
  ) =>
  ({ size }: { size: number }) => <Glyph size={size} style={{ color }} />;

/**
 * Google Sheets ships no logo in the icon set: a spreadsheet page with a folded corner and a
 * 2×2 grid. Drawn on a 16-unit grid with integer edges so it stays crisp at 16px.
 */
function GoogleSheetsGlyph({ size, page, grid }: { size: number; page: string; grid: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 1H9l4 4v8.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11A1.5 1.5 0 0 1 4.5 1Z"
        fill={page}
      />
      <path d="M9 1v4h4Z" fill={grid} fillOpacity={0.5} />
      <rect x="5" y="8" width="7" height="5" fill={grid} />
      <rect x="5" y="10" width="7" height="1" fill={page} />
      <rect x="8" y="8" width="1" height="5" fill={page} />
    </svg>
  );
}
const GOOGLE_SHEETS_GREEN = "#1E8E3E";
const GoogleSheetsAvatar = ({ size }: { size: number }) => (
  <span
    className="inline-flex shrink-0 items-center justify-center rounded-full"
    style={{ width: size, height: size, background: GOOGLE_SHEETS_GREEN }}
  >
    <GoogleSheetsGlyph size={Math.round(size * (4 / 7))} page="#fff" grid={GOOGLE_SHEETS_GREEN} />
  </span>
);
const GoogleSheetsMark = ({ size }: { size: number }) => (
  <GoogleSheetsGlyph size={size} page={GOOGLE_SHEETS_GREEN} grid="#fff" />
);

const KaggleAvatar = glyphAvatar(Trophy, "#20BEFF");
const KaggleMark = glyphMark(Trophy, "#20BEFF");
const PostgresAvatar = glyphAvatar(Database, "#336791");
const PostgresMark = glyphMark(Database, "#336791");
const MySqlAvatar = glyphAvatar(Database, "#00758F");
const MySqlMark = glyphMark(Database, "#00758F");
const BigQueryAvatar = glyphAvatar(Table, "#4285F4");
const BigQueryMark = glyphMark(Table, "#4285F4");
const BraintrustAvatar = glyphAvatar(Brain, "#1F1F1F");
const BraintrustMark = glyphMark(Brain, "#1F1F1F");

const generic = (
  id: Exclude<ConnectorProvider, "huggingface">,
  category: ProviderCategory,
  name: string,
) => ({
  id,
  category,
  name,
  reconnectHint: formatMsg("connectors.reconnect_hint", { provider: name }),
  toastConnected: formatMsg("connectors.toast.provider_connected", { provider: name }),
  toastDisconnected: formatMsg("connectors.toast.provider_disconnected", { provider: name }),
  startOAuth: () => startConnectorOAuth(id),
  saveCredentials: (fields: Record<string, string>) => saveConnectorCredentials(id, fields),
  remove: () => removeConnector(id),
});

const secretField = (key: string, label: string, placeholder?: string): CredentialField => ({
  key,
  label,
  placeholder,
  secret: true,
  required: true,
});

const serviceAccountField = (): CredentialField => ({
  key: "service_account_json",
  label: msg("connectors.field.service_account_json"),
  placeholder: msg("connectors.field.service_account_json_placeholder"),
  secret: true,
  multiline: true,
  required: true,
});

/**
 * Resolve the metadata of one provider. Called during render so the strings
 * follow the active locale.
 */
export function providerMeta(id: ConnectorProvider): ProviderMeta {
  switch (id) {
    case "huggingface":
      return {
        id,
        category: "hubs",
        name: msg("connectors.hf.name"),
        blurb: msg("connectors.hf.blurb"),
        Avatar: HuggingFace.Avatar,
        Mark: HuggingFace.Color,
        oauthButton: msg("connectors.hf.oauth_button"),
        credentialsHelp: msg("connectors.hf.token_help"),
        helpUrl: "https://huggingface.co/settings/tokens",
        helpUrlLabel: "huggingface.co/settings/tokens",
        fields: [
          {
            key: "token",
            label: msg("connectors.hf.token_label"),
            placeholder: msg("connectors.hf.token_placeholder"),
            secret: true,
            required: true,
          },
        ],
        reconnectHint: msg("connectors.hf.reconnect_hint"),
        toastConnected: msg("connectors.toast.connected"),
        toastDisconnected: msg("connectors.toast.disconnected"),
        startOAuth: startHuggingFaceOAuth,
        saveCredentials: (fields) => saveHuggingFaceToken(fields.token ?? ""),
        remove: removeHuggingFaceConnector,
      };
    case "google_sheets":
      return {
        ...generic(id, "docs", msg("connectors.google_sheets.name")),
        blurb: msg("connectors.google_sheets.blurb"),
        Avatar: GoogleSheetsAvatar,
        Mark: GoogleSheetsMark,
        oauthButton: msg("connectors.google_sheets.oauth_button"),
        credentialsHelp: msg("connectors.google_sheets.credentials_help"),
        fields: [serviceAccountField()],
      };
    case "github":
      return {
        ...generic(id, "files", msg("connectors.github.name")),
        blurb: msg("connectors.github.blurb"),
        Avatar: Github.Avatar,
        Mark: Github,
        oauthButton: msg("connectors.github.oauth_button"),
        credentialsHelp: msg("connectors.github.credentials_help"),
        helpUrl: "https://github.com/settings/tokens",
        helpUrlLabel: "github.com/settings/tokens",
        fields: [
          {
            key: "token",
            label: msg("connectors.field.token"),
            placeholder: msg("connectors.field.token_placeholder"),
            secret: true,
            required: true,
          },
        ],
      };
    case "s3":
      return {
        ...generic(id, "files", msg("connectors.s3.name")),
        blurb: msg("connectors.s3.blurb"),
        Avatar: Aws.Avatar,
        Mark: Aws.Color,
        credentialsHelp: msg("connectors.s3.credentials_help"),
        fields: [
          {
            key: "access_key_id",
            label: msg("connectors.field.access_key_id"),
            placeholder: msg("connectors.field.access_key_id_placeholder"),
            required: true,
          },
          {
            key: "secret_access_key",
            label: msg("connectors.field.secret_access_key"),
            secret: true,
            required: true,
          },
          {
            key: "region",
            label: msg("connectors.field.region"),
            placeholder: msg("connectors.field.region_placeholder"),
          },
          {
            key: "endpoint_url",
            label: msg("connectors.field.endpoint_url"),
            placeholder: msg("connectors.field.endpoint_url_placeholder"),
          },
          { key: "bucket", label: msg("connectors.field.bucket") },
        ],
      };
    case "gcs":
      return {
        ...generic(id, "files", msg("connectors.gcs.name")),
        blurb: msg("connectors.gcs.blurb"),
        Avatar: GoogleCloud.Avatar,
        Mark: GoogleCloud.Color,
        credentialsHelp: msg("connectors.gcs.credentials_help"),
        fields: [serviceAccountField(), { key: "bucket", label: msg("connectors.field.bucket") }],
      };
    case "azure_blob":
      return {
        ...generic(id, "files", msg("connectors.azure_blob.name")),
        blurb: msg("connectors.azure_blob.blurb"),
        Avatar: Azure.Avatar,
        Mark: Azure.Color,
        credentialsHelp: msg("connectors.azure_blob.credentials_help"),
        fields: [
          {
            key: "connection",
            label: msg("connectors.field.connection"),
            placeholder: msg("connectors.field.connection_placeholder"),
            secret: true,
            multiline: true,
            required: true,
          },
          { key: "container", label: msg("connectors.field.container") },
        ],
      };
    case "kaggle":
      return {
        ...generic(id, "hubs", msg("connectors.kaggle.name")),
        blurb: msg("connectors.kaggle.blurb"),
        Avatar: KaggleAvatar,
        Mark: KaggleMark,
        credentialsHelp: msg("connectors.kaggle.credentials_help"),
        helpUrl: "https://www.kaggle.com/settings",
        helpUrlLabel: "kaggle.com/settings",
        fields: [
          { key: "username", label: msg("connectors.field.username"), required: true },
          secretField("key", msg("connectors.field.key")),
        ],
      };
    case "google_drive":
      return {
        ...generic(id, "files", msg("connectors.google_drive.name")),
        blurb: msg("connectors.google_drive.blurb"),
        Avatar: Google.Avatar,
        Mark: Google.Color,
        oauthButton: msg("connectors.google_drive.oauth_button"),
        credentialsHelp: msg("connectors.google_drive.credentials_help"),
        fields: [serviceAccountField()],
      };
    case "onedrive":
      return {
        ...generic(id, "files", msg("connectors.onedrive.name")),
        blurb: msg("connectors.onedrive.blurb"),
        Avatar: Microsoft.Avatar,
        Mark: Microsoft.Color,
        oauthButton: msg("connectors.onedrive.oauth_button"),
        credentialsHelp: "",
        fields: [],
      };
    case "notion":
      return {
        ...generic(id, "docs", msg("connectors.notion.name")),
        blurb: msg("connectors.notion.blurb"),
        Avatar: Notion.Avatar,
        Mark: Notion,
        credentialsHelp: msg("connectors.notion.credentials_help"),
        helpUrl: "https://www.notion.so/profile/integrations",
        helpUrlLabel: "notion.so/profile/integrations",
        fields: [
          secretField(
            "token",
            msg("connectors.field.notion_token"),
            msg("connectors.field.notion_token_placeholder"),
          ),
        ],
      };
    case "postgres":
      return {
        ...generic(id, "databases", msg("connectors.postgres.name")),
        blurb: msg("connectors.postgres.blurb"),
        Avatar: PostgresAvatar,
        Mark: PostgresMark,
        credentialsHelp: msg("connectors.postgres.credentials_help"),
        fields: [
          secretField(
            "url",
            msg("connectors.field.database_url"),
            msg("connectors.field.postgres_url_placeholder"),
          ),
        ],
      };
    case "mysql":
      return {
        ...generic(id, "databases", msg("connectors.mysql.name")),
        blurb: msg("connectors.mysql.blurb"),
        Avatar: MySqlAvatar,
        Mark: MySqlMark,
        credentialsHelp: msg("connectors.mysql.credentials_help"),
        fields: [
          secretField(
            "url",
            msg("connectors.field.database_url"),
            msg("connectors.field.mysql_url_placeholder"),
          ),
        ],
      };
    case "bigquery":
      return {
        ...generic(id, "databases", msg("connectors.bigquery.name")),
        blurb: msg("connectors.bigquery.blurb"),
        Avatar: BigQueryAvatar,
        Mark: BigQueryMark,
        credentialsHelp: msg("connectors.bigquery.credentials_help"),
        fields: [
          serviceAccountField(),
          {
            key: "project",
            label: msg("connectors.field.project"),
            placeholder: msg("connectors.field.project_placeholder"),
          },
        ],
      };
    case "snowflake":
      return {
        ...generic(id, "databases", msg("connectors.snowflake.name")),
        blurb: msg("connectors.snowflake.blurb"),
        Avatar: Snowflake.Avatar,
        Mark: Snowflake.Color,
        credentialsHelp: msg("connectors.snowflake.credentials_help"),
        fields: [
          {
            key: "account",
            label: msg("connectors.field.account"),
            placeholder: msg("connectors.field.account_placeholder"),
            required: true,
          },
          secretField("token", msg("connectors.field.pat")),
          { key: "warehouse", label: msg("connectors.field.warehouse"), required: true },
          { key: "role", label: msg("connectors.field.role") },
        ],
      };
    case "langfuse":
      return {
        ...generic(id, "traces", msg("connectors.langfuse.name")),
        blurb: msg("connectors.langfuse.blurb"),
        Avatar: Langfuse.Avatar,
        Mark: Langfuse.Color,
        credentialsHelp: msg("connectors.langfuse.credentials_help"),
        fields: [
          {
            key: "public_key",
            label: msg("connectors.field.public_key"),
            placeholder: msg("connectors.field.public_key_placeholder"),
            required: true,
          },
          secretField(
            "secret_key",
            msg("connectors.field.secret_key"),
            msg("connectors.field.secret_key_placeholder"),
          ),
          {
            key: "host",
            label: msg("connectors.field.host"),
            placeholder: msg("connectors.field.host_placeholder"),
          },
        ],
      };
    case "langsmith":
      return {
        ...generic(id, "traces", msg("connectors.langsmith.name")),
        blurb: msg("connectors.langsmith.blurb"),
        Avatar: LangSmith.Avatar,
        Mark: LangSmith.Color,
        credentialsHelp: msg("connectors.langsmith.credentials_help"),
        helpUrl: "https://smith.langchain.com/settings",
        helpUrlLabel: "smith.langchain.com/settings",
        fields: [
          secretField(
            "api_key",
            msg("connectors.field.api_key"),
            msg("connectors.field.langsmith_key_placeholder"),
          ),
          {
            key: "endpoint",
            label: msg("connectors.field.endpoint"),
            placeholder: msg("connectors.field.endpoint_placeholder"),
          },
        ],
      };
    case "braintrust":
      return {
        ...generic(id, "traces", msg("connectors.braintrust.name")),
        blurb: msg("connectors.braintrust.blurb"),
        Avatar: BraintrustAvatar,
        Mark: BraintrustMark,
        credentialsHelp: msg("connectors.braintrust.credentials_help"),
        helpUrl: "https://www.braintrust.dev/app/settings?subroute=api-keys",
        helpUrlLabel: "braintrust.dev/app/settings",
        fields: [
          secretField(
            "api_key",
            msg("connectors.field.api_key"),
            msg("connectors.field.braintrust_key_placeholder"),
          ),
        ],
      };
  }
}
