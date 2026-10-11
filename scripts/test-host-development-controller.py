#!/usr/bin/env python3
"""Local controller safety regression tests; no model calls or network."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).with_name('host-development-controller.py')
spec = importlib.util.spec_from_file_location('controller', SOURCE)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_enqueue_durable_inbox_and_idempotent_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            job = controller.enqueue(state, 'flyto-runtime', 'Fix a test', [['python3', '-m', 'unittest']])
            data = {'tasks': []}
            controller.write_json(state / 'tasks.json', data)
            controller.drain_inbox(state, data)
            self.assertEqual(data['tasks'][0]['id'], job)
            self.assertEqual(data['tasks'][0]['checks'][0][0], 'python3')
            controller.drain_inbox(state, data)
            self.assertEqual(len(data['tasks']), 1)

    def test_enqueue_rejects_unknown_repo(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                controller.enqueue(Path(directory), '../unsafe', 'task', [])

    def test_repair_instruction_contains_feedback_and_boundaries(self):
        instruction = controller.worker_instruction('Fix widget', 'test failed')
        self.assertIn('test failed', instruction)
        self.assertIn('Do not push', instruction)
        self.assertIn('Fix widget', instruction)

    def test_empty_worktree_cannot_claim_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            import subprocess
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            good, reason = controller.verify_result(root, root, {'id': 'test'})
            self.assertFalse(good)
            self.assertIn('no verifiable', reason)

    def test_invalid_checks_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            import subprocess
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'new.txt').write_text('change')
            good, reason = controller.verify_result(root, root, {'id': 'test', 'checks': ['shell string']})
            self.assertFalse(good)
            self.assertEqual(reason, 'invalid check argv')

    def test_invalid_queue(self):
        for data in ({}, {'tasks': {}}, {'tasks': [{'id': 'duplicate'}, {'id': 'duplicate'}]}):
            with self.assertRaises(ValueError):
                controller.validate_queue(data)

    def test_interrupted_task_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            controller.write_json(state / 'tasks.json', {'tasks': [
                {'id': 'recovered', 'status': 'running', 'repo': 'flyto-runtime', 'prompt': 'no-op'}]})
            controller.run(state / 'missing-repositories', state, True)
            task = json.loads((state / 'tasks.json').read_text())['tasks'][0]
            self.assertEqual(task['status'], 'blocked_interrupted_review')

    def test_invalid_repo_blocked_without_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            controller.write_json(state / 'tasks.json', {'tasks': [
                {'id': 'invalid', 'status': 'queued', 'repo': '../outside', 'prompt': 'no-op'}]})
            controller.run(state, state, True)
            task = json.loads((state / 'tasks.json').read_text())['tasks'][0]
            self.assertEqual(task['status'], 'blocked_invalid_task')


if __name__ == '__main__':
    unittest.main()
