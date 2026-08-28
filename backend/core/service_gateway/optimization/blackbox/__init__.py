"""Black-box text optimization: any text artifact + a scorer, no DSPy program.

Modules: :mod:`protocol` (task / eval server / engine contract),
:mod:`scorer` (python and remote scorer adapters), :mod:`gepa_engine` and
:mod:`best_of_n` (in-process engines), :mod:`registry` (engine catalog,
including the not-yet-available agent engines), :mod:`auto` (the Auto
explore → continue strategy) and :mod:`service` (job entry points used by
the worker subprocess and the submissions router).

Deliberately slim: :mod:`core.service_gateway.safe_exec` imports
:mod:`scorer` from here, and :mod:`service` imports ``safe_exec`` back, so
nothing heavier than the docstring may live in this package init.
"""
