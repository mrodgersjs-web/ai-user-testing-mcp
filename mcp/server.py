#!/usr/bin/env python3
"""Results-driven MCP server for this repository (stdio transport).

Exposes verified results only: sealed proofs, deterministic lattice score, and a
Gate-D request wrapper. No tool here executes an outward effect; execution stays
behind typed human approval (org execution-owner standard, row 8).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:  # pragma: no cover
    sys.exit("pip install 'mcp[cli]' to run this results MCP server")

ROOT = Path(__file__).resolve().parents[1]
RIG_LOOP = Path.home() / "Developer/rig-capabilities/bin/rig-loop"
mcp = FastMCP("rig-results")


def _j(**payload) -> str:
    return json.dumps({"schema": "rig.results.v1", **payload}, default=str)


@mcp.tool()
def results() -> str:
    """Sealed proofs and result ledger entries for this repo (verified only)."""
    proofs_dir = ROOT / ".rig/proofs"
    proofs = sorted(p.name for p in proofs_dir.glob("*.json")) if proofs_dir.exists() else []
    return _j(repo=ROOT.name, proofs=proofs)


@mcp.tool()
def score() -> str:
    """Deterministic RIG lattice score for this repository."""
    if not RIG_LOOP.exists():
        return _j(error="platform rig-loop unavailable", repo=ROOT.name)
    run = subprocess.run([str(RIG_LOOP), "lattice", "score", str(ROOT)], capture_output=True, text=True, cwd=ROOT)
    return _j(repo=ROOT.name, exit=run.returncode, output=(run.stdout + run.stderr)[-2000:])


@mcp.tool()
def request_effect(action: str, target: str, reason: str) -> str:
    """Record a Gate-D request. Returns the pending request id; never executes."""
    if not RIG_LOOP.exists():
        return _j(error="platform rig-loop unavailable")
    run = subprocess.run(
        [str(RIG_LOOP), "gate-d", "request", "--action", action, "--target", target, "--reason", reason],
        capture_output=True, text=True, cwd=ROOT,
    )
    return _j(exit=run.returncode, stdout=run.stdout[-800:], stderr=run.stderr[-400:])


if __name__ == "__main__":
    mcp.run()
