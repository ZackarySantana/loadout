# Output settings

Settings are user-wide destination preferences. They do not change kit scope: Repository, Global, and Both still describe installation intent, and a global installation still suppresses repository copies of the same kit.

## Ordered location lists

Settings contains four groups:

- Repository instructions
- Global instructions
- Repository skills
- Global skills

Open a group to edit its locations, add or remove entries, or move a location up or down. The first location is marked **Primary**. Changing order matters when using links.

Repository locations resolve inside each affected project. Global locations resolve from your home directory, or may use an explicit absolute path. Review displays the resolved paths before any changes are written. Internal Loadout state and Git metadata cannot be destinations.

## Defaults

Defaults support Codex, Claude, and OpenCode. Codex and OpenCode share one repository instruction destination, so it is included only once. Each CLI's user-level instructions and skill locations are covered. Explicit Codex and XDG configuration homes are respected.

Copy mode is the default. Restore defaults stages the default location lists and modes; it does not immediately move files.

## Copy or link

Each group chooses how later locations relate to its first location:

- **Copy:** each location contains independent managed files.
- **Link:** the first location contains real files; corresponding files in later locations are symbolic links to it.

Links are created per managed file, including skill supporting files, not for entire skill roots. Other skills and unrelated files remain untouched. Links point directly to the primary file rather than forming chains.

Instruction files may contain user text outside Loadout's blocks. Link mode does not merge or discard independent notes in secondary files; a conflicting destination blocks the operation. Keep Copy mode or reconcile those files deliberately. Unmanaged symlinks and symlinked parents are not followed or overwritten.

Loadout records the symbolic links it creates. A changed or missing link is drift, just like changed managed file content. Switching back to copies and changing the primary location are planned operations, not writes through existing links.

## Stage, review, apply

Accepting a Settings group stages it with any kit changes. It does not save preferences or change files yet. Cancel discards only the open group's edit.

Settings-only changes can be reviewed without selecting any kits. Review shows settings changes, exact destinations, file relocations, and link targets. Keep editing remains focused by default. Only explicitly choosing Apply changes saves settings and changes the filesystem.

Destination changes can affect existing global outputs and every known repository that retains installation intent. Conflicting edits block apply rather than being overwritten. The same apply journal protects file and link changes during interruption or rollback.
