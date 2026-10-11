#!/usr/bin/env python3
"""Read-only Flyto2 worktree inventory. Never removes or merges work."""
import argparse
import datetime
import json
import pathlib
import subprocess

PROJECTS = ('flyto-app', 'flyto-cloud', 'flyto-engine', 'flyto-code', 'flyto-runtime')


def git(directory, *args):
    result = subprocess.run(['git', '-C', str(directory), *args], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError(f'{directory}: git {args[0]} failed: {result.stderr.strip()}')
    return result.stdout


def inspect(repo):
    blocks = git(repo, 'worktree', 'list', '--porcelain').strip().split('\n\n')
    worktrees = []
    for block in blocks:
        fields = {}
        for line in block.splitlines():
            key, _, value = line.partition(' ')
            fields[key] = value
        path = pathlib.Path(fields['worktree'])
        changes = git(path, 'status', '--porcelain', '--untracked-files=normal').splitlines()
        sha = git(path, 'rev-parse', 'HEAD').strip()
        branch = fields.get('branch', '').removeprefix('refs/heads/') or None
        merged = bool(branch and git(repo, 'branch', '--merged', 'main', '--format=%(refname:short)').splitlines().count(branch))
        worktrees.append({'path': str(path), 'branch': branch, 'sha': sha,
                          'dirty_files': len(changes), 'merged_into_main': merged,
                          'status': 'REVIEW_DIRTY' if changes else ('REVIEW_DETACHED' if not branch else ('MERGED_CANDIDATE' if merged and branch != 'main' else 'TRACKED')),
                          'sample_changes': changes[:8]})
    return {'repository': repo.name, 'worktrees': worktrees}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(pathlib.Path.home() / 'flytohub'))
    parser.add_argument('--output', help='Optional JSON snapshot file; never changes Git state')
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    result = {'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'root': str(root), 'projects': [], 'errors': []}
    for name in PROJECTS:
        try:
            result['projects'].append(inspect(root / name))
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            result['errors'].append({'project': name, 'error': str(exc)})
    payload = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        pathlib.Path(args.output).write_text(payload, encoding='utf-8')
    else:
        print(payload, end='')
    return int(bool(result['errors']))


if __name__ == '__main__':
    raise SystemExit(main())
