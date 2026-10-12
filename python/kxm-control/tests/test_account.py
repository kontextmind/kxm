import unittest

from kxm_control.account import DATABASE, NAMESPACE, ROLE, AccountRefused, resolve_account


class ResolveAccountTest(unittest.TestCase):
    def test_missing_password_is_refused(self) -> None:
        with self.assertRaises(AccountRefused) as caught:
            resolve_account({})
        self.assertEqual(caught.exception.code, "password_missing")

    def test_caller_cannot_choose_another_database(self) -> None:
        with self.assertRaises(AccountRefused) as caught:
            resolve_account({"KXM_DATABASE": "temporal", "KXM_KXMD_PASSWORD": "secret"})
        self.assertEqual(caught.exception.code, "database_not_account")

    def test_caller_cannot_choose_another_namespace(self) -> None:
        with self.assertRaises(AccountRefused) as caught:
            resolve_account({"KXM_TEMPORAL_NAMESPACE": "default", "KXM_KXMD_PASSWORD": "secret"})
        self.assertEqual(caught.exception.code, "namespace_not_account")

    def test_caller_cannot_choose_another_role(self) -> None:
        with self.assertRaises(AccountRefused) as caught:
            resolve_account({"KXM_DB_USER": "temporal", "KXM_KXMD_PASSWORD": "secret"})
        self.assertEqual(caught.exception.code, "role_not_account")

    def test_fixed_account_is_kxmd(self) -> None:
        target = resolve_account({"KXM_KXMD_PASSWORD": "secret", "KXM_DATABASE": DATABASE})
        self.assertEqual(target.database, DATABASE)
        self.assertEqual(target.namespace, NAMESPACE)
        self.assertEqual(target.role, ROLE)
        self.assertNotIn("password", target.public())

    def test_invalid_port_is_refused(self) -> None:
        with self.assertRaises(AccountRefused) as caught:
            resolve_account({"KXM_KXMD_PASSWORD": "secret", "KXM_POSTGRES_PORT": "nope"})
        self.assertEqual(caught.exception.code, "postgres_port_invalid")


if __name__ == "__main__":
    unittest.main()
