#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/Flyto2 Runtime.command" install
