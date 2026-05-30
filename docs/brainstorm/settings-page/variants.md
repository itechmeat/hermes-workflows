# Brainstorm — Settings page (TZ §20.10)

Phase 0 of the feature-release-playbook. CLI consultants were not run this round
(same harness constraints); an in-process orchestrator pass produced the
variants. The orchestrator decides.

## Hermes / existing reuse audit

- Hermes has a config system (schema, defaults, `GET/PUT /api/config`,
  `config.yaml` with a `plugins:` section). Settings belong under
  `plugins.workflows`, reusing the host read/write/validate path.
- `config.py` already centralises every knob the plugin reads, with env/default
  fallback. The settings page adds a config-namespace source to that same chain,
  so unset settings preserve current behaviour.
- Host DS components + `hw-` tokens render the form (the host's `AutoField` is not
  exposed to plugins).

## Variants

- **Variant 1 — Store in the Hermes config `plugins.workflows` namespace; read
  via `config.py` with env/default fallback.** Reuses the host config store and
  write/validate path; `config.py` stays the single read point. Complexity:
  medium. Risk: low (pending the host write-contract check).
- **Variant 2 — Bespoke `settings.yaml` owned by the plugin.** A separate file +
  reader/writer the plugin controls end-to-end. Con: a second config store and
  schema authority parallel to Hermes config; duplicates what the host already
  does; more to back up and reason about. Complexity: medium. Risk: medium.
- **Variant 3 — Env-only settings surfaced read-only.** The page shows effective
  env/defaults but edits require changing env/restart. Con: not really a settings
  page (no persistence/edit); fails the TZ intent. Complexity: small. Risk: low
  but under-delivers.

## Recommended: Variant 1

The host already owns config storage, schema, and a validated write path, with a
`plugins:` namespace meant exactly for this; reusing it keeps one config
authority and one read point (`config.py`), with env/default fallback so existing
deployments don't change. Variant 2 reintroduces a parallel store; Variant 3
doesn't deliver editing. The only open item is confirming the host write contract
for a plugin namespace, with a namespaced-section fallback if needed.
