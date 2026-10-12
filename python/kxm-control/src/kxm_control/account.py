"""The first Python caller may use only the installed kxmd account.

A request, flag, or environment value cannot choose another database or
Temporal namespace. The host may be overridden so a tunnel can reach the
loopback listener. The password is never defaulted.
"""

from dataclasses import dataclass
from typing import Mapping

ACCOUNT = "kxmd"
DATABASE = "kxmd"
NAMESPACE = "kxmd"
ROLE = "kxmd"
POSTGRES_HOST = "127.0.0.1"
POSTGRES_PORT = 5432
TEMPORAL_TARGET = "127.0.0.1:7233"


class AccountRefused(Exception):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class AccountTarget:
    account: str
    database: str
    namespace: str
    role: str
    host: str
    port: int
    temporal_target: str
    password: str

    def public(self) -> dict[str, str | int]:
        return {
            "account": self.account,
            "database": self.database,
            "namespace": self.namespace,
            "role": self.role,
            "host": self.host,
            "port": self.port,
            "temporalTarget": self.temporal_target,
        }


def resolve_account(env: Mapping[str, str]) -> AccountTarget:
    _refuse_override(env, "KXM_DATABASE", DATABASE, "database_not_account")
    _refuse_override(env, "KXM_TEMPORAL_NAMESPACE", NAMESPACE, "namespace_not_account")
    _refuse_override(env, "KXM_DB_USER", ROLE, "role_not_account")
    password = env.get("KXM_KXMD_PASSWORD", "")
    if not password:
        raise AccountRefused("password_missing", "KXM_KXMD_PASSWORD is required")
    host = env.get("KXM_POSTGRES_HOST", POSTGRES_HOST) or POSTGRES_HOST
    port_text = env.get("KXM_POSTGRES_PORT", str(POSTGRES_PORT))
    temporal_target = env.get("KXM_TEMPORAL_TARGET", TEMPORAL_TARGET) or TEMPORAL_TARGET
    try:
        port = int(port_text)
    except ValueError as error:
        raise AccountRefused("postgres_port_invalid", "KXM_POSTGRES_PORT must be an integer") from error
    if port < 1 or port > 65535:
        raise AccountRefused("postgres_port_invalid", "KXM_POSTGRES_PORT is out of range")
    return AccountTarget(
        account=ACCOUNT,
        database=DATABASE,
        namespace=NAMESPACE,
        role=ROLE,
        host=host,
        port=port,
        temporal_target=temporal_target,
        password=password,
    )


def _refuse_override(env: Mapping[str, str], key: str, expected: str, code: str) -> None:
    supplied = env.get(key)
    if supplied is not None and supplied != expected:
        raise AccountRefused(code, f"{key} is fixed to {expected}")


def assert_request_account(
    *,
    account: str | None = None,
    database: str | None = None,
    namespace: str | None = None,
    host: str | None = None,
    temporal_target: str | None = None,
) -> None:
    """A request may omit the account. It may not name a different one or a host."""
    checks = (
        (account, ACCOUNT, "account_not_kxmd", "account"),
        (database, DATABASE, "database_not_account", "database"),
        (namespace, NAMESPACE, "namespace_not_account", "namespace"),
    )
    for supplied, expected, code, label in checks:
        if supplied is not None and supplied != expected:
            raise AccountRefused(code, f"request {label} is fixed to {expected}")
    if host is not None:
        raise AccountRefused("host_not_caller_supplied", "a request cannot choose the database host")
    if temporal_target is not None:
        raise AccountRefused(
            "temporal_target_not_caller_supplied",
            "a request cannot choose the Temporal target",
        )
