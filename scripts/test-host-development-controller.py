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
