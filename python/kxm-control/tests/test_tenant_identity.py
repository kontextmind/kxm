import unittest

from kxm_control.registry import RegistryDenied, validate_identifier, validate_slug


class TenantIdentityTest(unittest.TestCase):
    def test_identifier_is_at_most_five_characters(self) -> None:
        validate_identifier("t1")
        with self.assertRaises(RegistryDenied) as caught:
            validate_identifier("tenant")
        self.assertEqual(caught.exception.code, "tenant_identifier_invalid")

    def test_slug_is_at_most_fifteen_characters(self) -> None:
        validate_slug("kxmd")
        validate_slug("a" * 15)
        with self.assertRaises(RegistryDenied) as caught:
            validate_slug("a" * 16)
        self.assertEqual(caught.exception.code, "tenant_slug_invalid")

    def test_slug_cannot_use_the_service_name_as_a_requirement(self) -> None:
        validate_slug("pilot")
        with self.assertRaises(RegistryDenied):
            validate_slug("Pilot")


if __name__ == "__main__":
    unittest.main()
