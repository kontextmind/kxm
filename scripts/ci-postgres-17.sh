#!/usr/bin/env bash
# Start PostgreSQL 17 on 127.0.0.1:5432 for the Python MG1 lane.
# The kontextmind-doks scale set has a client binary and no engine socket, so
# this job provisions the server from a pinned archive instead of a workflow
# service. A second call in the same job returns once that server is ready.

set -euo pipefail

version=17.11.0
triple=x86_64-unknown-linux-gnu
sha256=b7a1ba6bae6499d8296e3e81b0171eecfd1766ca9aaa0057e41ad3e844e5e2e0
archive_name="postgresql-${version}-${triple}.tar.gz"
url="https://github.com/theseus-rs/postgresql-binaries/releases/download/${version}/${archive_name}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "PostgreSQL 17 CI archive is linux/x86_64 only (got $(uname -s)/$(uname -m))" >&2
  exit 1
fi

work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/kxm-mg1-postgres"
prefix="${work}/postgresql-${version}-${triple}"
pgdata="${work}/data"
pglog="${work}/postgres.log"
pwfile="${work}/pwfile"
mkdir -p "$work"

package_for_library() {
  case "$1" in
    libzstd.so.*) echo libzstd1 ;;
    liblz4.so.*) echo liblz4-1 ;;
    libxml2.so.*) echo libxml2 ;;
    liblzma.so.*) echo liblzma5 ;;
    libssl.so.3 | libcrypto.so.3) echo libssl3 ;;
    libicuuc.so.74 | libicui18n.so.74 | libicudata.so.74) echo libicu74 ;;
    libgssapi_krb5.so.*) echo libgssapi-krb5-2 ;;
    libkrb5.so.* | libk5crypto.so.* | libkrb5support.so.*) echo libkrb5-3 ;;
    libcom_err.so.*) echo libcom-err2 ;;
    libkeyutils.so.*) echo libkeyutils1 ;;
    libstdc++.so.*) echo libstdc++6 ;;
    libgcc_s.so.*) echo libgcc-s1 ;;
    libz.so.*) echo zlib1g ;;
    *) return 1 ;;
  esac
}

server_version_num() {
  PGPASSWORD=postgres "${prefix}/bin/psql" \
    -h 127.0.0.1 -p 5432 -U postgres -d postgres \
    -Atqc "SHOW server_version_num"
}

postgres_17_ready() {
  [[ -x "${prefix}/bin/pg_isready" ]] || return 1
  "${prefix}/bin/pg_isready" -h 127.0.0.1 -p 5432 -U postgres >/dev/null 2>&1 || return 1
  local num
  num="$(server_version_num 2>/dev/null)" || return 1
  [[ "$num" -ge 170000 && "$num" -lt 180000 ]]
}

install_missing_libraries() {
  local -a missing=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && missing+=("$line")
  done < <(ldd "${prefix}/bin/postgres" | awk '/not found$/ { print $1 }')
  if [[ ${#missing[@]} -eq 0 ]]; then
    return 0
  fi

  local -a packages=()
  local lib pkg
  for lib in "${missing[@]}"; do
    if ! pkg="$(package_for_library "$lib")"; then
      echo "PostgreSQL 17 needs ${lib}, which has no package mapping on this runner" >&2
      ldd "${prefix}/bin/postgres" >&2 || true
      exit 1
    fi
    packages+=("$pkg")
  done
  mapfile -t packages < <(printf '%s\n' "${packages[@]}" | awk '!seen[$0]++')
  echo "Installing shared libraries for PostgreSQL 17: ${packages[*]}"
  sudo -n apt-get update
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"

  local -a still=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && still+=("$line")
  done < <(ldd "${prefix}/bin/postgres" | awk '/not found$/ { print $1 }')
  if [[ ${#still[@]} -gt 0 ]]; then
    echo "PostgreSQL 17 still needs: ${still[*]}" >&2
    exit 1
  fi
}

if postgres_17_ready; then
  echo "PostgreSQL 17 already ready on 127.0.0.1:5432 (server_version_num=$(server_version_num))"
  exit 0
fi

if [[ ! -x "${prefix}/bin/postgres" ]]; then
  echo "Downloading PostgreSQL ${version}"
  curl --fail --silent --show-error --location --retry 5 --retry-delay 2 \
    --output "${work}/${archive_name}" \
    "$url"
  echo "${sha256}  ${work}/${archive_name}" | sha256sum -c -
  tar -xzf "${work}/${archive_name}" -C "$work"
fi
install_missing_libraries

if [[ ! -s "${pgdata}/PG_VERSION" ]]; then
  printf '%s\n' postgres >"$pwfile"
  chmod 600 "$pwfile"
  "${prefix}/bin/initdb" \
    --username=postgres \
    --pwfile="$pwfile" \
    --auth-host=scram-sha-256 \
    --auth-local=trust \
    --encoding=UTF8 \
    --locale=C \
    --set listen_addresses=127.0.0.1 \
    --set port=5432 \
    --set shared_buffers=16MB \
    --set max_connections=20 \
    --set shared_memory_type=mmap \
    --set dynamic_shared_memory_type=mmap \
    --set huge_pages=off \
    --set fsync=off \
    --set synchronous_commit=off \
    --set full_page_writes=off \
    --pgdata="$pgdata"
fi

if ! "${prefix}/bin/pg_ctl" -D "$pgdata" -l "$pglog" -w -t 30 start; then
  echo "PostgreSQL 17 failed to start" >&2
  cat "$pglog" >&2 || true
  exit 1
fi

num="$(server_version_num)"
if [[ "$num" -lt 170000 || "$num" -ge 180000 ]]; then
  echo "PostgreSQL 17 required, server_version_num=${num}" >&2
  exit 1
fi
echo "PostgreSQL 17 ready on 127.0.0.1:5432 (server_version_num=${num})"
