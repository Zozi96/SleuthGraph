# Telemetry

**Telemetry is fully disabled in the SleuthGraph fork.** Nothing is recorded,
nothing is written to disk, and no connection to any telemetry endpoint is ever
opened — there is no opt-out to manage because there is nothing to opt out of.

`codegraph telemetry status` (and `on`/`off`) still exists and reports that
telemetry is disabled in this build.

The upstream project's telemetry design is kept as a design record in
[`docs/design/telemetry.md`](docs/design/telemetry.md).

> **TODO(SleuthGraph):** if telemetry is ever wanted for this fork, reimplement
> it against our own endpoint and consent flow. Until then the client in
> `src/telemetry/` is a deliberate no-op.
