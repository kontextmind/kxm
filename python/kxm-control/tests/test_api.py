import unittest

from fastapi.testclient import TestClient

from kxm_control.api import app


class AccountApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health_does_not_connect(self) -> None:
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})

    def test_get_account_is_kxmd_and_has_no_password(self) -> None:
        response = self.client.get("/v1/account")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body, {
            "account": "kxmd",
            "database": "kxmd",
            "namespace": "kxmd",
            "role": "kxmd",
        })
        self.assertNotIn("password", body)

    def test_query_account_other_than_kxmd_is_denied(self) -> None:
        response = self.client.get("/v1/account", params={"account": "onesm"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "account_not_kxmd")

    def test_query_database_and_namespace_are_denied(self) -> None:
        database = self.client.get("/v1/account", params={"database": "temporal"})
        namespace = self.client.get("/v1/account", params={"namespace": "default"})
        self.assertEqual(database.json()["code"], "database_not_account")
        self.assertEqual(namespace.json()["code"], "namespace_not_account")

    def test_request_cannot_choose_a_host_or_temporal_target(self) -> None:
        host = self.client.get("/v1/account", params={"host": "10.0.0.8"})
        target = self.client.post("/v1/account", json={"temporalTarget": "other:7233"})
        self.assertEqual(host.status_code, 403)
        self.assertEqual(host.json()["code"], "host_not_caller_supplied")
        self.assertEqual(target.status_code, 403)
        self.assertEqual(target.json()["code"], "temporal_target_not_caller_supplied")

    def test_header_account_is_denied(self) -> None:
        response = self.client.get("/v1/account", headers={"x-kxm-account": "other"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "account_not_kxmd")

    def test_openapi_names_the_denial(self) -> None:
        schema = self.client.get("/openapi.json")
        self.assertEqual(schema.status_code, 200)
        body = schema.json()
        self.assertEqual(body["info"]["title"], "kxm-control")
        self.assertIn("/v1/account", body["paths"])
        self.assertIn("get", body["paths"]["/v1/account"])
        self.assertIn("post", body["paths"]["/v1/account"])
        self.assertIn("403", body["paths"]["/v1/account"]["get"]["responses"])


if __name__ == "__main__":
    unittest.main()
