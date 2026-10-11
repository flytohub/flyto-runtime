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

REPOS = {'flyto-app', 'flyto-cloud', 'flyto-engine', 'flyto-code', 'flyto-runtime'}


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
            data = validate_queue(json.loads(queue.read_text()))
        except (ValueError, OSError, TypeError) as exc:
            write_json(state / 'health.json', {'state': 'blocked_invalid_queue', 'error': str(exc)})
            raise SystemExit('Queue invalid; refusing to run tasks') from exc
        tasks = data['tasks']
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
        instruction = ('Work only in this isolated checkout. Implement the following task and run appropriate tests. '
                       'Do not push, merge, delete worktrees, deploy, run production scans, or bypass approval gates. '
                       'If blocked, report the blocker. Task: ' + prompt)
        log = state / f'{task_id}.log'
        try:
            binary = shutil.which('codex')
            if binary is None:
                raise OSError('codex CLI not found in controller PATH')
            with log.open('w') as output:
                worker = subprocess.Popen([binary, 'exec', '--sandbox', 'workspace-write', '-C', str(target), instruction],
                                          stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    worker.wait(timeout=7200)
                except subprocess.TimeoutExpired:
                    os.killpg(worker.pid, signal.SIGTERM)
                    try:
                        worker.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(worker.pid, signal.SIGKILL)
                        worker.wait()
                    raise
            if worker.returncode == 0:
                verified, reason = verify_result(target, state, pending)
                pending['status'] = 'review' if verified else 'blocked_verification'
                pending['verification'] = reason
            else:
                pending['status'] = 'blocked_worker_failure'
            pending['exit_code'] = worker.returncode
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
    args = p.parse_args()
    run(Path(args.root), Path(args.state), args.once)
