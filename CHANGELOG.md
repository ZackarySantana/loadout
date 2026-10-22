# @lidtop/loadout

## 0.5.2

### Patch Changes

- 087f3bc: Notify interactive users when a newer Loadout release is available and offer an explicitly confirmed Update & restart flow for supported global Mise/npm installations. Protect pending kit and settings changes, fully close the UI before installing, and restart only after verifying the new version. Keep source/development runs free of update popups and provide manual instructions for unsupported installations, including Windows.

  Remove leftover authentication diagnostics and make updater test fixtures portable across local and CI environments.

## 0.5.1

### Patch Changes

- 60e01c6: Speed up large skill previews with on-demand supporting files and windowed document rendering, while preserving installed content and live configuration previews.

## 0.5.0

### Minor Changes

- 7742ae9: Rewrote as v2.
