import base64
import hashlib
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
import jwt
import psycopg
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from kxm_control.api import create_app
from kxm_control.auth import AuthentikVerifier
from kxm_control.clientgen import dump_openapi, generate_studio_client
from kxm_control.registry import install

ROOT = Path(__file__).parents[1]
CONTRACT = ROOT / "contract" / "openapi.json"
CLIENT = ROOT / "generated" / "studio-client.ts"
ADMIN = os.environ.get("KXM_MG1_ADMIN_DSN", "host=127.0.0.1 port=5432 dbname=postgres")
TEST_DSN = os.environ.get("KXM_MG1_TEST_DSN", "host=127.0.0.1 port=5432 dbname=kxm_mg1_test")
ISSUER = "https://id.kxmd.dev/application/o/kxm-control/"
AUDIENCE = "kxm-control"
KID = "mg1-test"


def _token(
    private_pem: bytes,
    *,
    subject: str,
    kind: str,
    platform: str | None = None,
    issuer: str = ISSUER,
    expires_in: int | None = 3600,
) -> str:
    claims: dict[str, object] = {"sub": subject, "kxm_actor": kind, "aud": AUDIENCE, "iss": issuer}
    if platform:
        claims["kxm_platform"] = platform
    if expires_in is not None:
        claims["exp"] = int(time.time()) + expires_in
    return jwt.encode(claims, private_pem, algorithm="RS256", headers={"kid": KID})


class Mg1GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        admin = psycopg.connect(ADMIN, autocommit=True)
        admin.execute("DROP DATABASE IF EXISTS kxm_mg1_test")
        admin.execute("CREATE DATABASE kxm_mg1_test")
        admin.close()
        connection = psycopg.connect(TEST_DSN)
        install(connection)
        connection.close()
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.private_pem = private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        public = private.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        cls.verifier = AuthentikVerifier(issuer=ISSUER, audience=AUDIENCE, keys={KID: public.decode()})
        cls._artifact_directory = tempfile.TemporaryDirectory()
        cls.artifacts = Path(cls._artifact_directory.name)

    @classmethod
    def tearDownClass(cls) -> None:
        admin = psycopg.connect(ADMIN, autocommit=True)
        admin.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'kxm_mg1_test'"
        )
        admin.execute("DROP DATABASE IF EXISTS kxm_mg1_test")
        admin.close()
        cls._artifact_directory.cleanup()

    def setUp(self) -> None:
        self.connection = psycopg.connect(TEST_DSN)
        install(self.connection)
        self.connection.execute(
            """
            TRUNCATE kxm_registry.revisions, kxm_registry.repositories,
                     kxm_registry.projects, kxm_registry.memberships, kxm_registry.tenants
            """
        )
        self.connection.commit()
        self.client = TestClient(
            create_app(
                connect=lambda: psycopg.connect(TEST_DSN),
                verifier=self.verifier,
                artifact_root=self.artifacts,
            )
        )

    def tearDown(self) -> None:
        self.connection.close()

    def _auth(self, subject: str, kind: str = "user", platform: str | None = None) -> dict[str, str]:
        return {"authorization": f"Bearer {_token(self.private_pem, subject=subject, kind=kind, platform=platform)}"}

    def test_missing_login_is_rejected(self) -> None:
        response = self.client.post("/v1/tenants", json={"kind": "personal", "name": "Ada", "identifier": "ada", "slug": "ada"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "login_required")

    def test_runner_cannot_create_a_tenant(self) -> None:
        response = self.client.post(
            "/v1/tenants",
            json={"kind": "personal", "name": "Runner", "identifier": "run", "slug": "runner"},
            headers=self._auth("runner-1", kind="runner"),
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "tenant_create_forbidden")

    def test_token_without_expiry_is_rejected(self) -> None:
        token = _token(self.private_pem, subject="ada", kind="user", expires_in=None)
        response = self.client.post(
            "/v1/tenants",
            json={"kind": "personal", "name": "Ada", "identifier": "ada", "slug": "ada"},
            headers={"authorization": f"Bearer {token}"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "login_rejected")

    def test_standard_runner_cannot_rename_a_tenant(self) -> None:
        created = self.client.post(
            "/v1/tenants",
            json={"kind": "org", "name": "KXMD", "identifier": "t1", "slug": "kxmd"},
            headers=self._auth("ada"),
        )
        self.assertEqual(created.status_code, 200, created.text)
        tenant_id = created.json()["tenantId"]
        added = self.client.post(
            f"/v1/tenants/{tenant_id}/memberships",
            json={"subject": "runner-1", "actor": "runner", "role": "standard"},
            headers=self._auth("ada"),
        )
        self.assertEqual(added.status_code, 200, added.text)
        renamed = self.client.patch(
            f"/v1/tenants/{tenant_id}",
            json={"name": "Renamed", "slug": "renamed"},
            headers=self._auth("runner-1", kind="runner"),
        )
        self.assertEqual(renamed.status_code, 403)
        self.assertEqual(renamed.json()["code"], "tenant_update_forbidden")
        with psycopg.connect(TEST_DSN) as connection:
            row = connection.execute(
                "SELECT name, slug FROM kxm_registry.tenants WHERE id = %s",
                (tenant_id,),
            ).fetchone()
        self.assertEqual(row, ("KXMD", "kxmd"))

    def test_wrong_issuer_is_rejected(self) -> None:
        token = _token(self.private_pem, subject="ada", kind="user", issuer="https://evil.example/")
        response = self.client.post(
            "/v1/tenants",
            json={"kind": "personal", "name": "Ada", "identifier": "ada", "slug": "ada"},
            headers={"authorization": f"Bearer {token}"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "login_rejected")

    def test_published_revision_round_trip_and_cross_tenant_denial(self) -> None:
        created = self.client.post(
            "/v1/tenants",
            json={"kind": "org", "name": "KXMD", "identifier": "t1", "slug": "kxmd"},
            headers=self._auth("ada"),
        )
        self.assertEqual(created.status_code, 200, created.text)
        tenant_id = created.json()["tenantId"]
        project = self.client.post(
            f"/v1/tenants/{tenant_id}/projects",
            json={"name": "kxm"},
            headers=self._auth("ada"),
        )
        self.assertEqual(project.status_code, 200, project.text)
        project_id = project.json()["projectId"]
        mapped = self.client.post(
            f"/v1/tenants/{tenant_id}/projects/{project_id}/repositories",
            json={"remote": "git@github.com:kontextmind/kxm.git"},
            headers=self._auth("ada"),
        )
        self.assertEqual(mapped.status_code, 200, mapped.text)
        document = {"schema": "kxm.definition.v1", "name": "guide", "steps": ["plan", "implement"]}
        published = self.client.post(
            f"/v1/tenants/{tenant_id}/projects/{project_id}/revisions",
            json={"document": document},
            headers=self._auth("ada"),
        )
        self.assertEqual(published.status_code, 200, published.text)
        body = published.json()
        canonical = json.dumps(document, sort_keys=True, separators=(",", ":"))
        self.assertEqual(body["canonical"], canonical)
        self.assertEqual(body["sha256"], hashlib.sha256(canonical.encode()).hexdigest())
        read = self.client.get(
            f"/v1/tenants/{tenant_id}/projects/{project_id}/revisions/{body['revisionId']}",
            headers=self._auth("ada"),
        )
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(read.json(), body)
        stranger = self.client.get(
            f"/v1/tenants/{tenant_id}/projects/{project_id}/revisions/{body['revisionId']}",
            headers=self._auth("bea"),
        )
        self.assertEqual(stranger.status_code, 403)
        self.assertEqual(stranger.json()["code"], "tenant_membership_missing")
        other_host = self.client.post(
            f"/v1/tenants/{tenant_id}/projects",
            json={"name": "other", "host": "10.9.9.9"},
            headers=self._auth("ada"),
        )
        self.assertEqual(other_host.status_code, 403)
        self.assertEqual(other_host.json()["code"], "host_not_caller_supplied")

    def test_runner_login_is_not_a_user_membership(self) -> None:
        created = self.client.post(
            "/v1/tenants",
            json={"kind": "personal", "name": "Ada", "identifier": "ada", "slug": "ada"},
            headers=self._auth("ada"),
        )
        tenant_id = created.json()["tenantId"]
        added = self.client.post(
            f"/v1/tenants/{tenant_id}/memberships",
            json={"subject": "runner-1", "actor": "runner", "role": "standard"},
            headers=self._auth("ada"),
        )
        self.assertEqual(added.status_code, 200, added.text)
        as_user = self.client.post(
            f"/v1/tenants/{tenant_id}/projects",
            json={"name": "nope"},
            headers=self._auth("runner-1", kind="user"),
        )
        self.assertEqual(as_user.status_code, 403)
        self.assertEqual(as_user.json()["code"], "tenant_membership_missing")
        as_runner = self.client.post(
            f"/v1/tenants/{tenant_id}/projects",
            json={"name": "runner-project"},
            headers=self._auth("runner-1", kind="runner"),
        )
        self.assertEqual(as_runner.status_code, 200, as_runner.text)

    def test_artifact_round_trip_stays_in_the_tenant_directory(self) -> None:
        created = self.client.post(
            "/v1/tenants",
            json={"kind": "org", "name": "Files", "identifier": "file", "slug": "files"},
            headers=self._auth("ada"),
        )
        tenant_id = created.json()["tenantId"]
        payload = b"artifact-bytes"
        stored = self.client.put(
            f"/v1/tenants/{tenant_id}/artifacts/note.txt",
            json={"contentBase64": base64.b64encode(payload).decode()},
            headers=self._auth("ada"),
        )
        self.assertEqual(stored.status_code, 200, stored.text)
        read = self.client.get(
            f"/v1/tenants/{tenant_id}/artifacts/note.txt",
            headers=self._auth("ada"),
        )
        self.assertEqual(base64.b64decode(read.json()["contentBase64"]), payload)
        escaped = self.client.put(
            f"/v1/tenants/{tenant_id}/artifacts/bad%20name",
            json={"contentBase64": base64.b64encode(b"x").decode()},
            headers=self._auth("ada"),
        )
        self.assertEqual(escaped.status_code, 403, escaped.text)
        self.assertEqual(escaped.json()["code"], "artifact_name_invalid")
        from kxm_control.registry import _artifact_path, RegistryDenied
        with self.assertRaises(RegistryDenied) as caught:
            _artifact_path(self.artifacts, tenant_id, "../secret")
        self.assertEqual(caught.exception.code, "artifact_name_invalid")

    def test_removing_registration_does_not_touch_source_state(self) -> None:
        source = self.artifacts / "source-state.sqlite"
        source.write_bytes(b"source-state-unchanged")
        before = source.read_bytes()
        response = self.client.delete("/v1/registration", headers=self._auth("ada"))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "registration_removal_forbidden")
        removed = self.client.delete(
            "/v1/registration",
            headers=self._auth("ops", platform="admin"),
        )
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(source.read_bytes(), before)
        with psycopg.connect(TEST_DSN) as connection:
            row = connection.execute(
                "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'kxm_registry'"
            ).fetchone()
        self.assertIsNone(row)
        unavailable = self.client.post(
            "/v1/tenants",
            json={"kind": "personal", "name": "Ada", "identifier": "ada", "slug": "ada"},
            headers=self._auth("ada"),
        )
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(unavailable.json()["code"], "registration_unavailable")
        self.assertEqual(unavailable.json()["message"], "registration is not installed")

    def test_published_contract_and_studio_client_regenerate(self) -> None:
        spec = self.client.app.openapi()
        self.assertEqual(CONTRACT.read_text(), dump_openapi(spec))
        generated = generate_studio_client(spec)
        self.assertEqual(CLIENT.read_text(), generated)
        check = subprocess.run(
            ["node", "--experimental-strip-types", "--check", str(CLIENT)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(check.returncode, 0, check.stderr)


class JwksLoginTest(unittest.TestCase):
    def test_verifier_accepts_a_jwks_url(self) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(RSAAlgorithm.to_jwk(private.public_key()))
        jwk.update({"kid": "jwks", "use": "sig", "alg": "RS256"})
        body = json.dumps({"keys": [jwk]}).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        import threading

        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            verifier = AuthentikVerifier(
                issuer=ISSUER,
                audience=AUDIENCE,
                jwks_url=f"http://127.0.0.1:{port}/jwks",
            )
            pem = private.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
            token = jwt.encode(
                {
                    "sub": "ada",
                    "kxm_actor": "runner",
                    "aud": AUDIENCE,
                    "iss": ISSUER,
                    "exp": int(time.time()) + 3600,
                },
                pem,
                algorithm="RS256",
                headers={"kid": "jwks"},
            )
            login = verifier.verify(token)
            self.assertEqual(login.subject, "ada")
            self.assertEqual(login.kind, "runner")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
