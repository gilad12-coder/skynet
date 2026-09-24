"""Linked third-party data accounts ("connectors") and their importers.

A connector is a user's own account on an outside service, stored encrypted so
imports run with that user's permissions. Today the only provider is Hugging
Face (:mod:`core.connectors.huggingface`); the vault in
:mod:`core.connectors.vault` is provider-agnostic.
"""
