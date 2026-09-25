"use client";

import type * as React from "react";
import { Aws, Azure, Github, Google, GoogleCloud, HuggingFace } from "@lobehub/icons";
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

/** Everything the UI needs to draw and drive one connector. */
export interface ProviderMeta {
  id: ConnectorProvider;
  name: string;
  blurb: string;
  /** Round brand mark for cards and dialog headers. */
  Avatar: React.ComponentType<{ size: number }>;
  /** Flat brand mark for menu rows. */
  Mark: React.ComponentType<{ size: number }>;
  /** Label of the OAuth button; absent for providers that only take credentials. */
  oauthButton?: string;
  credentialsToggle: string;
  credentialsHelp: string;
  helpUrl?: string;
  helpUrlLabel?: string;
  fields: CredentialField[];
  viaOAuth: string;
  reconnectHint: string;
  toastConnected: string;
  toastDisconnected: string;
  startOAuth: () => Promise<{ authorize_url: string }>;
  saveCredentials: (fields: Record<string, string>) => Promise<ConnectorListResponse>;
  remove: () => Promise<ConnectorListResponse>;
}

/** Providers that browse through the generic import dialog (Hugging Face has its own). */
export const BROWSE_PROVIDERS: ConnectorProvider[] = [
  "google_sheets",
  "github",
  "s3",
  "gcs",
  "azure_blob",
];

/** Display order on the Connectors tab. */
export const ALL_PROVIDERS: ConnectorProvider[] = ["huggingface", ...BROWSE_PROVIDERS];

const generic = (id: Exclude<ConnectorProvider, "huggingface">, name: string) => ({
  id,
  name,
  viaOAuth: formatMsg("connectors.via_oauth", { provider: name }),
  reconnectHint: formatMsg("connectors.reconnect_hint", { provider: name }),
  toastConnected: formatMsg("connectors.toast.provider_connected", { provider: name }),
  toastDisconnected: formatMsg("connectors.toast.provider_disconnected", { provider: name }),
  startOAuth: () => startConnectorOAuth(id),
  saveCredentials: (fields: Record<string, string>) => saveConnectorCredentials(id, fields),
  remove: () => removeConnector(id),
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
        name: msg("connectors.hf.name"),
        blurb: msg("connectors.hf.blurb"),
        Avatar: HuggingFace.Avatar,
        Mark: HuggingFace.Color,
        oauthButton: msg("connectors.hf.oauth_button"),
        credentialsToggle: msg("connectors.hf.token_toggle"),
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
        viaOAuth: msg("connectors.hf.via_oauth"),
        reconnectHint: msg("connectors.hf.reconnect_hint"),
        toastConnected: msg("connectors.toast.connected"),
        toastDisconnected: msg("connectors.toast.disconnected"),
        startOAuth: startHuggingFaceOAuth,
        saveCredentials: (fields) => saveHuggingFaceToken(fields.token ?? ""),
        remove: removeHuggingFaceConnector,
      };
    case "google_sheets":
      return {
        ...generic(id, msg("connectors.google_sheets.name")),
        blurb: msg("connectors.google_sheets.blurb"),
        Avatar: Google.Avatar,
        Mark: Google.Color,
        oauthButton: msg("connectors.google_sheets.oauth_button"),
        credentialsToggle: msg("connectors.google_sheets.credentials_toggle"),
        credentialsHelp: msg("connectors.google_sheets.credentials_help"),
        fields: [serviceAccountField()],
      };
    case "github":
      return {
        ...generic(id, msg("connectors.github.name")),
        blurb: msg("connectors.github.blurb"),
        Avatar: Github.Avatar,
        Mark: Github,
        oauthButton: msg("connectors.github.oauth_button"),
        credentialsToggle: msg("connectors.github.credentials_toggle"),
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
        ...generic(id, msg("connectors.s3.name")),
        blurb: msg("connectors.s3.blurb"),
        Avatar: Aws.Avatar,
        Mark: Aws.Color,
        credentialsToggle: msg("connectors.s3.credentials_toggle"),
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
        ...generic(id, msg("connectors.gcs.name")),
        blurb: msg("connectors.gcs.blurb"),
        Avatar: GoogleCloud.Avatar,
        Mark: GoogleCloud.Color,
        credentialsToggle: msg("connectors.gcs.credentials_toggle"),
        credentialsHelp: msg("connectors.gcs.credentials_help"),
        fields: [serviceAccountField(), { key: "bucket", label: msg("connectors.field.bucket") }],
      };
    case "azure_blob":
      return {
        ...generic(id, msg("connectors.azure_blob.name")),
        blurb: msg("connectors.azure_blob.blurb"),
        Avatar: Azure.Avatar,
        Mark: Azure.Color,
        credentialsToggle: msg("connectors.azure_blob.credentials_toggle"),
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
  }
}
