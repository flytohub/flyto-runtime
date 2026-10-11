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

REPOS = {'flyto-app', 'flyto-cloud', 'flyto-engine', 'flyto-code', 'flyto-runtime'}


def write_json(path, obj):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n')
    temp.replace(path)


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
    while True:
        data = json.loads(queue.read_text())
        tasks = data['tasks']
        pending = next((t for t in tasks if t.get('status') == 'queued'), None)
        if pending is None:
            write_json(state / 'heartbeat.json', {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'state': 'idle', 'pending': 0})
            if once:
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
        # Never run in a dirty checkout or on a non-main base; fail closed.
        if subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True).stdout.strip():
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
            with log.open('w') as output:
                outcome = subprocess.run(['codex', 'exec', '--sandbox', 'workspace-write', '-C', str(target), instruction],
                                         stdout=output, stderr=subprocess.STDOUT, timeout=7200)
            pending['status'] = 'review' if outcome.returncode == 0 else 'blocked_worker_failure'
            pending['exit_code'] = outcome.returncode
        except subprocess.TimeoutExpired:
            pending['status'] = 'blocked_timeout'
        except OSError as exc:
            pending['status'] = 'blocked_worker_unavailable'
            pending['error'] = str(exc)
        pending['finished_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        write_json(queue, data)
        if once:
            break


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', default=str(Path.home() / 'flytohub'))
    p.add_argument('--state', default=str(Path.home() / 'Library/Application Support/Flyto2 Runtime/development-controller'))
    p.add_argument('--once', action='store_true')
    args = p.parse_args()
    run(Path(args.root), Path(args.state), args.once)
