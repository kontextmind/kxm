"""Central registration for the kxmd account.

The schema is the only registration store. Removing it drops that schema and
does not read or write a source checkout, a SQLite file, or an artifact.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import psycopg

from kxm_control.account import AccountRefused

ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
MAX_ARTIFACT_BYTES = 1_048_576


class RegistryDenied(AccountRefused):
    """Authorization or registration failure. Same code/message shape as an account refusal."""


@dataclass(frozen=True)
class Actor:
    subject: str
    kind: str
    platform_admin: bool = False


def install(connection: psycopg.Connection) -> None:
    statements = (
        "CREATE SCHEMA IF NOT EXISTS kxm_registry",
        """
        CREATE TABLE IF NOT EXISTS kxm_registry.tenants (
          id text PRIMARY KEY,
          kind text NOT NULL CHECK (kind IN ('personal', 'org')),
          name text NOT NULL CHECK (length(name) > 0),
          description text,
          slug text,
          created_by text NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kxm_registry.memberships (
          tenant_id text NOT NULL REFERENCES kxm_registry.tenants (id),
          subject text NOT NULL,
          actor text NOT NULL CHECK (actor IN ('user', 'runner')),
          role text NOT NULL CHECK (role IN ('owner', 'admin', 'standard')),
          PRIMARY KEY (tenant_id, subject, actor)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kxm_registry.projects (
          id text PRIMARY KEY,
          tenant_id text NOT NULL REFERENCES kxm_registry.tenants (id),
          name text NOT NULL CHECK (length(name) > 0)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kxm_registry.repositories (
          id text PRIMARY KEY,
          project_id text NOT NULL REFERENCES kxm_registry.projects (id),
          remote text NOT NULL CHECK (length(remote) > 0)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS kxm_registry.revisions (
          id text PRIMARY KEY,
          project_id text NOT NULL REFERENCES kxm_registry.projects (id),
          sha256 text NOT NULL,
          document text NOT NULL
        )
        """,
        "ALTER TABLE kxm_registry.tenants ADD COLUMN IF NOT EXISTS description text",
        "ALTER TABLE kxm_registry.tenants ADD COLUMN IF NOT EXISTS slug text",
        "CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_key ON kxm_registry.tenants (slug)",
    )
    for statement in statements:
        connection.execute(statement)
    connection.commit()


def remove_registration(connection: psycopg.Connection) -> None:
    connection.execute("DROP SCHEMA IF EXISTS kxm_registry CASCADE")
    connection.commit()


def canonical_document(document: Mapping[str, object]) -> str:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


IDENTIFIER = re.compile(r"^[a-z0-9]{1,5}$")
SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?$")


def validate_identifier(identifier: str) -> None:
    if not IDENTIFIER.fullmatch(identifier):
        raise RegistryDenied("tenant_identifier_invalid", "tenant identifier must be 1 to 5 lowercase letters or digits")


def validate_slug(slug: str) -> None:
    if not SLUG.fullmatch(slug) or len(slug) > 15:
        raise RegistryDenied("tenant_slug_invalid", "tenant slug must be 1 to 15 lowercase letters, digits, or hyphens")


def create_tenant(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    kind: str,
    name: str,
    identifier: str,
    slug: str,
    description: str | None = None,
) -> dict[str, str | None]:
    if actor.kind != "user":
        raise RegistryDenied("tenant_create_forbidden", "only a user can create a tenant")
    if kind not in ("personal", "org"):
        raise RegistryDenied("tenant_kind_invalid", "tenant kind must be personal or org")
    if not name:
        raise RegistryDenied("tenant_name_invalid", "tenant name is required")
    validate_identifier(identifier)
    validate_slug(slug)
    try:
        connection.execute(
            """
            INSERT INTO kxm_registry.tenants (id, kind, name, description, slug, created_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (identifier, kind, name, description or None, slug, actor.subject),
        )
    except psycopg.errors.UniqueViolation as error:
        connection.rollback()
        constraint = error.diag.constraint_name or ""
        if "slug" in constraint:
            raise RegistryDenied("tenant_slug_taken", "tenant slug is already used") from error
        raise RegistryDenied("tenant_identifier_taken", "tenant identifier is already used") from error
    connection.execute(
        """
        INSERT INTO kxm_registry.memberships (tenant_id, subject, actor, role)
        VALUES (%s, %s, %s, 'owner')
        """,
        (identifier, actor.subject, actor.kind),
    )
    connection.commit()
    return {
        "tenantId": identifier,
        "identifier": identifier,
        "slug": slug,
        "kind": kind,
        "name": name,
        "description": description or None,
    }


def update_tenant(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    name: str | None = None,
    slug: str | None = None,
    description: str | None = None,
    identifier: str | None = None,
) -> dict[str, str | None]:
    caller_role = _membership_role(connection, tenant_id, actor)
    if caller_role not in ("owner", "admin"):
        raise RegistryDenied("tenant_update_forbidden", "only an owner or admin can rename a tenant")
    if identifier is not None and identifier != tenant_id:
        raise RegistryDenied("tenant_identifier_immutable", "tenant identifier cannot change")
    if slug is not None:
        validate_slug(slug)
    if name is not None and not name:
        raise RegistryDenied("tenant_name_invalid", "tenant name is required")
    row = connection.execute(
        "SELECT name, description, slug, kind FROM kxm_registry.tenants WHERE id = %s",
        (tenant_id,),
    ).fetchone()
    if row is None:
        raise RegistryDenied("tenant_membership_missing", "caller is not a member of this tenant")
    next_name = name if name is not None else row[0]
    next_description = description if description is not None else row[1]
    next_slug = slug if slug is not None else row[2]
    try:
        connection.execute(
            "UPDATE kxm_registry.tenants SET name = %s, description = %s, slug = %s WHERE id = %s",
            (next_name, next_description, next_slug, tenant_id),
        )
    except psycopg.errors.UniqueViolation as error:
        connection.rollback()
        raise RegistryDenied("tenant_slug_taken", "tenant slug is already used") from error
    connection.commit()
    return {
        "tenantId": tenant_id,
        "identifier": tenant_id,
        "slug": next_slug,
        "kind": row[3],
        "name": next_name,
        "description": next_description,
    }


def add_membership(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    subject: str,
    member_actor: str,
    role: str,
) -> dict[str, str]:
    caller_role = _membership_role(connection, tenant_id, actor)
    if caller_role not in ("owner", "admin"):
        raise RegistryDenied("membership_role_forbidden", "only an owner or admin can add a membership")
    if member_actor not in ("user", "runner") or role not in ("owner", "admin", "standard"):
        raise RegistryDenied("membership_invalid", "membership actor or role is not allowed")
    if not subject:
        raise RegistryDenied("membership_invalid", "membership subject is required")
    connection.execute(
        """
        INSERT INTO kxm_registry.memberships (tenant_id, subject, actor, role)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (tenant_id, subject, actor) DO UPDATE SET role = EXCLUDED.role
        """,
        (tenant_id, subject, member_actor, role),
    )
    connection.commit()
    return {"tenantId": tenant_id, "subject": subject, "actor": member_actor, "role": role}


def create_project(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    name: str,
) -> dict[str, str]:
    _membership_role(connection, tenant_id, actor)
    if not name:
        raise RegistryDenied("project_name_invalid", "project name is required")
    project_id = uuid.uuid4().hex
    connection.execute(
        "INSERT INTO kxm_registry.projects (id, tenant_id, name) VALUES (%s, %s, %s)",
        (project_id, tenant_id, name),
    )
    connection.commit()
    return {"projectId": project_id, "tenantId": tenant_id, "name": name}


def map_repository(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    project_id: str,
    remote: str,
) -> dict[str, str]:
    _membership_role(connection, tenant_id, actor)
    _project_in_tenant(connection, tenant_id, project_id)
    if not remote:
        raise RegistryDenied("repository_remote_invalid", "repository remote is required")
    repository_id = uuid.uuid4().hex
    connection.execute(
        "INSERT INTO kxm_registry.repositories (id, project_id, remote) VALUES (%s, %s, %s)",
        (repository_id, project_id, remote),
    )
    connection.commit()
    return {"repositoryId": repository_id, "projectId": project_id, "remote": remote}


def publish_revision(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    project_id: str,
    document: Mapping[str, object],
) -> dict[str, str]:
    _membership_role(connection, tenant_id, actor)
    _project_in_tenant(connection, tenant_id, project_id)
    canonical = canonical_document(document)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    revision_id = uuid.uuid4().hex
    connection.execute(
        """
        INSERT INTO kxm_registry.revisions (id, project_id, sha256, document)
        VALUES (%s, %s, %s, %s)
        """,
        (revision_id, project_id, digest, canonical),
    )
    connection.commit()
    return {"revisionId": revision_id, "sha256": digest, "canonical": canonical}


def read_revision(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    project_id: str,
    revision_id: str,
) -> dict[str, str]:
    _membership_role(connection, tenant_id, actor)
    _project_in_tenant(connection, tenant_id, project_id)
    row = connection.execute(
        """
        SELECT sha256, document
        FROM kxm_registry.revisions
        WHERE id = %s AND project_id = %s
        """,
        (revision_id, project_id),
    ).fetchone()
    if row is None:
        raise RegistryDenied("revision_not_found", "revision is not in this project")
    return {"revisionId": revision_id, "sha256": row[0], "canonical": row[1]}


def put_artifact(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    name: str,
    content_base64: str,
    root: Path,
) -> dict[str, str | int]:
    _membership_role(connection, tenant_id, actor)
    path = _artifact_path(root, tenant_id, name)
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except ValueError as error:
        raise RegistryDenied("artifact_invalid", "artifact content is not base64") from error
    if len(raw) > MAX_ARTIFACT_BYTES:
        raise RegistryDenied("artifact_too_large", "artifact is larger than 1 MiB")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return {
        "name": name,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
    }


def read_artifact(
    connection: psycopg.Connection,
    *,
    actor: Actor,
    tenant_id: str,
    name: str,
    root: Path,
) -> dict[str, str]:
    _membership_role(connection, tenant_id, actor)
    path = _artifact_path(root, tenant_id, name)
    if not path.is_file():
        raise RegistryDenied("artifact_not_found", "artifact is not in this tenant")
    raw = path.read_bytes()
    return {
        "name": name,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "contentBase64": base64.b64encode(raw).decode("ascii"),
    }


def _membership_role(connection: psycopg.Connection, tenant_id: str, actor: Actor) -> str:
    row = connection.execute(
        """
        SELECT role FROM kxm_registry.memberships
        WHERE tenant_id = %s AND subject = %s AND actor = %s
        """,
        (tenant_id, actor.subject, actor.kind),
    ).fetchone()
    if row is None:
        raise RegistryDenied("tenant_membership_missing", "caller is not a member of this tenant")
    return str(row[0])


def _project_in_tenant(connection: psycopg.Connection, tenant_id: str, project_id: str) -> None:
    row = connection.execute(
        "SELECT id FROM kxm_registry.projects WHERE id = %s AND tenant_id = %s",
        (project_id, tenant_id),
    ).fetchone()
    if row is None:
        raise RegistryDenied("project_not_found", "project is not in this tenant")


def _artifact_path(root: Path, tenant_id: str, name: str) -> Path:
    if not ARTIFACT_NAME.fullmatch(name) or name in (".", ".."):
        raise RegistryDenied("artifact_name_invalid", "artifact name is not a single path segment")
    if not IDENTIFIER.fullmatch(tenant_id):
        raise RegistryDenied("tenant_membership_missing", "caller is not a member of this tenant")
    base = root.resolve()
    path = (base / tenant_id / name).resolve()
    if not path.is_relative_to(base):
        raise RegistryDenied("artifact_name_invalid", "artifact path leaves the tenant store")
    return path
