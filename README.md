# Kubernetes (OpenChamber extension)

A Lens-style Kubernetes browser for OpenChamber, with agent tools that respect a production lock.

Status: Phase 2 (panel shell and resource browsing). The contract and results are in `PLAN.md`.

```sh
bun run build      # bundles panel, blocks, service and plugin
bun run check      # openchamber-guest-check
bun run typecheck
```
