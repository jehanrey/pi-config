# Pi Config Sync: Not Planned Yet

These ideas are intentionally out of scope for the first implementation. Revisit this list if the basic `init`, `status`, `export`, `import`, and `restore` flow feels solid.

## Git/GitHub automation

- Create a GitHub repository from the extension.
- Configure remotes.
- Run `git add`, `commit`, `push`, `pull`, or `status` from pi commands.
- Handle merge conflicts.
- Authenticate with GitHub.

Reason: the desired workflow is to inspect diffs in VS Code or another editor and commit/push manually.

## Cloud sync

- Built-in cloud storage.
- Device registry.
- Background sync.
- Automatic conflict resolution.

Reason: Git is the transport for now.

## Auto reload

- Automatically run `/reload` after import or restore.
- Automatically reload extensions/themes/prompts after export.

Reason: imports should be reviewable and explicit. The user can run `/reload` manually when ready.

## Package reinstallation

- Reinstall pi packages from `settings.json`.
- Run `pi install` automatically.
- Sync vendored package directories such as `git/`, `npm/`, or `node_modules/`.

Reason: package directories may be large and machine-specific. The config should record intent, not copied dependencies.

## Secret management

- Encrypt secrets.
- Sync `auth.json`.
- Sync provider API keys.
- Redact secrets from files automatically.
- Integrate with 1Password, macOS Keychain, pass, or similar tools.

Reason: v1 avoids secret files entirely and excludes suspicious filenames.

## Advanced include/exclude configuration

- User-editable glob patterns.
- Per-device overlays.
- Host-specific settings.
- Profile support.

Reason: default managed paths should be enough until a real need appears.

## Project-local `.pi/` sync

- Export/import project-local `.pi/settings.json`, `.pi/prompts`, `.pi/skills`, etc.
- Manage multiple projects.

Reason: v1 only syncs global config under `~/.pi/agent`.

## Diff UI inside pi

- Inline diff viewer.
- File-by-file approval UI.
- Conflict-resolution UI.

Reason: external editors already handle this well.

## Scheduled/automatic backups

- Periodic backups independent of import/restore.
- Backup pruning/retention policy.
- Backup compression.

Reason: v1 creates backups only before import and restore.
