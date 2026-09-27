"""Stripe-backed managed-credit billing.

Owns customers, credit-pack checkout, and webhook reconciliation. The rest of
the app reaches billing only through :class:`StripeBillingService`; nothing
else imports ``stripe``.
"""

from __future__ import annotations

from .byok_bridge import (
    byok_prefix_routable,
    inject_byok_connections,
    payload_uses_token_source,
    provider_slug_for_model,
    resolve_byok_model_config,
)
from .byok_vault import (
    ProviderKeyVault,
    ProviderKeyView,
    VaultSnapshot,
    byok_provider_for_litellm,
)
from .issuing_float import FundingResult, IssuingFundingSweeper, fund_issuing_once, start_issuing_funding_sweeper
from .openrouter_float import (
    FloatStatus,
    OpenRouterFloatSweeper,
    check_float,
    notify_low_float,
    read_account_balance_credits,
    start_openrouter_float_sweeper,
)
from .openrouter_keys import OpenRouterKeyProvisioner, inject_provisioned_openrouter_key
from .service import (
    FREE_GRANT_CREDITS,
    PACK_CREDITS,
    LedgerRow,
    StripeBillingService,
    WalletSnapshot,
    committed_spend_credits,
    cost_ceiling_budget,
)

__all__ = [
    "FREE_GRANT_CREDITS",
    "PACK_CREDITS",
    "FloatStatus",
    "FundingResult",
    "IssuingFundingSweeper",
    "LedgerRow",
    "OpenRouterFloatSweeper",
    "OpenRouterKeyProvisioner",
    "ProviderKeyVault",
    "ProviderKeyView",
    "StripeBillingService",
    "VaultSnapshot",
    "WalletSnapshot",
    "byok_prefix_routable",
    "byok_provider_for_litellm",
    "check_float",
    "committed_spend_credits",
    "cost_ceiling_budget",
    "fund_issuing_once",
    "inject_byok_connections",
    "inject_provisioned_openrouter_key",
    "notify_low_float",
    "payload_uses_token_source",
    "provider_slug_for_model",
    "read_account_balance_credits",
    "resolve_byok_model_config",
    "start_issuing_funding_sweeper",
    "start_openrouter_float_sweeper",
]
