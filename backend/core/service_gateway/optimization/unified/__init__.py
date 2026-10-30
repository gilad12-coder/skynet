"""Unified (wizard v2) optimization: one payload for every optimizer.

Modules: :mod:`split` (the server-side held-out split), :mod:`dspy_engine`
(DSPy optimizers behind the black-box engine protocol) and :mod:`service`
(the worker entry point). Kept slim so importing one module does not pull in
the others.
"""
