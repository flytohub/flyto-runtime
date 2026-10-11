#!/usr/bin/env python3
"""Opt-in host-owned development queue; does not advance Runtime background_task."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import signal
import shutil
import sys
import uuid

REPOS = {'flyto-app', 'flyto-cloud', 'flyto-engine', 'flyto-code', 'flyto-runtime'}
CI_POLL_STATUSES = {'published_pr', 'ci_polling'}
CI_PASSING = {'pass', 'passing', 'success', 'successful', 'skipped', 'neutral'}
CI_FAILING = {'fail', 'failed', 'failing', 'failure', 'error', 'cancelled', 'canceled', 'timed_out', 'action_required'}
CI_PENDING = {'pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected'}
DEFAULT_CI_TIMEOUT_SECONDS = 30 * 60
MAX_CI_TIMEOUT_SECONDS = 2 * 60 * 60
DEFAULT_CI_MAX_POLLS = 60
MAX_CI_MAX_POLLS = 240


def write_json(path, obj):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n')
    temp.replace(path)


def validate_queue(data):
    if not isinstance(data, dict) or not isinstance(data.get('tasks'), list):
        raise ValueError('tasks must be a list')
    ids = [t.get('id') for t in data['tasks'] if isinstance(t, dict)]
    if len(ids) != len(data['tasks']) or len(ids) != len(set(ids)):
        raise ValueError('tasks must be objects with unique IDs')
    return data


def enqueue(state, repo, prompt, checks, publish_pr=False):
    if repo not in REPOS or not prompt.strip():
        raise ValueError('valid repository and nonempty task required')
    if any(not check or len(check) > 12 for check in checks):
        raise ValueError('invalid check command')
    inbox = state / 'inbox'
    inbox.mkdir(parents=True, exist_ok=True)
    task_id = 'job_' + uuid.uuid4().hex
    task = {'id': task_id, 'repo': repo, 'prompt': prompt, 'status': 'queued', 'checks': checks, 'publish_pr': publish_pr}
    write_json(inbox / f'{task_id}.json', task)
    return task_id


def format_pr_body(task):
    checks = task.get('checks', [])
    check_lines = '\n'.join(f"- `{' '.join(check)}`" for check in checks) if checks else '- No extra checks requested.'
    return (
        'Automated development-controller publication after independent local verification.\n\n'
        f"Task: {task.get('prompt', '').strip()}\n\n"
        'Verification:\n'
        f"- {task.get('verification', 'not recorded')}\n"
        f"{check_lines}\n\n"
        'Safety:\n'
        '- Draft pull request only.\n'
        '- No auto-merge, deployment, release, or production scan was requested.\n'
    )


def run_checked(argv, cwd, timeout=900):
    try:
        result = subprocess.run(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, str(exc)
    if result.returncode:
        return None, result.stdout[-2000:]
    return result, None


def read_ci_state(gh, checkout, pr_url):
    result = subprocess.run([gh, 'pr', 'view', pr_url, '--json', 'url,state,statusCheckRollup'],
                            cwd=checkout, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, timeout=120)
    ci_state = {'command': 'gh pr view', 'exit_code': result.returncode}
    if result.returncode == 0:
        try:
            ci_state['data'] = json.loads(result.stdout or '{}')
        except json.JSONDecodeError:
            ci_state['raw'] = result.stdout[-4000:]
    else:
        ci_state['error'] = result.stdout[-4000:]
    return ci_state


def publish_pull_request(checkout, task, branch):
    """Publish only after independent verification; leave branch/worktree intact on failure."""
    if task.get('verification') != 'changes present and checks passed':
        return False, 'task is not independently verified'
    gh = shutil.which('gh')
    if gh is None:
        return False, 'gh CLI not found in controller PATH'
    status = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True)
    if status.returncode:
        return False, 'could not inspect worktree before PR publication'
    if status.stdout.strip():
        result, error = run_checked(['git', 'add', '--all'], checkout)
        if error:
            return False, f'git add failed: {error}'
        title = task.get('pr_title') or f"chore: development controller task {task.get('id')}"
        result, error = run_checked(['git', 'commit', '-m', title], checkout)
        if error:
            return False, f'git commit failed: {error}'
    result, error = run_checked(['git', 'push', '--set-upstream', 'origin', branch], checkout, timeout=900)
    if error:
        return False, f'git push failed: {error}'
    title = task.get('pr_title') or f"chore: development controller task {task.get('id')}"
    body = format_pr_body(task)
    result, error = run_checked([gh, 'pr', 'create', '--repo', f"flytohub/{task['repo']}",
                                 '--draft', '--base', 'main', '--head', branch,
                                 '--title', title, '--body', body], checkout, timeout=300)
    if error:
        return False, f'gh pr create failed: {error}'
    pr_url = (result.stdout or '').strip().splitlines()[-1].strip()
    if not pr_url.startswith('https://github.com/'):
        return False, 'gh pr create did not return a GitHub PR URL'
    task['pr_url'] = pr_url
    task['ci_state'] = read_ci_state(gh, checkout, pr_url)
    return True, 'pull request published'


def drain_inbox(state, data):
    inbox = state / 'inbox'
    known = {task['id'] for task in data['tasks']}
    for file in sorted(inbox.glob('job_*.json')) if inbox.exists() else []:
        task = json.loads(file.read_text())
        if task.get('id') != file.stem or task.get('repo') not in REPOS or not isinstance(task.get('prompt'), str):
            raise ValueError(f'invalid inbox task {file.name}')
        if 'publish_pr' in task and type(task.get('publish_pr')) is not bool:
            raise ValueError(f'invalid inbox task {file.name}')
        if task['id'] not in known:
            data['tasks'].append(task)
            known.add(task['id'])
            write_json(state / 'tasks.json', data)
        file.unlink()
    return data


def verify_result(checkout, state, task):
    """Independent bounded checks; never mistake a worker's prose for proof."""
    changed = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True)
    if changed.returncode or not changed.stdout.strip():
        return False, 'no verifiable working-tree changes'
    checks = task.get('checks', [])
    if not isinstance(checks, list) or len(checks) > 8:
        return False, 'invalid checks'
    for check in checks:
        if not isinstance(check, list) or not check or len(check) > 12 or not all(isinstance(x, str) and x for x in check):
            return False, 'invalid check argv'
        try:
            result = subprocess.run(check, cwd=checkout, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, timeout=900)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, f'check failed: {exc}'
        if result.returncode:
            (state / f"{task['id']}.verification.log").write_text(result.stdout[-20000:])
            return False, f'check returned {result.returncode}: {check[0]}'
    return True, 'changes present and checks passed'


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def bounded_int(value, default, minimum, maximum):
    if type(value) is not int:
        return default
    return max(minimum, min(maximum, value))


def task_pr_reference(task):
    value = task.get('pr_url') or task.get('pr_number') or task.get('pr')
    if type(value) is int:
        return str(value)
    if isinstance(value, str) and value.strip() and len(value.strip()) <= 256 and not value.strip().startswith('-'):
        return value.strip()
    return None


def ci_log_path(state, task):
    return state / f"{task['id']}.ci.log"


def write_ci_log(state, task, payload):
    path = ci_log_path(state, task)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + '\n')
    task['ci_log'] = str(path)
    return path


def check_status_value(check):
    values = []
    for key in ('conclusion', 'state', 'bucket'):
        value = check.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value.strip().lower())
    if any(value in CI_FAILING for value in values):
        return 'failed'
    if any(value in CI_PENDING for value in values) or not values:
        return 'pending'
    if any(value in CI_PASSING for value in values):
        return 'passed'
    return 'pending'


def summarize_failed_checks(checks):
    failed = []
    for check in checks:
        if not isinstance(check, dict) or check_status_value(check) != 'failed':
            continue
        failed.append({
            'name': check.get('name') or check.get('workflow') or 'unnamed check',
            'state': check.get('state'),
            'conclusion': check.get('conclusion'),
            'link': check.get('link') or check.get('url'),
        })
    return failed


def poll_pr_ci(checkout, state, task):
    """Bounded post-PR CI observation; never merges, deploys, or claims task success."""
    task_id = task.get('id')
    pr_ref = task_pr_reference(task)
    if not isinstance(task_id, str) or not task_id.isidentifier():
        task['status'] = 'blocked_invalid_task'
        return 'blocked'
    if not pr_ref:
        task['status'] = 'blocked_missing_pr'
        task['ci_repair_context'] = 'PR publication was recorded without a usable pr_url/pr_number.'
        return 'blocked'
    target = Path(task.get('worktree') or checkout)
    if not target.is_dir():
        task['status'] = 'blocked_missing_worktree'
        task['ci_repair_context'] = 'CI cannot be inspected because the task worktree is missing.'
        return 'blocked'

    now = now_iso()
    if task.get('status') == 'published_pr' or not task.get('ci_poll_started_at'):
        task['ci_poll_started_at'] = now
    task['status'] = 'ci_polling'
    task['ci_poll_attempts'] = bounded_int(task.get('ci_poll_attempts'), 0, 0, MAX_CI_MAX_POLLS) + 1
    task['ci_last_polled_at'] = now

    max_polls = bounded_int(task.get('ci_max_polls'), DEFAULT_CI_MAX_POLLS, 1, MAX_CI_MAX_POLLS)
    timeout_seconds = bounded_int(task.get('ci_timeout_seconds'), DEFAULT_CI_TIMEOUT_SECONDS, 60, MAX_CI_TIMEOUT_SECONDS)
    try:
        started = dt.datetime.fromisoformat(str(task['ci_poll_started_at']))
    except ValueError:
        started = dt.datetime.now(dt.timezone.utc)
        task['ci_poll_started_at'] = started.isoformat()
    elapsed = (dt.datetime.now(dt.timezone.utc) - started).total_seconds()
    if task['ci_poll_attempts'] > max_polls or elapsed > timeout_seconds:
        task['status'] = 'blocked_ci_timeout'
        task['ci_summary'] = 'CI did not reach a passing terminal state within the bounded polling window.'
        task['ci_repair_context'] = 'Preserve the PR, worktree, task prompt, and CI log; repair only after explicit review.'
        write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'elapsed_seconds': elapsed, 'task': task})
        return 'blocked'

    try:
        result = subprocess.run(['gh', 'pr', 'checks', pr_ref, '--repo', f"flytohub/{task['repo']}", '--json',
                                 'name,state,link,workflow,bucket,startedAt,completedAt'],
                                cwd=target, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        task['status'] = 'blocked_ci_poll_error'
        task['ci_summary'] = f'CI polling failed: {exc}'
        task['ci_repair_context'] = 'gh CLI polling failed after PR publication; inspect task context before any repair.'
        write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'error': str(exc), 'task': task})
        return 'blocked'

    output = result.stdout or ''
    if result.returncode not in (0, 8):
        task['status'] = 'blocked_ci_poll_error'
        task['ci_summary'] = f'gh pr checks returned {result.returncode}'
        task['ci_repair_context'] = 'gh CLI could not read PR checks; preserve state and inspect auth/repo/PR context.'
        write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'gh_output': output[-20000:], 'task': task})
        return 'blocked'
    try:
        checks = json.loads(output)
    except json.JSONDecodeError as exc:
        task['status'] = 'blocked_ci_poll_error'
        task['ci_summary'] = f'gh pr checks returned invalid JSON: {exc}'
        task['ci_repair_context'] = 'Preserve gh output and task context; do not treat unparsable CI as success.'
        write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'gh_output': output[-20000:], 'task': task})
        return 'blocked'
    if not isinstance(checks, list) or not checks:
        task['status'] = 'blocked_ci_no_checks'
        task['ci_summary'] = 'PR has no readable CI checks; refusing to claim success.'
        task['ci_repair_context'] = 'Confirm CI configuration or GitHub permissions before manual review.'
        write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'checks': checks, 'task': task})
        return 'blocked'

    statuses = [check_status_value(check) if isinstance(check, dict) else 'pending' for check in checks]
    task['ci_checks_total'] = len(checks)
    task['ci_checks_pending'] = statuses.count('pending')
    task['ci_checks_failed'] = statuses.count('failed')
    if task['ci_checks_failed']:
        failed = summarize_failed_checks(checks)
        task['status'] = 'blocked_ci_failed'
        task['ci_summary'] = f"{task['ci_checks_failed']} CI check(s) failed after PR publication."
        task['ci_failed_checks'] = failed
        task['ci_repair_context'] = 'Repair is bounded to the existing PR/worktree; never auto-merge or deploy.'
        write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'failed_checks': failed,
                                   'checks': checks, 'task': task})
        return 'blocked'
    if task['ci_checks_pending']:
        task['ci_summary'] = f"{task['ci_checks_pending']} CI check(s) still pending."
        return 'pending'

    task['status'] = 'review_ci_passed'
    task['ci_summary'] = 'All readable PR CI checks passed; awaiting human review. No merge or deploy was attempted.'
    task['ci_finished_at'] = now_iso()
    write_ci_log(state, task, {'pr': pr_ref, 'status': task['status'], 'checks': checks, 'task': task})
    return 'passed'


def wait_for_ci_before_next_task(ci_outcome, has_queued_work):
    """Do not starve independent queued work while GitHub checks are pending."""
    return ci_outcome != 'pending' or not has_queued_work


def worker_instruction(prompt, feedback=None):
    policy = ('Work only in this isolated checkout. Implement the task and run appropriate tests. '
              'Do not push, merge, delete worktrees, deploy, run production scans, or bypass approval gates. '
              'If blocked, report the blocker. Task: ' + prompt)
    if feedback:
        policy += '\nIndependent verification failed; fix the implementation, preserve previous changes: ' + feedback
    return policy


def worker_command(binary, target, instruction, model=None):
    argv = [binary, 'exec', '--sandbox', 'workspace-write', '-C', str(target)]
    if model:
        argv.extend(['--model', model])
    return argv + [instruction]


def run_worker(target, log, instruction, timeout=7200):
    binary = shutil.which('codex')
    if binary is None:
        raise OSError('codex CLI not found in controller PATH')
    with log.open('a') as output:
        worker = subprocess.Popen(worker_command(binary, target, instruction,
                                                os.environ.get('FLYTO2_DEV_MODEL', 'gpt-5.5')),
                                  stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            worker.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(worker.pid, signal.SIGTERM)
            try:
                worker.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(worker.pid, signal.SIGKILL)
                worker.wait()
            raise
    return worker.returncode


def run(root, state, once):
    state.mkdir(parents=True, exist_ok=True)
    lock = (state / 'controller.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Another development controller owns the queue')
    queue = state / 'tasks.json'
    if not queue.exists():
        write_json(queue, {'tasks': []})
    # A dead controller cannot prove whether its worker committed side effects.
    # Preserve the worktree and require review rather than replaying the prompt.
    initial = validate_queue(json.loads(queue.read_text()))
    for task in initial['tasks']:
        if task.get('status') == 'running':
            task['status'] = 'blocked_interrupted_review'
            task['recovery_note'] = 'Inspect worktree, logs and external effects before explicit requeue.'
    write_json(queue, initial)
    while True:
        try:
            data = drain_inbox(state, validate_queue(json.loads(queue.read_text())))
        except (ValueError, OSError, TypeError) as exc:
            write_json(state / 'health.json', {'state': 'blocked_invalid_queue', 'error': str(exc)})
            lock.close()
            raise SystemExit('Queue invalid; refusing to run tasks') from exc
        tasks = data['tasks']
        ci_task = next((t for t in tasks if t.get('status') in CI_POLL_STATUSES), None)
        if ci_task is not None:
            repo = ci_task.get('repo')
            checkout = root / repo if repo in REPOS else root
            ci_outcome = poll_pr_ci(checkout, state, ci_task)
            write_json(queue, data)
            if once:
                lock.close()
                break
            if wait_for_ci_before_next_task(ci_outcome, any(t.get('status') == 'queued' for t in tasks)):
                time.sleep(30)
                continue
        pending = next((t for t in tasks if t.get('status') == 'queued'), None)
        if pending is None:
            write_json(state / 'heartbeat.json', {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'state': 'idle', 'pending': 0})
            if once:
                lock.close()
                break
            time.sleep(30)
            continue
        repo = pending.get('repo')
        task_id = pending.get('id')
        prompt = pending.get('prompt')
        if repo not in REPOS or not isinstance(task_id, str) or not task_id.isidentifier() or not isinstance(prompt, str) or not prompt.strip():
            pending['status'] = 'blocked_invalid_task'
            write_json(queue, data)
            continue
        checkout = root / repo
        if not checkout.is_dir():
            pending['status'] = 'blocked_missing_checkout'
            write_json(queue, data)
            continue
        # Never run in a dirty checkout or on a non-main base; fail closed.
        clean = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True)
        if clean.returncode != 0 or clean.stdout.strip():
            pending['status'] = 'blocked_dirty_checkout'
            write_json(queue, data)
            continue
        branch = f'auto/{task_id}'
        existing = subprocess.run(['git', '-C', str(checkout), 'branch', '--list', branch], capture_output=True, text=True)
        if existing.stdout.strip():
            pending['status'] = 'blocked_existing_branch'
            write_json(queue, data)
            continue
        target = state / 'worktrees' / f'{repo}-{task_id}'
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            pending['status'] = 'blocked_existing_worktree'
            write_json(queue, data)
            continue
        result = subprocess.run(['git', '-C', str(checkout), 'worktree', 'add', '-b', branch, str(target), 'main'], capture_output=True, text=True)
        if result.returncode:
            pending['status'] = 'blocked_worktree_creation'
            pending['error'] = result.stderr[-500:]
            write_json(queue, data)
            continue
        pending.update(status='running', worktree=str(target), started_at=dt.datetime.now(dt.timezone.utc).isoformat())
        write_json(queue, data)
        log = state / f'{task_id}.log'
        try:
            max_attempts = pending.get('max_attempts', 2)
            if type(max_attempts) is not int or not 1 <= max_attempts <= 3:
                max_attempts = 1
            feedback = None
            for attempt in range(1, max_attempts + 1):
                pending['attempts'] = attempt
                write_json(queue, data)
                exit_code = run_worker(target, log, worker_instruction(prompt, feedback))
                pending['exit_code'] = exit_code
                if exit_code == 0:
                    verified, reason = verify_result(target, state, pending)
                    pending['verification'] = reason
                    if verified:
                        if pending.get('publish_pr') is True:
                            published, publish_reason = publish_pull_request(target, pending, branch)
                            pending['publication'] = publish_reason
                            pending['status'] = 'published_pr' if published else 'blocked_pr_publication'
                        else:
                            pending['status'] = 'review'
                        break
                    feedback = reason
                    pending['status'] = 'blocked_verification'
                else:
                    feedback = f'worker exited with code {exit_code}; inspect prior changes and log'
                    pending['status'] = 'blocked_worker_failure'
                write_json(queue, data)
                if attempt < max_attempts:
                    pending['status'] = 'running'
                    write_json(queue, data)
        except subprocess.TimeoutExpired:
            pending['status'] = 'blocked_timeout'
        except OSError as exc:
            pending['status'] = 'blocked_worker_unavailable'
            pending['error'] = str(exc)
        pending['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        pending['log'] = str(log)
        write_json(queue, data)
        if once:
            break
    lock.close()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', default=str(Path.home() / 'flytohub'))
    p.add_argument('--state', default=str(Path.home() / 'Library/Application Support/Flyto2 Runtime/development-controller'))
    p.add_argument('--once', action='store_true')
    p.add_argument('--enqueue', choices=sorted(REPOS))
    p.add_argument('--prompt')
    p.add_argument('--check', action='append', default=[], help='JSON argv array for an independent verification command')
    p.add_argument('--publish-pr', action='store_true', help='after independent verification, publish a draft GitHub PR with gh CLI')
    args = p.parse_args()
    if args.enqueue:
        try:
            checks = [json.loads(item) for item in args.check]
            if any(not isinstance(c, list) or not all(isinstance(v, str) and v for v in c) for c in checks):
                raise ValueError('checks must be arrays of nonempty strings')
            print(enqueue(Path(args.state), args.enqueue, args.prompt or '', checks, args.publish_pr))
        except (ValueError, TypeError) as exc:
            p.error(str(exc))
    else:
        run(Path(args.root), Path(args.state), args.once)
