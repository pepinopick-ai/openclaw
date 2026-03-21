---
name: pepino-core
description: "Pepino Pick Agent OS Core -- canonical schemas, policies, agent registry"
version: 2.0.0
---

# Pepino Core

Central governance layer for Pepino Pick Agent OS.

## Files

- `ENTITIES.md` -- Canonical entity schemas (SKU, Customer, Supplier, etc.)
- `AGENT_REGISTRY.md` -- Agent capabilities, permissions, SLAs
- `POLICY_ENGINE.md` -- Action classification and approval rules
- `STATE_MACHINE.md` -- Task lifecycle states and transitions (9 states, timeout engine, validation)
- `LEARNING_LOOP.md` -- Post-decision review, auto-improvement pipeline, quality metrics, eval suite
- `MEMORY_SYSTEM.md` -- 4-type memory architecture (working, episodic, semantic, procedural)
- `EVAL_SUITE.md` -- 50 test cases for system validation
- `RETRIEVAL_POLICY.md` -- Domain access matrix for knowledge retrieval

## Purpose

All agents MUST reference pepino-core schemas when creating or modifying business data.
No agent may define its own entity schema that conflicts with ENTITIES.md.
