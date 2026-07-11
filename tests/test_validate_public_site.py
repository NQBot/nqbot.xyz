from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

from generate_checksums import render_manifest  # noqa: E402
from validate_public_site import (  # noqa: E402
    MAX_PUBLIC_SNAPSHOT_BYTES,
    validate_downloads,
    validate_html,
    validate_json_snapshots,
    validate_public_files,
    validate_site,
)


def _valid_snapshots() -> dict[str, dict]:
    return {
        "scoreboard_snapshot.json": {
            "schema_version": 2,
            "timestamp": "2026-07-10T20:00:00Z",
            "summary": {},
            "active_trades": [],
            "recent_exits": [],
        },
        "scoreboard_state_snapshot.json": {
            "schema_version": 2,
            "timestamp": "2026-07-10T20:00:00Z",
            "session": "closed",
            "algos": [],
        },
        "account_daily_pnl_snapshot.json": {
            "schema_version": 2,
            "trading_day": "2026-07-10",
            "accounts": [],
            "summary": {},
        },
        "account_pnl_history_snapshot.json": {
            "schema_version": 2,
            "generated_at": "2026-07-10T20:00:00Z",
            "history": {"algos": [], "bots": []},
        },
        "eval_arena_snapshot.json": {
            "schema_version": 2,
            "updated": "2026-07-10T20:00:00Z",
            "rows": [],
        },
    }


class SiteFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        (root / "indicators").mkdir(parents=True)
        for filename, payload in _valid_snapshots().items():
            (root / filename).write_text(
                json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
            )
        with zipfile.ZipFile(root / "indicators" / "tool.zip", "w") as archive:
            archive.writestr("Info.xml", "<NinjaTrader />\n")
            archive.writestr("Tool.cs", "namespace PublicTool {}\n")
        (root / "SHA256SUMS").write_text(render_manifest(root), encoding="utf-8")
        (root / "downloads.html").write_text(
            '<a href="indicators/tool.zip">Download</a>'
            '<a href="https://example.com" target="_blank" rel="noopener">Docs</a>',
            encoding="utf-8",
        )


class PublicSiteValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.fixture = SiteFixture(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_valid_minimal_site_passes(self) -> None:
        self.assertEqual([], validate_site(self.root))

    def test_snapshot_rejects_unknown_and_private_fields(self) -> None:
        path = self.root / "scoreboard_snapshot.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["summary"]["max_drawdown_time"] = "http://127.0.0.1:8000/private"
        payload["api_token"] = "redacted"
        path.write_text(json.dumps(payload), encoding="utf-8")

        errors = validate_json_snapshots(self.root)
        self.assertTrue(any("unknown key 'api_token'" in error for error in errors))
        self.assertTrue(any("forbidden key 'api_token'" in error for error in errors))
        self.assertTrue(any("private or loopback endpoint" in error for error in errors))

    def test_snapshot_rejects_duplicate_keys(self) -> None:
        path = self.root / "eval_arena_snapshot.json"
        path.write_text(
            '{"schema_version":2,"updated":"now","updated":"later","rows":[]}',
            encoding="utf-8",
        )
        errors = validate_json_snapshots(self.root)
        self.assertTrue(any("duplicate JSON key" in error for error in errors))

    def test_snapshot_rejects_oversize_file(self) -> None:
        path = self.root / "account_daily_pnl_snapshot.json"
        path.write_text(" " * (MAX_PUBLIC_SNAPSHOT_BYTES + 1), encoding="utf-8")
        errors = validate_json_snapshots(self.root)
        self.assertTrue(any("exceeds" in error and path.name in error for error in errors))

    def test_download_manifest_detects_tampering(self) -> None:
        artifact = self.root / "indicators" / "tool.zip"
        with artifact.open("ab") as stream:
            stream.write(b"tampered")
        _, errors = validate_downloads(self.root)
        self.assertTrue(any("does not match" in error for error in errors))

    def test_download_archive_rejects_path_traversal(self) -> None:
        artifact = self.root / "indicators" / "tool.zip"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("../outside.cs", "namespace Unsafe {}\n")
        (self.root / "SHA256SUMS").write_text(
            render_manifest(self.root), encoding="utf-8"
        )
        _, errors = validate_downloads(self.root)
        self.assertTrue(any("unsafe ZIP member path" in error for error in errors))

    def test_html_rejects_reverse_tabnabbing_and_unlisted_download(self) -> None:
        (self.root / "bad.html").write_text(
            '<a target="_blank" href="https://example.com">External</a>'
            '<a href="indicators/missing.zip">Missing</a>',
            encoding="utf-8",
        )
        errors = validate_html(self.root, {"indicators/tool.zip"})
        self.assertTrue(any("rel=noopener" in error for error in errors))
        self.assertTrue(any("missing from SHA256SUMS" in error for error in errors))

    def test_public_file_scan_rejects_token_format_and_sensitive_filename(self) -> None:
        token = "ghp_" + ("A" * 24)
        (self.root / "leak.md").write_text(f"credential: {token}\n", encoding="utf-8")
        (self.root / "private.key").write_text("not-a-real-key\n", encoding="utf-8")
        errors = validate_public_files(self.root)
        self.assertTrue(any("GitHub token" in error for error in errors))
        self.assertTrue(any("sensitive filename" in error for error in errors))

    def test_repository_workflow_is_read_only_and_immutably_pinned(self) -> None:
        workflow = (
            REPOSITORY_ROOT / ".github" / "workflows" / "security-validation.yml"
        ).read_text(encoding="utf-8")
        self.assertNotIn("pull_request_target", workflow)
        self.assertNotIn("write-all", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        action_references = re.findall(r"uses:\s+[^@\s]+@([^\s]+)", workflow)
        self.assertGreaterEqual(len(action_references), 2)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in action_references))

    def test_unsafe_public_mcp_template_is_absent(self) -> None:
        self.assertFalse((REPOSITORY_ROOT / "config" / "mcp-servers-template.json").exists())


if __name__ == "__main__":
    unittest.main()
