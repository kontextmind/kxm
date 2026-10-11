"""Authentik login for a user or a runner.

A token is accepted only when the issuer, audience, expiry, and RS256 signature match.
The `kxm_actor` claim must be `user` or `runner`. A valid token does not grant
a tenant; membership does that.
"""

from __future__ import annotations

from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

from kxm_control.account import AccountRefused


class LoginRejected(AccountRefused):
    """The caller did not present an accepted Authentik token."""


@dataclass(frozen=True)
class Login:
    subject: str
    kind: str
    platform_admin: bool


class AuthentikVerifier:
    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        keys: dict[str, str] | None = None,
        jwks_url: str | None = None,
    ) -> None:
        if not issuer or not audience:
            raise LoginRejected("login_rejected", "Authentik issuer and audience are required")
        if keys is None and not jwks_url:
            raise LoginRejected("login_rejected", "Authentik JWKS is required")
        self.issuer = issuer
        self.audience = audience
        self.keys = keys or {}
        self._jwks = PyJWKClient(jwks_url) if jwks_url else None

    def verify(self, token: str) -> Login:
        if not token:
            raise LoginRejected("login_required", "Authorization bearer token is required")
        try:
            header = jwt.get_unverified_header(token)
            key = self._signing_key(token, header.get("kid"))
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.issuer,
                options={"require": ["exp"]},
            )
        except LoginRejected:
            raise
        except Exception as error:
            raise LoginRejected("login_rejected", "token was not accepted") from error
        kind = claims.get("kxm_actor")
        subject = claims.get("sub")
        if kind not in ("user", "runner") or not isinstance(subject, str) or not subject:
            raise LoginRejected("login_rejected", "token is missing a user or runner subject")
        return Login(
            subject=subject,
            kind=kind,
            platform_admin=claims.get("kxm_platform") == "admin",
        )

    def _signing_key(self, token: str, kid: str | None) -> str:
        if kid and kid in self.keys:
            return self.keys[kid]
        if self._jwks is None:
            raise LoginRejected("login_rejected", "token was not accepted")
        return self._jwks.get_signing_key_from_jwt(token).key
