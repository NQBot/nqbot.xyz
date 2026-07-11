from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

from copy_public_snapshots import (  # noqa: E402
    PUBLIC_SNAPSHOT_NAMES,
    SnapshotImportError,
    copy_public_snapshots,
)


class CopyPublicSnapshotsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.destination = self.root / "destination"
        self.source.mkdir()
        self.destination.mkdir()
        for name in PUBLIC_SNAPSHOT_NAMES:
            (self.source / name).write_text(
                json.dumps({"schema_version": 2, "name": name}) + "\n",
                encoding="utf-8",
            )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_exact_allowlist_is_copied(self) -> None:
        written = copy_public_snapshots(self.source, self.destination)
        self.assertEqual({path.name for path in written}, set(PUBLIC_SNAPSHOT_NAMES))
        self.assertEqual(
            {path.name for path in self.destination.iterdir()},
            set(PUBLIC_SNAPSHOT_NAMES),
        )

    def test_extra_branch_file_is_rejected_before_writes(self) -> None:
        (self.source / "index.html").write_text("untrusted code", encoding="utf-8")
        with self.assertRaisesRegex(SnapshotImportError, "exactly the public allowlist"):
            copy_public_snapshots(self.source, self.destination)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_duplicate_json_key_is_rejected_before_writes(self) -> None:
        target = self.source / "eval_arena_snapshot.json"
        target.write_text('{"schema_version":2,"schema_version":2}\n', encoding="utf-8")
        with self.assertRaisesRegex(SnapshotImportError, "duplicate JSON key"):
            copy_public_snapshots(self.source, self.destination)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_symlink_is_rejected_when_supported(self) -> None:
        target = self.source / "eval_arena_snapshot.json"
        target.unlink()
        try:
            target.symlink_to(self.source / "scoreboard_snapshot.json")
        except OSError:
            self.skipTest("symlink creation is not available")
        with self.assertRaisesRegex(SnapshotImportError, "non-regular snapshot"):
            copy_public_snapshots(self.source, self.destination)


if __name__ == "__main__":
    unittest.main()
