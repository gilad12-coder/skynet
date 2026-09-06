"""Describe exact scorer package artifacts and their signed runtime identity."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ScorerWheel(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$")
    version: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9.!+_-]*$")
    filename: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._+!-]*\.whl$")
    url: str = Field(max_length=4096)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class ScorerDependencyLock(BaseModel):
    code_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    requirements: list[str]
    inferred: list[str]
    imports: list[str]
    artifacts: list[ScorerWheel]
    python: str
    image: str
    registry_url: str
    signature: str = Field(pattern=r"^[a-f0-9]{64}$")
