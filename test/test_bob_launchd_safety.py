"""Isolated lifecycle tests; no launchctl operations or live Bob access."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

FILE = Path(__file__).resolve().parents[1] / "scripts/bob_launchd_safety.py"
spec = importlib.util.spec_from_file_location("bob_launchd_safety", FILE)
safety = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safety)

class LifecycleTests(unittest.TestCase):
    def test_descendants_includes_grandchildren_not_unrelated_processes(self):
        table = {10: (1, "/usr/bin/node"), 11: (10, "/usr/bin/node"),
                 12: (11, "/usr/bin/node"), 20: (1, "/usr/bin/node")}
        self.assertEqual(safety.descendants(table, 10), {10, 11, 12})

    def test_ready_requires_stable_parent_and_child(self):
        table = {10: (1, "/opt/homebrew/bin/node"), 11: (10, "/opt/homebrew/bin/node")}
        with patch.object(safety, "job", return_value=(True, 10)), \
             patch.object(safety, "processes", return_value=table), \
             patch.object(safety.time, "sleep"), \
             patch.object(safety.time, "monotonic", side_effect=[0, 0, 1, 12, 13]):
            safety.wait_ready("gui/501", "org.newearth.mindcraft-m4", 180, stable=10)

    def test_stop_refuses_bootout_failure(self):
        table = {10: (1, "/opt/homebrew/bin/node")}
        class Result:
            returncode = 1
        with patch.object(safety, "job", return_value=(True, 10)), \
             patch.object(safety, "processes", return_value=table), \
             patch.object(safety, "runtime_pids", return_value=set()), \
             patch.object(safety, "run", return_value=Result()):
            with self.assertRaisesRegex(RuntimeError, "bootout failed"):
                safety.stop("gui/501", "org.newearth.mindcraft-m4", Path("/tmp/bob"), 1)

    def test_stop_refuses_remaining_writer(self):
        table = {10: (1, "/opt/homebrew/bin/node")}
        class Result:
            returncode = 0
        with patch.object(safety, "job", side_effect=[(True, 10), (False, None)]), \
             patch.object(safety, "processes", return_value=table), \
             patch.object(safety, "runtime_pids", return_value=set()), \
             patch.object(safety, "run", return_value=Result()), \
             patch.object(safety.time, "monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(RuntimeError, "writers remain"):
                safety.stop("gui/501", "org.newearth.mindcraft-m4", Path("/tmp/bob"), 1)

if __name__ == "__main__":
    unittest.main()
