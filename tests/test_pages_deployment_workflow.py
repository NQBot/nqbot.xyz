from __future__ import annotations

import re
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "deploy-pages.yml"
SNAPSHOTS = {
    "scoreboard_snapshot.json",
    "scoreboard_state_snapshot.json",
    "account_daily_pnl_snapshot.json",
    "account_pnl_history_snapshot.json",
    "eval_arena_snapshot.json",
}


class PagesDeploymentWorkflowTests(unittest.TestCase):
    def test_trusted_triggers_and_job_scoped_permissions(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("pull_request", workflow)
        self.assertNotIn("repository_dispatch", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertIn("permissions: {}", workflow)
        self.assertIn("build:\n    runs-on: ubuntu-24.04", workflow)
        self.assertIn("permissions:\n      contents: read", workflow)
        self.assertIn("deploy:\n    needs: build", workflow)
        self.assertIn("pages: write\n      id-token: write", workflow)

    def test_code_and_data_are_checked_out_from_fixed_branches(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("ref: main", workflow)
        self.assertIn("ref: snapshots", workflow)
        self.assertEqual(workflow.count("persist-credentials: false"), 2)
        for snapshot in SNAPSHOTS:
            self.assertGreaterEqual(workflow.count(snapshot), 1)
        self.assertIn("scripts/copy_public_snapshots.py", workflow)

    def test_actions_are_immutably_pinned_and_validation_precedes_upload(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        action_references = re.findall(r"uses:\s+[^@\s]+@([^\s]+)", workflow)
        self.assertEqual(len(action_references), 6)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in action_references))
        self.assertLess(workflow.index("Run Python security tests"), workflow.index("Upload validated Pages artifact"))
        self.assertLess(workflow.index("Validate assembled public site"), workflow.index("Upload validated Pages artifact"))
        self.assertIn("for script in site/*.js", workflow)


if __name__ == "__main__":
    unittest.main()
