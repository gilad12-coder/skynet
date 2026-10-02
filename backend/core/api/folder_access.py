"""Access-control foundation for run folders, modelled on Google Drive.

Folders reuse the optimization sharing vocabulary (:class:`ShareRole`, the
``GENERAL_ACCESS_*`` policies, ``MEMBER_ROLES`` / ``LINK_ROLES`` and the
``LINK_GRANT_MARKER`` sentinel) and add Drive's inheritance rules:

* Access granted on a folder reaches every subfolder and run beneath it,
  including items added later. Moving an item out drops what it inherited.
* The effective role is the best of every applicable access: grants on the
  folder itself, grants on any ancestor, and ownership.
* The owner of a folder (or of any ancestor) acts as an ``editor`` on the runs
  filed inside, never as their owner: deleting a run or managing its own
  sharing stays with the run's creator, as Drive keeps file ownership apart
  from folder ownership.

On a folder the tiers read as:

* ``viewer`` — see the folder, its subfolders and its runs.
* ``editor`` — viewer + rename, create subfolders, file runs in or out, and
  share when the owner leaves ``editors_can_share`` on.
* ``owner`` — editor + delete, move, transfer, and the ``editors_can_share``
  switch.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..storage.models import (
    RunFolderItemModel,
    RunFolderModel,
    RunFolderShareGrantModel,
    RunFolderShareLinkModel,
)
from .auth import AuthenticatedUser, is_admin
from .errors import DomainError
from .sharing_access import (
    GENERAL_ACCESS_ANYONE,
    LINK_ROLES,
    MEMBER_ROLES,
    ShareRole,
    _normalize_username,
    role_rank,
)

# Guards the ancestor walk against a corrupt parent cycle; real trees are far
# shallower.
MAX_FOLDER_DEPTH = 32


def get_folder(session: Session, folder_id: str) -> RunFolderModel | None:
    """Return a folder row by id.

    Args:
        session: Open DB session.
        folder_id: Folder to load.

    Returns:
        The :class:`RunFolderModel`, or ``None`` when it does not exist.
    """
    return session.get(RunFolderModel, folder_id)


def folder_chain(session: Session, folder_id: str) -> list[RunFolderModel]:
    """Return a folder followed by each of its ancestors up to the root.

    Args:
        session: Open DB session.
        folder_id: Folder to start from.

    Returns:
        ``[folder, parent, grandparent, ...]``; empty when the folder is unknown.
    """
    chain: list[RunFolderModel] = []
    seen: set[str] = set()
    current = get_folder(session, folder_id)
    while current is not None and current.id not in seen and len(chain) < MAX_FOLDER_DEPTH:
        chain.append(current)
        seen.add(current.id)
        current = get_folder(session, current.parent_id) if current.parent_id else None
    return chain


def get_active_link(session: Session, folder_id: str) -> RunFolderShareLinkModel | None:
    """Return the folder's live (non-revoked) sharing row, if any.

    Args:
        session: Open DB session.
        folder_id: Folder to look up.

    Returns:
        The active :class:`RunFolderShareLinkModel`, or ``None``.
    """
    return session.scalars(
        select(RunFolderShareLinkModel).where(
            RunFolderShareLinkModel.folder_id == folder_id,
            RunFolderShareLinkModel.revoked_at.is_(None),
        )
    ).first()


def get_link_by_token(session: Session, token: str) -> RunFolderShareLinkModel | None:
    """Return the active sharing row for a public ``token``, if any.

    Args:
        session: Open DB session.
        token: The public share token from the URL.

    Returns:
        The active :class:`RunFolderShareLinkModel`, or ``None`` when the token
        is unknown or revoked.
    """
    return session.scalars(
        select(RunFolderShareLinkModel).where(
            RunFolderShareLinkModel.token == token,
            RunFolderShareLinkModel.revoked_at.is_(None),
        )
    ).first()


def list_grants(session: Session, folder_id: str) -> list[RunFolderShareGrantModel]:
    """Return every member grant on one folder, ordered by grantee.

    Args:
        session: Open DB session.
        folder_id: Folder whose grants are listed.

    Returns:
        The folder's :class:`RunFolderShareGrantModel` rows.
    """
    return list(
        session.scalars(
            select(RunFolderShareGrantModel)
            .where(RunFolderShareGrantModel.folder_id == folder_id)
            .order_by(RunFolderShareGrantModel.grantee_username)
        )
    )


def get_grant(session: Session, folder_id: str, username: str) -> RunFolderShareGrantModel | None:
    """Return a specific user's grant on a folder, if one exists.

    Args:
        session: Open DB session.
        folder_id: Folder to look up.
        username: Grantee username (compared case-insensitively).

    Returns:
        The matching :class:`RunFolderShareGrantModel`, or ``None``.
    """
    return session.get(
        RunFolderShareGrantModel,
        {"folder_id": folder_id, "grantee_username": _normalize_username(username)},
    )


def _role_on_chain(session: Session, chain: list[RunFolderModel], username: str) -> ShareRole | None:
    """Resolve the best role ``username`` holds anywhere on a folder chain.

    Args:
        session: Open DB session.
        chain: The folder followed by its ancestors (see :func:`folder_chain`).
        username: Normalized caller username.

    Returns:
        ``owner`` when the caller owns the folder itself, ``editor`` when they
        own an ancestor, otherwise the best member grant on the chain, or
        ``None`` when nothing applies.
    """
    if not chain:
        return None
    if _normalize_username(chain[0].owner_username) == username:
        return ShareRole.owner
    candidates: list[ShareRole] = []
    if any(_normalize_username(f.owner_username) == username for f in chain[1:]):
        candidates.append(ShareRole.editor)
    grants = session.scalars(
        select(RunFolderShareGrantModel.role).where(
            RunFolderShareGrantModel.folder_id.in_([f.id for f in chain]),
            RunFolderShareGrantModel.grantee_username == username,
        )
    )
    candidates.extend(ShareRole(role) for role in grants if role in MEMBER_ROLES)
    if not candidates:
        return None
    return max(candidates, key=role_rank)


def resolve_folder_role(session: Session, folder_id: str, user: AuthenticatedUser) -> ShareRole | None:
    """Resolve a logged-in caller's effective role on a folder.

    Args:
        session: Open DB session.
        folder_id: Folder to resolve access on.
        user: Authenticated caller.

    Returns:
        ``owner`` for the folder owner or an admin, the best inherited role
        otherwise, or ``None`` when the caller has no access.
    """
    chain = folder_chain(session, folder_id)
    if not chain:
        return None
    if is_admin(user):
        return ShareRole.owner
    return _role_on_chain(session, chain, _normalize_username(user.username))


def require_folder_role(
    session: Session, folder_id: str, user: AuthenticatedUser, minimum: ShareRole
) -> tuple[RunFolderModel, ShareRole]:
    """Load a folder, requiring the caller's role to meet ``minimum``.

    Args:
        session: Open DB session.
        folder_id: Folder to load.
        user: Authenticated caller.
        minimum: Lowest role permitted to proceed.

    Returns:
        ``(folder, role)``.

    Raises:
        DomainError: 404 ``folder.not_found`` when unknown or inaccessible; 403
            ``folder.forbidden`` when reachable but below ``minimum``.
    """
    role = resolve_folder_role(session, folder_id, user)
    folder = get_folder(session, folder_id)
    if role is None or folder is None:
        raise DomainError("folder.not_found", status=404)
    if role_rank(role) < role_rank(minimum):
        raise DomainError("folder.forbidden", status=403)
    return folder, role


def can_share(folder: RunFolderModel, role: ShareRole) -> bool:
    """Return whether a caller at ``role`` may change who has access.

    Args:
        folder: Folder being shared.
        role: Caller's effective role on it.

    Returns:
        True for the owner, or for an editor while ``editors_can_share`` is on.
    """
    if role == ShareRole.owner:
        return True
    return role == ShareRole.editor and bool(folder.editors_can_share)


def resolve_share_access(session: Session, token: str, user: AuthenticatedUser) -> ShareRole | None:
    """Resolve the role a caller gets by opening a folder share link.

    Args:
        session: Open DB session.
        token: The public share token from the URL.
        user: Authenticated caller.

    Returns:
        The best of the caller's own role and, under an ``anyone`` link, the
        link's tier; ``None`` when the token is invalid or nothing applies.
    """
    link = get_link_by_token(session, token)
    if link is None:
        return None
    candidates: list[ShareRole] = []
    resolved = resolve_folder_role(session, link.folder_id, user)
    if resolved is not None:
        candidates.append(resolved)
    if link.general_access == GENERAL_ACCESS_ANYONE and get_folder(session, link.folder_id) is not None:
        candidates.append(ShareRole(link.general_role if link.general_role in LINK_ROLES else ShareRole.viewer))
    if not candidates:
        return None
    return max(candidates, key=role_rank)


def run_folder_roles(session: Session, optimization_ids: Iterable[str], username: str) -> dict[str, str]:
    """Batch-resolve the role each run inherits from its folder.

    Folder ownership caps at ``editor`` on a run (see the module docstring).

    Args:
        session: Open DB session.
        optimization_ids: Runs to resolve.
        username: Caller username (compared case-insensitively).

    Returns:
        ``{optimization_id: role}`` for runs whose folder gives the caller access.
    """
    ids = list(optimization_ids)
    if not ids:
        return {}
    normalized = _normalize_username(username)
    items = session.execute(
        select(RunFolderItemModel.optimization_id, RunFolderItemModel.folder_id).where(
            RunFolderItemModel.optimization_id.in_(ids)
        )
    ).all()
    by_folder: dict[str, ShareRole | None] = {}
    roles: dict[str, str] = {}
    for optimization_id, folder_id in items:
        if folder_id not in by_folder:
            by_folder[folder_id] = _role_on_chain(session, folder_chain(session, folder_id), normalized)
        role = by_folder[folder_id]
        if role is None:
            continue
        roles[optimization_id] = str(ShareRole.editor if role == ShareRole.owner else role)
    return roles


def folder_of_run(session: Session, optimization_id: str) -> str | None:
    """Return the id of the folder a run is filed in, if any.

    Args:
        session: Open DB session.
        optimization_id: Run to look up.

    Returns:
        The folder id, or ``None`` when the run is unfiled.
    """
    item = session.get(RunFolderItemModel, optimization_id)
    return item.folder_id if item is not None else None


def folder_ids_for_runs(session: Session, optimization_ids: Iterable[str]) -> dict[str, str]:
    """Return the folder each run is filed in, for runs that are filed.

    Args:
        session: Open DB session.
        optimization_ids: Runs to look up.

    Returns:
        ``{optimization_id: folder_id}``.
    """
    ids = list(optimization_ids)
    if not ids:
        return {}
    rows = session.execute(
        select(RunFolderItemModel.optimization_id, RunFolderItemModel.folder_id).where(
            RunFolderItemModel.optimization_id.in_(ids)
        )
    ).all()
    return dict(rows)


def subtree_ids(session: Session, root_ids: Iterable[str]) -> set[str]:
    """Return the given folders plus every descendant folder.

    Args:
        session: Open DB session.
        root_ids: Folders to expand.

    Returns:
        The ids of the roots and all folders nested beneath them.
    """
    found: set[str] = set(root_ids)
    frontier = list(found)
    depth = 0
    while frontier and depth < MAX_FOLDER_DEPTH:
        children = session.scalars(select(RunFolderModel.id).where(RunFolderModel.parent_id.in_(frontier))).all()
        frontier = [c for c in children if c not in found]
        found.update(frontier)
        depth += 1
    return found
