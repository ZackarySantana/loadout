# @lidtop/loadout

## 0.6.0

### Minor Changes

- 253824c: Quit with Ctrl+C instead of q, following OpenCode: Ctrl+C clears a non-empty text field, otherwise exits immediately. With unapplied changes it asks first; press Ctrl+C again to discard them and exit, or Esc to stay.

### Patch Changes

- b25cc67: Keep kits from the built-in and bundled remote catalogs connected after upgrading Loadout. Bundled catalogs now use install-independent identities, and kits saved by earlier releases are repaired automatically instead of reporting a missing subscription. Kit status labels and details now use plain language with a clear next step.

  Add the "Cut secondary text" kit to the Loadout catalog.

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
