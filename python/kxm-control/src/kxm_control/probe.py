"""Open the fixed kxmd database and Temporal namespace. Print no password."""

import asyncio
import json
from typing import Mapping

import psycopg
from temporalio.client import Client

from kxm_control.account import AccountTarget, resolve_account


def probe_postgres(target: AccountTarget) -> str:
    with psycopg.connect(
        host=target.host,
        port=target.port,
        dbname=target.database,
        user=target.role,
        password=target.password,
        connect_timeout=5,
    ) as connection:
        row = connection.execute("SELECT current_database(), current_user, version()").fetchone()
    if row is None or row[0] != target.database or row[1] != target.role:
        raise RuntimeError("postgres connection did not land on the kxmd role")
    return str(row[2]).split(",", 1)[0]


async def probe_temporal(target: AccountTarget) -> str:
    client = await Client.connect(target.temporal_target, namespace=target.namespace)
    await client.count_workflows()
    return target.namespace



async def probe(env: Mapping[str, str]) -> dict[str, str | int]:
    target = resolve_account(env)
    postgres_version = probe_postgres(target)
    namespace = await probe_temporal(target)
    if namespace != target.namespace:
        raise RuntimeError("temporal connection did not use the kxmd namespace")
    result = target.public()
    result["postgres"] = postgres_version
    result["temporalNamespace"] = namespace
    return result


def main() -> None:
    import os

    print(json.dumps(asyncio.run(probe(os.environ)), sort_keys=True))


if __name__ == "__main__":
    main()
