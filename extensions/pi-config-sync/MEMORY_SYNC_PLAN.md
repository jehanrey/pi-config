# Pi Config Sync: Automatic Memory/Lessons Sync

## Intent

Memory and learned lessons are part of a user's pi configuration. Normal `/pi-config export` and `/pi-config import` should automatically carry portable memory across devices. The user should not need a separate memory-specific command in the ordinary flow.

## Source of truth

This document belongs with the applied `pi-config-sync` extension because it describes extension behavior, not a single checkout's local plan.

For a global pi installation, the applied extension normally lives at:

```text
~/.pi/agent/extensions/pi-config-sync/
```

When config is exported, this file is mirrored into the configured pi-config sync checkout under:

```text
extensions/pi-config-sync/MEMORY_SYNC_PLAN.md
```

## Persistent memory storage

Pi persistent memory is stored separately from normal agent config:

```text
~/.pi/memory/memory.db
```

Observed memory tables:

- `semantic` — durable facts and preferences keyed by name.
- `lessons` — learned corrections/rules.
- `events` — memory change history.

The extension docs do not currently expose a first-class memory API, so this implementation uses the local `sqlite3` CLI.

## Design

Do **not** sync the raw SQLite database.

Instead, export a curated, reviewable JSON representation into the configured sync checkout, then import that JSON into the local memory DB on another device.

This keeps the sync artifact portable and avoids copying machine-specific DB state.

## Export behavior

`/pi-config export` automatically exports active memory into reviewable JSON files under:

```text
memory/
  semantic.json
  lessons.json
  manifest.json
```

Export sanitizes machine-specific home paths by replacing the current home directory with `~` in synced memory text and metadata.

The repo manifest includes `memory/**` so these files are tracked as managed sync artifacts.

## Import behavior

`/pi-config import` automatically applies synced memory JSON into the local memory DB.

Rules:

- Missing semantic facts are inserted.
- Changed semantic facts are updated to the synced value.
- Missing lessons are inserted.
- Changed or deleted local lessons are updated/resurrected from the synced value.
- Local-only memory is not deleted.
- The memory DB is backed up before applying memory imports.

## Pull behavior

`/pi-config pull` runs a fast-forward-only pull of the configured sync checkout's `main` branch:

```text
git pull --ff-only origin main
```

This is intentionally narrow Git automation for the common cross-device import flow.

## Validation note

A direct TypeScript compiler check may not be available in a bare config checkout. Runtime validation should happen after `/reload` in pi.
