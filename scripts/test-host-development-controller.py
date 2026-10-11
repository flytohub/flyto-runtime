#!/usr/bin/env python3
"""Local controller safety regression tests; no model calls or network."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name('host-development-controller.py')
spec = importlib.util.spec_from_file_location('controller', SOURCE)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_corrupt_startup_queue_writes_health_and_never_starts_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'tasks.json').write_text('{broken')
            with mock.patch.object(controller, 'run_worker') as worker:
                with self.assertRaises(SystemExit):
                    controller.run(state, state, True)
            worker.assert_not_called()
            health = json.loads((state / 'health.json').read_text())
            self.assertEqual(health['state'], 'blocked_invalid_queue')

    def test_pending_ci_does_not_starve_independent_queued_work(self):
        self.assertFalse(controller.wait_for_ci_before_next_task('pending', True))
        self.assertTrue(controller.wait_for_ci_before_next_task('pending', False))
        self.assertTrue(controller.wait_for_ci_before_next_task('blocked', True))

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

    def test_pr_ci_success_waits_for_review_without_merge_or_deploy(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            worktree = Path(directory) / 'worktree'
            state.mkdir()
            worktree.mkdir()
            task = {
                'id': 'job_ci_success',
                'repo': 'flyto-runtime',
                'prompt': 'fix',
                'status': 'published_pr',
                'worktree': str(worktree),
                'pr_url': 'https://github.com/flytohub/flyto-runtime/pull/1',
            }
            calls = []
            original_run = controller.subprocess.run

            def fake_run(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv[:3], ['gh', 'pr', 'checks'])
                return SimpleNamespace(returncode=0, stdout=json.dumps([
                    {'name': 'test', 'state': 'SUCCESS', 'conclusion': 'success', 'link': 'https://ci.example/test'},
                    {'name': 'lint', 'state': 'SUCCESS', 'conclusion': 'skipped'},
                ]))

            controller.subprocess.run = fake_run
            try:
                result = controller.poll_pr_ci(worktree, state, task)
            finally:
                controller.subprocess.run = original_run

            self.assertEqual(result, 'passed')
            self.assertEqual(task['status'], 'review_ci_passed')
            self.assertIn('No merge or deploy', task['ci_summary'])
            self.assertEqual(len(calls), 1)
            command_text = ' '.join(calls[0])
            self.assertNotIn('merge', command_text)
            self.assertNotIn('deploy', command_text)
            ci_log = json.loads(Path(task['ci_log']).read_text())
            self.assertEqual(ci_log['status'], 'review_ci_passed')

    def test_pr_ci_failure_is_blocked_with_logs_and_repair_context(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            worktree = Path(directory) / 'worktree'
            state.mkdir()
            worktree.mkdir()
            task = {
                'id': 'job_ci_failure',
                'repo': 'flyto-runtime',
                'prompt': 'fix',
                'status': 'published_pr',
                'worktree': str(worktree),
                'pr_number': 12,
            }
            original_run = controller.subprocess.run

            def fake_run(argv, **kwargs):
                return SimpleNamespace(returncode=0, stdout=json.dumps([
                    {'name': 'test', 'state': 'FAILURE', 'conclusion': 'failure', 'link': 'https://ci.example/test'},
                    {'name': 'lint', 'state': 'SUCCESS', 'conclusion': 'success'},
                ]))

            controller.subprocess.run = fake_run
            try:
                result = controller.poll_pr_ci(worktree, state, task)
            finally:
                controller.subprocess.run = original_run

            self.assertEqual(result, 'blocked')
            self.assertEqual(task['status'], 'blocked_ci_failed')
            self.assertIn('bounded', task['ci_repair_context'])
            ci_log = json.loads(Path(task['ci_log']).read_text())
            self.assertEqual(ci_log['failed_checks'][0]['name'], 'test')
            self.assertEqual(ci_log['task']['prompt'], 'fix')

    def test_pr_ci_pending_remains_bounded_polling(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            worktree = Path(directory) / 'worktree'
            state.mkdir()
            worktree.mkdir()
            task = {
                'id': 'job_ci_pending',
                'repo': 'flyto-runtime',
                'status': 'published_pr',
                'worktree': str(worktree),
                'pr': '13',
            }
            original_run = controller.subprocess.run

            def fake_run(argv, **kwargs):
                return SimpleNamespace(returncode=0, stdout=json.dumps([
                    {'name': 'test', 'state': 'PENDING', 'conclusion': None},
                ]))

            controller.subprocess.run = fake_run
            try:
                result = controller.poll_pr_ci(worktree, state, task)
            finally:
                controller.subprocess.run = original_run

            self.assertEqual(result, 'pending')
            self.assertEqual(task['status'], 'ci_polling')
            self.assertEqual(task['ci_checks_pending'], 1)
            self.assertNotIn('ci_log', task)

    def test_pr_ci_timeout_fails_closed_before_polling_gh(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            worktree = Path(directory) / 'worktree'
            state.mkdir()
            worktree.mkdir()
            task = {
                'id': 'job_ci_timeout',
                'status': 'ci_polling',
                'worktree': str(worktree),
                'pr': '14',
                'ci_poll_started_at': '2026-01-01T00:00:00+00:00',
                'ci_timeout_seconds': 60,
            }
            calls = []
            original_run = controller.subprocess.run

            def fake_run(argv, **kwargs):
                calls.append(argv)
                raise AssertionError('gh must not run after CI polling timeout')

            controller.subprocess.run = fake_run
            try:
                result = controller.poll_pr_ci(worktree, state, task)
            finally:
                controller.subprocess.run = original_run

            self.assertEqual(result, 'blocked')
            self.assertEqual(task['status'], 'blocked_ci_timeout')
            self.assertEqual(calls, [])
            self.assertTrue(Path(task['ci_log']).exists())

    def test_pr_ci_cli_failure_fails_closed_with_output(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state'
            worktree = Path(directory) / 'worktree'
            state.mkdir()
            worktree.mkdir()
            task = {
                'id': 'job_ci_cli',
                'repo': 'flyto-runtime',
                'status': 'published_pr',
                'worktree': str(worktree),
                'pr': '15',
            }
            original_run = controller.subprocess.run

            def fake_run(argv, **kwargs):
                raise subprocess.TimeoutExpired(argv, 60, output='still waiting')

            controller.subprocess.run = fake_run
            try:
                result = controller.poll_pr_ci(worktree, state, task)
            finally:
                controller.subprocess.run = original_run

            self.assertEqual(result, 'blocked')
            self.assertEqual(task['status'], 'blocked_ci_poll_error')
            self.assertIn('CI polling failed', task['ci_summary'])
            self.assertTrue(Path(task['ci_log']).exists())

    def test_run_polls_published_pr_before_new_queued_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root'
            state = Path(directory) / 'state'
            worktree = Path(directory) / 'worktree'
            (root / 'flyto-runtime').mkdir(parents=True)
            state.mkdir()
            worktree.mkdir()
            controller.write_json(state / 'tasks.json', {'tasks': [
                {
                    'id': 'job_ci_first',
                    'repo': 'flyto-runtime',
                    'prompt': 'fix',
                    'status': 'published_pr',
                    'worktree': str(worktree),
                    'pr': '16',
                },
                {
                    'id': 'job_queued',
                    'repo': 'flyto-runtime',
                    'prompt': 'do not start yet',
                    'status': 'queued',
                },
            ]})
            original_run = controller.subprocess.run
            original_run_worker = controller.run_worker

            def fake_run(argv, **kwargs):
                self.assertEqual(argv[:3], ['gh', 'pr', 'checks'])
                return SimpleNamespace(returncode=0, stdout=json.dumps([
                    {'name': 'test', 'state': 'SUCCESS', 'conclusion': 'success'},
                ]))

            def fail_worker(*args, **kwargs):
                raise AssertionError('queued work must not start while PR CI is being reconciled')

            controller.subprocess.run = fake_run
            controller.run_worker = fail_worker
            try:
                controller.run(root, state, True)
            finally:
                controller.subprocess.run = original_run
                controller.run_worker = original_run_worker

            tasks = json.loads((state / 'tasks.json').read_text())['tasks']
            self.assertEqual(tasks[0]['status'], 'review_ci_passed')
            self.assertEqual(tasks[1]['status'], 'queued')


if __name__ == '__main__':
    unittest.main()
