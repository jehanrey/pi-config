# Pi Config Sync: Automatic Memory/Lessons Sync Plan

## Intent

Memory and learned lessons are part of the user's pi configuration. Normal `/pi-config export` and `/pi-config import` should automatically carry portable memory across devices. The user should not need a separate memory-specific command in the ordinary flow.

## Implementation status

Implemented on 2026-05-29 in the applied runtime extension first:

- `~/.pi/agent/extensions/pi-config-sync/index.ts`

Then mirrored into the sync repo:

- `extensions/pi-config-sync/index.ts`

Initial synced memory artifacts:

- `memory/semantic.json`
- `memory/lessons.json`
- `memory/manifest.json`

## Findings

- Pi persistent memory is stored at `~/.pi/memory/memory.db`.
- Observed DB tables: `semantic`, `lessons`, and `events`.
- Extension docs do not currently expose a first-class memory API, so the implementation uses the local `sqlite3` CLI.
- Raw SQLite DB sync is intentionally avoided.

## Behavior

### Export

`/pi-config export` automatically exports active memory into reviewable JSON files under `memory/` and includes `memory/**` in the repo manifest.

Export sanitizes machine-specific home paths by replacing the current home directory with `~` in synced memory text and metadata.

### Import

`/pi-config import` automatically applies synced memory JSON into local `~/.pi/memory/memory.db`.

Rules:

- Missing semantic facts are inserted.
- Changed semantic facts are updated to the synced value.
- Missing lessons are inserted.
- Changed or deleted local lessons are updated/resurrected from the synced value.
- Local-only memory is not deleted.
- The memory DB is backed up before applying memory imports.

## Synced files

```text
memory/
  semantic.json
  lessons.json
  manifest.json
```

These files are sync artifacts, not runtime memory storage.

## Validation note

A direct TypeScript compiler check was not available in this repo. Attempting `npx tsc` would install the deprecated `tsc` placeholder package, so full runtime validation should happen after `/reload` in pi.
