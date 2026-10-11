#!/usr/bin/env python3
"""Local controller safety regression tests; no model calls or network."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name('host-development-controller.py')
spec = importlib.util.spec_from_file_location('controller', SOURCE)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_publish_pr_flag_is_atomic_in_inbox(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            job = controller.enqueue(state, 'flyto-runtime', 'test task', [], publish_pr=True)
            payload = json.loads((state / 'inbox' / f'{job}.json').read_text())
            self.assertIs(payload['publish_pr'], True)

    def test_worker_model_override_does_not_change_user_configuration(self):
        command = controller.worker_command('/bin/codex', Path('/tmp/checkout'), 'task', 'gpt-5.5')
        self.assertEqual(command[-3:], ['--model', 'gpt-5.5', 'task'])
        self.assertIn('workspace-write', command)

    def test_worker_model_can_be_unset(self):
        command = controller.worker_command('/bin/codex', Path('/tmp/checkout'), 'task')
        self.assertNotIn('--model', command)

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

    def test_enqueue_publish_pr_cli_marks_opt_in(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            job = controller.enqueue(state, 'flyto-runtime', 'Fix a test', [])
            inbox_file = state / 'inbox' / f'{job}.json'
            task = json.loads(inbox_file.read_text())
            task['publish_pr'] = True
            controller.write_json(inbox_file, task)
            data = {'tasks': []}
            controller.write_json(state / 'tasks.json', data)
            controller.drain_inbox(state, data)
            self.assertIs(data['tasks'][0]['publish_pr'], True)

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

    def test_invalid_publish_pr_inbox_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            inbox = state / 'inbox'
            inbox.mkdir()
            controller.write_json(inbox / 'job_invalid.json', {
                'id': 'job_invalid',
                'status': 'queued',
                'repo': 'flyto-runtime',
                'prompt': 'no-op',
                'publish_pr': 'yes',
            })
            with self.assertRaises(ValueError):
                controller.drain_inbox(state, {'tasks': []})

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

    def test_publish_pull_request_requires_independent_verification(self):
        task = {'id': 'job_test', 'verification': 'worker said it passed'}
        with mock.patch.object(controller.shutil, 'which') as which:
            published, reason = controller.publish_pull_request(Path('/tmp/worktree'), task, 'auto/job_test')
        self.assertFalse(published)
        self.assertIn('not independently verified', reason)
        which.assert_not_called()

    def test_publish_pull_request_uses_gh_and_records_ci_state(self):
        task = {
            'id': 'job_test',
            'repo': 'flyto-runtime',
            'prompt': 'Implement feature',
            'checks': [['python3', '-m', 'unittest']],
            'verification': 'changes present and checks passed',
        }
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            if argv[:3] == ['git', '-C', '/tmp/worktree']:
                return controller.subprocess.CompletedProcess(argv, 0, stdout=' M scripts/file.py\n', stderr='')
            if argv[:2] == ['git', 'add']:
                return controller.subprocess.CompletedProcess(argv, 0, stdout='', stderr='')
            if argv[:2] == ['git', 'commit']:
                return controller.subprocess.CompletedProcess(argv, 0, stdout='committed\n', stderr='')
            if argv[:2] == ['git', 'push']:
                return controller.subprocess.CompletedProcess(argv, 0, stdout='pushed\n', stderr='')
            if argv[:3] == ['/usr/bin/gh', 'pr', 'create']:
                return controller.subprocess.CompletedProcess(
                    argv, 0, stdout='https://github.com/flytohub/flyto-runtime/pull/123\n', stderr='')
            if argv[:3] == ['/usr/bin/gh', 'pr', 'view']:
                return controller.subprocess.CompletedProcess(
                    argv, 0, stdout=json.dumps({'url': task['pr_url'], 'state': 'OPEN', 'statusCheckRollup': []}), stderr='')
            self.fail(f'unexpected command: {argv}')

        with mock.patch.object(controller.shutil, 'which', return_value='/usr/bin/gh'):
            with mock.patch.object(controller.subprocess, 'run', side_effect=fake_run):
                published, reason = controller.publish_pull_request(Path('/tmp/worktree'), task, 'auto/job_test')
        self.assertTrue(published)
        self.assertEqual(reason, 'pull request published')
        self.assertEqual(task['pr_url'], 'https://github.com/flytohub/flyto-runtime/pull/123')
        self.assertEqual(task['ci_state']['data']['state'], 'OPEN')
        self.assertIn('--draft', calls[4])
        self.assertEqual(calls[4][calls[4].index('--repo') + 1], 'flytohub/flyto-runtime')
        self.assertNotIn(['/usr/bin/gh', 'pr', 'merge'], [call[:3] for call in calls])
        self.assertNotIn(['/usr/bin/gh', 'workflow', 'run'], [call[:3] for call in calls])

    def test_publish_pull_request_preserves_branch_and_worktree_on_gh_error(self):
        task = {
            'id': 'job_test',
            'repo': 'flyto-runtime',
            'prompt': 'Implement feature',
            'checks': [],
            'verification': 'changes present and checks passed',
        }
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            if argv[:3] == ['git', '-C', '/tmp/worktree']:
                return controller.subprocess.CompletedProcess(argv, 0, stdout=' M scripts/file.py\n', stderr='')
            if argv[:2] in (['git', 'add'], ['git', 'commit'], ['git', 'push']):
                return controller.subprocess.CompletedProcess(argv, 0, stdout='', stderr='')
            if argv[:3] == ['/usr/bin/gh', 'pr', 'create']:
                return controller.subprocess.CompletedProcess(argv, 1, stdout='authentication required\n', stderr='')
            self.fail(f'unexpected command: {argv}')

        with mock.patch.object(controller.shutil, 'which', return_value='/usr/bin/gh'):
            with mock.patch.object(controller.subprocess, 'run', side_effect=fake_run):
                published, reason = controller.publish_pull_request(Path('/tmp/worktree'), task, 'auto/job_test')
        self.assertFalse(published)
        self.assertIn('gh pr create failed', reason)
        self.assertNotIn('pr_url', task)
        flattened = ' '.join(' '.join(call) for call in calls)
        self.assertNotIn('worktree remove', flattened)
        self.assertNotIn('branch -D', flattened)

    def test_malformed_inbox_task_rejected_without_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            inbox = state / 'inbox'
            inbox.mkdir()
            controller.write_json(state / 'tasks.json', {'tasks': []})
            (inbox / 'job_malformed.json').write_text('{"id": "job_malformed",')
            calls = []
            original_run_worker = controller.run_worker

            def fail_if_called(*args, **kwargs):
                calls.append((args, kwargs))
                raise AssertionError('worker must not run for malformed inbox task JSON')

            controller.run_worker = fail_if_called
            try:
                with self.assertRaises(SystemExit):
                    controller.run(state, state, True)
            finally:
                controller.run_worker = original_run_worker

            self.assertEqual(calls, [])
            health = json.loads((state / 'health.json').read_text())
            self.assertEqual(health['state'], 'blocked_invalid_queue')
            self.assertIn('Expecting property name', health['error'])


if __name__ == '__main__':
    unittest.main()
