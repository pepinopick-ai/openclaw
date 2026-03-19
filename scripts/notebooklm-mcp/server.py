#!/usr/bin/env python3
"""
Pepino Pick — NotebookLM MCP Server
Wraps notebooklm-py as an MCP server for Claude Code.

Usage:
  python3 server.py

Auth setup (one-time):
  1. On Windows: pip install notebooklm-py[browser] && notebooklm login
  2. Copy C:\\Users\\Roman\\.notebooklm\\storage_state.json
     to /home/roman/.notebooklm/storage_state.json on server
  3. Start this server, Claude Code connects automatically

Tools exposed:
  nblm_list_notebooks   - List all notebooks
  nblm_create_notebook  - Create new notebook
  nblm_ask              - Ask question to current/specified notebook
  nblm_add_source_url   - Add URL as source
  nblm_add_source_text  - Add raw text as source
  nblm_list_sources     - List sources in notebook
  nblm_get_summary      - Get AI summary of notebook
  nblm_use_notebook     - Switch active notebook context
  nblm_create_note      - Save info as a note in notebook
  nblm_generate_brief   - Generate full research brief (multi-question)
"""

import asyncio
import json
import os
import sys
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

# ─────────────────────────────────────────────
# Server setup
# ─────────────────────────────────────────────
server = Server("notebooklm-pepino")

# Shared client (lazy init)
_client = None
_current_notebook_id: str | None = None


async def get_client():
    global _client
    if _client is None:
        try:
            from notebooklm import NotebookLMClient
            _client = await NotebookLMClient.from_storage().__aenter__()
        except Exception as e:
            raise RuntimeError(
                f"Failed to init NotebookLM client: {e}\n"
                f"Run auth setup: see server.py docstring"
            )
    return _client


# ─────────────────────────────────────────────
# Tool definitions
# ─────────────────────────────────────────────
@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="nblm_list_notebooks",
            description=(
                "List all NotebookLM notebooks in your account. "
                "Returns notebook IDs, titles, and source counts."
            ),
            inputSchema={
                "type": "object",
                "properties": {},
                "required": [],
            },
        ),
        types.Tool(
            name="nblm_use_notebook",
            description=(
                "Set the active notebook for subsequent questions. "
                "Accepts notebook_id (full or partial) or title substring."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID or partial title to match",
                    }
                },
                "required": ["notebook_id"],
            },
        ),
        types.Tool(
            name="nblm_create_notebook",
            description="Create a new NotebookLM notebook with a given title.",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Notebook title (e.g. 'Market Intel - Restaurantes BA 2026')",
                    }
                },
                "required": ["title"],
            },
        ),
        types.Tool(
            name="nblm_ask",
            description=(
                "Ask a question to the current (or specified) NotebookLM notebook. "
                "Returns zero-hallucination answer grounded in notebook sources. "
                "Use for: research questions, market analysis, SOP lookups, due diligence."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "Question to ask",
                    },
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    },
                },
                "required": ["question"],
            },
        ),
        types.Tool(
            name="nblm_add_source_url",
            description=(
                "Add a URL as a source to a NotebookLM notebook. "
                "Supports web pages, YouTube videos, and Google Docs/Slides."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL to add as source",
                    },
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    },
                },
                "required": ["url"],
            },
        ),
        types.Tool(
            name="nblm_add_source_text",
            description=(
                "Add raw text as a source to a NotebookLM notebook. "
                "Use for: pasting documents, adding structured data, knowledge dumps."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Text content to add as source",
                    },
                    "title": {
                        "type": "string",
                        "description": "Source title",
                    },
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    },
                },
                "required": ["text", "title"],
            },
        ),
        types.Tool(
            name="nblm_list_sources",
            description="List all sources in the current or specified notebook.",
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    }
                },
                "required": [],
            },
        ),
        types.Tool(
            name="nblm_get_summary",
            description=(
                "Get an AI-generated summary and key insights for a notebook. "
                "Returns overview of all sources combined."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    }
                },
                "required": [],
            },
        ),
        types.Tool(
            name="nblm_create_note",
            description=(
                "Save a note in a NotebookLM notebook. "
                "Use to persist findings, summaries, or decisions inside the notebook."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Note title",
                    },
                    "content": {
                        "type": "string",
                        "description": "Note content (markdown supported)",
                    },
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    },
                },
                "required": ["title", "content"],
            },
        ),
        types.Tool(
            name="nblm_generate_brief",
            description=(
                "Generate a comprehensive research brief by asking multiple questions "
                "to a notebook in sequence. Returns synthesized report. "
                "Use for: market research, supplier due diligence, competitive analysis."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Research topic/title for the brief",
                    },
                    "questions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of questions to ask in sequence (3-7 recommended)",
                    },
                    "notebook_id": {
                        "type": "string",
                        "description": "Notebook ID (optional, uses current if not set)",
                    },
                },
                "required": ["topic", "questions"],
            },
        ),
    ]


# ─────────────────────────────────────────────
# Tool handlers
# ─────────────────────────────────────────────
@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
    global _current_notebook_id

    try:
        client = await get_client()
    except RuntimeError as e:
        return [types.TextContent(type="text", text=f"❌ Auth error: {e}")]

    try:
        # ── nblm_list_notebooks ──────────────────────
        if name == "nblm_list_notebooks":
            notebooks = await client.notebooks.list()
            if not notebooks:
                return [types.TextContent(type="text", text="No notebooks found.")]
            lines = ["📚 **NotebookLM Notebooks:**\n"]
            for nb in notebooks:
                active = " ← active" if nb.id == _current_notebook_id else ""
                source_count = len(nb.sources) if hasattr(nb, "sources") else "?"
                lines.append(f"- **{nb.title}**{active}\n  ID: `{nb.id}`  Sources: {source_count}")
            return [types.TextContent(type="text", text="\n".join(lines))]

        # ── nblm_use_notebook ────────────────────────
        elif name == "nblm_use_notebook":
            nb_id = arguments["notebook_id"]
            notebooks = await client.notebooks.list()
            # Try exact match first, then partial
            match = next((nb for nb in notebooks if nb.id == nb_id), None)
            if not match:
                match = next(
                    (nb for nb in notebooks if nb_id.lower() in nb.id.lower() or nb_id.lower() in nb.title.lower()),
                    None,
                )
            if not match:
                return [types.TextContent(type="text", text=f"❌ Notebook not found: {nb_id}")]
            _current_notebook_id = match.id
            return [types.TextContent(
                type="text",
                text=f"✅ Active notebook set: **{match.title}**\nID: `{match.id}`"
            )]

        # ── nblm_create_notebook ─────────────────────
        elif name == "nblm_create_notebook":
            title = arguments["title"]
            nb = await client.notebooks.create(title)
            _current_notebook_id = nb.id
            return [types.TextContent(
                type="text",
                text=f"✅ Notebook created: **{nb.title}**\nID: `{nb.id}`\n(Set as active notebook)"
            )]

        # ── nblm_ask ─────────────────────────────────
        elif name == "nblm_ask":
            question = arguments["question"]
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook. Use nblm_use_notebook first.")]

            result = await client.chat.ask(nb_id, question)
            answer = result.answer if hasattr(result, "answer") else str(result)
            sources = ""
            if hasattr(result, "references") and result.references:
                refs = [f"[{i+1}] {r.title}" for i, r in enumerate(result.references)]
                sources = "\n\n**Sources:** " + " | ".join(refs)
            return [types.TextContent(type="text", text=f"{answer}{sources}")]

        # ── nblm_add_source_url ──────────────────────
        elif name == "nblm_add_source_url":
            url = arguments["url"]
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook.")]
            source = await client.sources.add_url(nb_id, url, wait=True)
            title = source.title if hasattr(source, "title") else url
            return [types.TextContent(type="text", text=f"✅ Source added: **{title}**\nURL: {url}")]

        # ── nblm_add_source_text ─────────────────────
        elif name == "nblm_add_source_text":
            text = arguments["text"]
            title = arguments["title"]
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook.")]
            source = await client.sources.add_text(nb_id, text, title=title, wait=True)
            return [types.TextContent(type="text", text=f"✅ Text source added: **{title}**")]

        # ── nblm_list_sources ────────────────────────
        elif name == "nblm_list_sources":
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook.")]
            sources = await client.sources.list(nb_id)
            if not sources:
                return [types.TextContent(type="text", text="No sources in this notebook.")]
            lines = ["📄 **Sources:**\n"]
            for s in sources:
                lines.append(f"- {s.title}  (ID: `{s.id}`)")
            return [types.TextContent(type="text", text="\n".join(lines))]

        # ── nblm_get_summary ─────────────────────────
        elif name == "nblm_get_summary":
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook.")]
            result = await client.notebooks.summary(nb_id)
            summary = result.summary if hasattr(result, "summary") else str(result)
            return [types.TextContent(type="text", text=f"📋 **Notebook Summary:**\n\n{summary}")]

        # ── nblm_create_note ─────────────────────────
        elif name == "nblm_create_note":
            title = arguments["title"]
            content = arguments["content"]
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook.")]
            note = await client.notes.create(nb_id, title=title, content=content)
            return [types.TextContent(type="text", text=f"✅ Note created: **{title}**")]

        # ── nblm_generate_brief ──────────────────────
        elif name == "nblm_generate_brief":
            topic = arguments["topic"]
            questions = arguments["questions"]
            nb_id = arguments.get("notebook_id", _current_notebook_id)
            if not nb_id:
                return [types.TextContent(type="text", text="❌ No active notebook.")]

            sections = [f"# Research Brief: {topic}\n"]
            for i, question in enumerate(questions, 1):
                sections.append(f"\n## {i}. {question}\n")
                try:
                    result = await client.chat.ask(nb_id, question)
                    answer = result.answer if hasattr(result, "answer") else str(result)
                    sections.append(answer)
                except Exception as e:
                    sections.append(f"*Error getting answer: {e}*")

            sections.append(f"\n---\n*Generated by NotebookLM MCP | Notebook: {nb_id}*")
            brief = "\n".join(sections)
            return [types.TextContent(type="text", text=brief)]

        else:
            return [types.TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except Exception as e:
        return [types.TextContent(type="text", text=f"❌ Error in {name}: {e}")]


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────
async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
