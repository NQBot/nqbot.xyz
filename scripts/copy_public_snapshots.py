"""Copy the exact public snapshot branch allowlist into a site build directory."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


PUBLIC_SNAPSHOT_NAMES = frozenset(
    {
        "scoreboard_snapshot.json",
        "scoreboard_state_snapshot.json",
        "account_daily_pnl_snapshot.json",
        "account_pnl_history_snapshot.json",
        "eval_arena_snapshot.json",
    }
)
MAX_PUBLIC_SNAPSHOT_BYTES = 500_000


class SnapshotImportError(ValueError):
    """The data checkout is not an exact, safe public snapshot branch."""


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise SnapshotImportError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _repository_files(source: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for candidate in source.rglob("*"):
        relative = candidate.relative_to(source)
        if relative.parts and relative.parts[0] == ".git":
            continue
        if candidate.is_symlink() or candidate.is_file():
            files[relative.as_posix()] = candidate
    return files


def copy_public_snapshots(source: Path, destination: Path) -> list[Path]:
    if not source.is_absolute() or not destination.is_absolute():
        raise SnapshotImportError("source and destination must be absolute paths")
    if not source.is_dir() or source.is_symlink():
        raise SnapshotImportError("source must be a non-symbolic-link directory")
    if not destination.is_dir() or destination.is_symlink():
        raise SnapshotImportError("destination must be a non-symbolic-link directory")

    actual = _repository_files(source)
    if set(actual) != PUBLIC_SNAPSHOT_NAMES:
        raise SnapshotImportError(
            "snapshot branch must contain exactly the public allowlist; "
            f"found {sorted(actual)!r}"
        )

    prepared: list[tuple[str, bytes]] = []
    for name in sorted(PUBLIC_SNAPSHOT_NAMES):
        candidate = actual[name]
        if candidate.is_symlink() or not candidate.is_file():
            raise SnapshotImportError(f"refusing non-regular snapshot {name!r}")
        size = candidate.stat().st_size
        if size > MAX_PUBLIC_SNAPSHOT_BYTES:
            raise SnapshotImportError(
                f"snapshot {name!r} exceeds {MAX_PUBLIC_SNAPSHOT_BYTES} bytes"
            )
        raw = candidate.read_bytes()
        try:
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise SnapshotImportError(f"snapshot {name!r} is not valid UTF-8 JSON") from exc
        if not isinstance(payload, dict) or payload.get("schema_version") != 2:
            raise SnapshotImportError(f"snapshot {name!r} must be a schema-version-2 object")
        prepared.append((name, raw))

    written: list[Path] = []
    for name, raw in prepared:
        target = destination / name
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{name}.",
            suffix=".tmp",
            dir=destination,
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            written.append(target)
        finally:
            temporary.unlink(missing_ok=True)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    copy_public_snapshots(args.source.resolve(), args.destination.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
