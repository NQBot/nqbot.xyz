#!/usr/bin/env python3
"""Generate or verify the deterministic SHA-256 manifest for site downloads."""

from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
from pathlib import Path


MANIFEST_NAME = "SHA256SUMS"
DOWNLOAD_DIRECTORY = "indicators"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def downloadable_artifacts(root: Path) -> list[Path]:
    directory = root / DOWNLOAD_DIRECTORY
    return sorted(
        (path for path in directory.glob("*.zip") if path.is_file()),
        key=lambda path: path.relative_to(root).as_posix(),
    )


def render_manifest(root: Path) -> str:
    lines = [
        f"{_sha256(path)}  {path.relative_to(root).as_posix()}"
        for path in downloadable_artifacts(root)
    ]
    return "\n".join(lines) + ("\n" if lines else "")


def write_manifest(root: Path) -> None:
    destination = root / MANIFEST_NAME
    content = render_manifest(root)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{MANIFEST_NAME}.", suffix=".tmp", dir=root
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, destination)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="site repository root",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed manifest instead of rewriting it",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    expected = render_manifest(root)
    destination = root / MANIFEST_NAME

    if args.check:
        try:
            actual = destination.read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"ERROR: missing {MANIFEST_NAME}")
            return 1
        if actual != expected:
            print(
                "ERROR: SHA256SUMS is stale; run "
                "python scripts/generate_checksums.py after reviewing download changes"
            )
            return 1
        print(f"Verified {len(downloadable_artifacts(root))} download checksums")
        return 0

    write_manifest(root)
    print(f"Wrote {MANIFEST_NAME} for {len(downloadable_artifacts(root))} downloads")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
