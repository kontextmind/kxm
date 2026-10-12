"""HTTP surface for the kxmd account, tenants, and registration.

The process environment may point a tunnel at the loopback stores. A request
may not choose an account, database, namespace, host, or Temporal target.
A valid Authentik token still cannot read another tenant.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Literal

import psycopg
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from kxm_control.account import ACCOUNT, AccountRefused, assert_request_account
from kxm_control.auth import AuthentikVerifier, Login, LoginRejected
from kxm_control.registry import (
    Actor,
    RegistryDenied,
    add_membership,
    create_project,
    create_tenant,
    update_tenant,
    map_repository,
    publish_revision,
    put_artifact,
    read_artifact,
    read_revision,
    remove_registration,
)

NOT_FOUND = {"project_not_found", "revision_not_found", "artifact_not_found"}
Connect = Callable[[], psycopg.Connection]


class TargetFields(BaseModel):
    account: str | None = None
    database: str | None = None
    namespace: str | None = None
    host: str | None = None
    temporalTarget: str | None = None


class AccountView(BaseModel):
    account: str
    database: str
    namespace: str
    role: str


class Denied(BaseModel):
    code: str
    message: str


class TenantCreate(TargetFields):
    kind: Literal["personal", "org"]
    name: str = Field(min_length=1)
    identifier: str = Field(min_length=1, max_length=5)
    slug: str = Field(min_length=1, max_length=15)
    description: str | None = None


class TenantUpdate(TargetFields):
    name: str | None = None
    slug: str | None = Field(default=None, max_length=15)
    description: str | None = None
    identifier: str | None = Field(default=None, max_length=5)


class TenantView(BaseModel):
    tenantId: str
    identifier: str
    slug: str
    kind: str
    name: str
    description: str | None = None


class MembershipCreate(TargetFields):
    subject: str = Field(min_length=1)
    actor: Literal["user", "runner"]
    role: Literal["owner", "admin", "standard"]


class MembershipView(BaseModel):
    tenantId: str
    subject: str
    actor: str
    role: str


class ProjectCreate(TargetFields):
    name: str = Field(min_length=1)


class ProjectView(BaseModel):
    projectId: str
    tenantId: str
    name: str


class RepositoryCreate(TargetFields):
    remote: str = Field(min_length=1)


class RepositoryView(BaseModel):
    repositoryId: str
    projectId: str
    remote: str


class RevisionCreate(TargetFields):
    document: dict[str, object]


class RevisionView(BaseModel):
    revisionId: str
    sha256: str
    canonical: str


class ArtifactCreate(TargetFields):
    contentBase64: str


class ArtifactView(BaseModel):
    name: str
    sha256: str
    bytes: int | None = None
    contentBase64: str | None = None


def create_app(
    *,
    connect: Connect | None = None,
    verifier: AuthentikVerifier | None = None,
    artifact_root: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="kxm-control", version="0.0.0")
    app.state.connect = connect
    app.state.verifier = verifier
    app.state.artifact_root = artifact_root or Path(
        os.environ.get("KXM_KXMD_ARTIFACTS", "/var/lib/kxm/artifacts/kxmd")
    )

    @app.exception_handler(AccountRefused)
    async def refuse_account(_request: Request, error: AccountRefused) -> JSONResponse:
        status = 404 if isinstance(error, RegistryDenied) and error.code in NOT_FOUND else 403
        return JSONResponse(status_code=status, content={"code": error.code, "message": str(error)})

    @app.exception_handler(LoginRejected)
    async def reject_login(_request: Request, error: LoginRejected) -> JSONResponse:
        return JSONResponse(status_code=401, content={"code": error.code, "message": str(error)})

    @app.exception_handler(psycopg.errors.InvalidSchemaName)
    @app.exception_handler(psycopg.errors.UndefinedTable)
    async def registration_unavailable(_request: Request, _error: psycopg.Error) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "code": "registration_unavailable",
                "message": "registration is not installed",
            },
        )

    @app.middleware("http")
    async def refuse_foreign_target(request: Request, call_next):
        query_account = request.query_params.get("account")
        header_account = request.headers.get("x-kxm-account")
        try:
            assert_request_account(
                account=query_account,
                database=request.query_params.get("database"),
                namespace=request.query_params.get("namespace"),
                host=request.query_params.get("host") or request.headers.get("x-kxm-host"),
                temporal_target=request.query_params.get("temporalTarget")
                or request.headers.get("x-kxm-temporal-target"),
            )
            assert_request_account(account=header_account)
            if query_account and header_account and query_account != header_account:
                raise AccountRefused("account_not_kxmd", "request account headers disagree")
        except AccountRefused as error:
            return JSONResponse(status_code=403, content={"code": error.code, "message": str(error)})
        return await call_next(request)

    def account_view() -> AccountView:
        return AccountView(account=ACCOUNT, database=ACCOUNT, namespace=ACCOUNT, role=ACCOUNT)

    def refuse_body(body: TargetFields) -> None:
        assert_request_account(
            account=body.account,
            database=body.database,
            namespace=body.namespace,
            host=body.host,
            temporal_target=body.temporalTarget,
        )

    def login(request: Request) -> Actor:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise LoginRejected("login_required", "Authorization bearer token is required")
        token = header.split(" ", 1)[1].strip()
        checker: AuthentikVerifier | None = request.app.state.verifier
        if checker is None:
            raise LoginRejected("login_rejected", "Authentik verifier is not configured")
        accepted: Login = checker.verify(token)
        return Actor(accepted.subject, accepted.kind, accepted.platform_admin)

    def connection() -> psycopg.Connection:
        factory: Connect | None = app.state.connect
        if factory is None:
            raise RegistryDenied("registry_unavailable", "registration database is not configured")
        return factory()

    @app.get("/health", operation_id="health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/v1/account", response_model=AccountView, responses={403: {"model": Denied}}, operation_id="getAccount")
    def get_account(
        account: str | None = None,
        database: str | None = None,
        namespace: str | None = None,
        host: str | None = None,
        temporalTarget: str | None = None,
        x_kxm_account: str | None = Header(default=None),
    ) -> AccountView:
        refuse_body(
            TargetFields(
                account=x_kxm_account if x_kxm_account is not None else account,
                database=database,
                namespace=namespace,
                host=host,
                temporalTarget=temporalTarget,
            )
        )
        if x_kxm_account is not None and account is not None and x_kxm_account != account:
            raise AccountRefused("account_not_kxmd", "request account headers disagree")
        return account_view()

    @app.post("/v1/account", response_model=AccountView, responses={403: {"model": Denied}}, operation_id="postAccount")
    def post_account(choice: TargetFields | None = None) -> AccountView:
        refuse_body(choice or TargetFields())
        return account_view()

    @app.post("/v1/tenants", response_model=TenantView, operation_id="createTenant")
    def post_tenant(body: TenantCreate, request: Request) -> dict[str, str | None]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return create_tenant(
                conn,
                actor=actor,
                kind=body.kind,
                name=body.name,
                identifier=body.identifier,
                slug=body.slug,
                description=body.description,
            )

    @app.patch("/v1/tenants/{tenant_id}", response_model=TenantView, operation_id="updateTenant")
    def patch_tenant(tenant_id: str, body: TenantUpdate, request: Request) -> dict[str, str | None]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return update_tenant(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                name=body.name,
                slug=body.slug,
                description=body.description,
                identifier=body.identifier,
            )

    @app.post(
        "/v1/tenants/{tenant_id}/memberships",
        response_model=MembershipView,
        operation_id="addMembership",
    )
    def post_membership(tenant_id: str, body: MembershipCreate, request: Request) -> dict[str, str]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return add_membership(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                subject=body.subject,
                member_actor=body.actor,
                role=body.role,
            )

    @app.post("/v1/tenants/{tenant_id}/projects", response_model=ProjectView, operation_id="createProject")
    def post_project(tenant_id: str, body: ProjectCreate, request: Request) -> dict[str, str]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return create_project(conn, actor=actor, tenant_id=tenant_id, name=body.name)

    @app.post(
        "/v1/tenants/{tenant_id}/projects/{project_id}/repositories",
        response_model=RepositoryView,
        operation_id="mapRepository",
    )
    def post_repository(
        tenant_id: str,
        project_id: str,
        body: RepositoryCreate,
        request: Request,
    ) -> dict[str, str]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return map_repository(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                project_id=project_id,
                remote=body.remote,
            )

    @app.post(
        "/v1/tenants/{tenant_id}/projects/{project_id}/revisions",
        response_model=RevisionView,
        operation_id="publishRevision",
    )
    def post_revision(
        tenant_id: str,
        project_id: str,
        body: RevisionCreate,
        request: Request,
    ) -> dict[str, str]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return publish_revision(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                project_id=project_id,
                document=body.document,
            )

    @app.get(
        "/v1/tenants/{tenant_id}/projects/{project_id}/revisions/{revision_id}",
        response_model=RevisionView,
        operation_id="readRevision",
    )
    def get_revision(tenant_id: str, project_id: str, revision_id: str, request: Request) -> dict[str, str]:
        actor = login(request)
        with connection() as conn:
            return read_revision(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                project_id=project_id,
                revision_id=revision_id,
            )

    @app.put(
        "/v1/tenants/{tenant_id}/artifacts/{name}",
        response_model=ArtifactView,
        operation_id="putArtifact",
    )
    def put_tenant_artifact(
        tenant_id: str,
        name: str,
        body: ArtifactCreate,
        request: Request,
    ) -> dict[str, str | int]:
        refuse_body(body)
        actor = login(request)
        with connection() as conn:
            return put_artifact(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                name=name,
                content_base64=body.contentBase64,
                root=request.app.state.artifact_root,
            )

    @app.get(
        "/v1/tenants/{tenant_id}/artifacts/{name}",
        response_model=ArtifactView,
        operation_id="readArtifact",
    )
    def get_tenant_artifact(tenant_id: str, name: str, request: Request) -> dict[str, str]:
        actor = login(request)
        with connection() as conn:
            return read_artifact(
                conn,
                actor=actor,
                tenant_id=tenant_id,
                name=name,
                root=request.app.state.artifact_root,
            )

    @app.delete("/v1/registration", operation_id="removeRegistration")
    def delete_registration(request: Request) -> dict[str, bool]:
        actor = login(request)
        if not actor.platform_admin:
            raise RegistryDenied("registration_removal_forbidden", "only a platform admin can remove registration")
        with connection() as conn:
            remove_registration(conn)
        return {"removed": True}

    return app


def _default_verifier() -> AuthentikVerifier | None:
    issuer = os.environ.get("KXM_AUTHENTIK_ISSUER", "")
    audience = os.environ.get("KXM_AUTHENTIK_AUDIENCE", "")
    jwks_url = os.environ.get("KXM_AUTHENTIK_JWKS_URL", "")
    if not issuer or not audience or not jwks_url:
        return None
    return AuthentikVerifier(issuer=issuer, audience=audience, jwks_url=jwks_url)


def _default_connect() -> Connect | None:
    if not os.environ.get("KXM_KXMD_PASSWORD"):
        return None

    def connect() -> psycopg.Connection:
        from kxm_control.account import resolve_account

        target = resolve_account(os.environ)
        return psycopg.connect(
            host=target.host,
            port=target.port,
            dbname=target.database,
            user=target.role,
            password=target.password,
            connect_timeout=5,
        )

    return connect


app = create_app(connect=_default_connect(), verifier=_default_verifier())
