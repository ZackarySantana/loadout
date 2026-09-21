# Loadout

Choose agent skills and instructions for yourself or your team. Loadout configures Codex and Claude Code.

Private kits and selections live in `.loadout-personal/`, ignored by Git. Add reusable kits to `~/.loadout/kits/` and enable them per repository.

## Use it

Requires Node.js **22.13+**. Run in any repository:

```sh
npm install -g @lidtop/loadout
loadout
```

Pick your kits, select **Review changes**, then **Apply changes**. Run `loadout` again to change your selection.

Choose **Repository** for the current project or **Global** for your user configuration across repositories.

## Share kits with your team

```sh
loadout init
```

Add kits under `.loadout/kits/` and commit the collection for your team. Enable **Browse → loadout → write-kit** for a short guide your agent can use to create kits.

`loadout --help` lists the commands.

[MIT](LICENSE) · External kits retain their upstream licenses.
