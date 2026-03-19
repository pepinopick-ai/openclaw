#!/bin/bash
# Pepino Pick — NotebookLM MCP Server launcher
# Used by Claude Code MCP config

VENV="/home/roman/.venvs/notebooklm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "$VENV/bin/python3" "$SCRIPT_DIR/server.py"
