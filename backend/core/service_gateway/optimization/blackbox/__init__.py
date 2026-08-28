"""Black-box text optimization: any text artifact + a scorer, no DSPy program.

Modules: :mod:`protocol` (task / eval server / engine contract),
:mod:`scorer` (python and remote scorer adapters), :mod:`gepa_engine`,
:mod:`best_of_n` and :mod:`meta_harness` (in-process engines),
:mod:`registry` (engine catalog and capability-based availability),
:mod:`auto` (the Auto explore → continue strategy) and :mod:`service` (job
entry points used by the worker subprocess and the submissions router).

Agent targets — versions that are a coding agent's harness — add
:mod:`harness` (how each agent is installed, routed and run),
:mod:`sandbox` (one throwaway Vercel Sandbox per scorer run) and
:mod:`agent_eval` (the scorer wrapper that runs the agent and hands the
run record to the user's scorer).

Deliberately slim: :mod:`core.service_gateway.safe_exec` imports
:mod:`scorer` from here, and :mod:`service` imports ``safe_exec`` back, so
nothing heavier than the docstring may live in this package init.
"""
