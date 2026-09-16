# AutoResearch program

`program.md` is the unmodified agent brief from
https://github.com/karpathy/autoresearch at revision
`228791fb499afffb54b46200aca536f79142f117`. The upstream repository declares the
MIT License in its README without shipping a separate license file.

`native_engines.py` derives the sandbox brief from this file at run time through
exact-snippet substitutions that only swap the nanochat specifics (`train.py`,
`val_bpb`, VRAM, the 5-minute GPU budget) for the evaluator the run actually
scores with. Bumping the pinned revision must keep the checksum test in
`tests/test_native_engines.py` and the substitution table in sync.
