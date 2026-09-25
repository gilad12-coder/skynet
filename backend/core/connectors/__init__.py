"""Linked third-party data accounts ("connectors") and their importers.

A connector is a user's own account on an outside service, stored encrypted so
imports run with that user's permissions. Providers: Hugging Face
(:mod:`core.connectors.huggingface`, the original with its own OAuth flow),
Google Sheets, GitHub, Amazon S3, Google Cloud Storage and Azure Blob Storage
(all registered in :mod:`core.connectors.registry` behind one browse/preview/
import contract). The vault in :mod:`core.connectors.vault` is
provider-agnostic.
"""
