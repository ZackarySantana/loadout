# Loadout

Share a collection of agent skills and instructions with your team. Everyone in the repository picks the kits they want, keeping the full collection available without adding it all to their agent's context.

Kit definitions live in the repository. Each developer's selections and generated files stay local and ignored by Git. Loadout configures both Codex and Claude Code.

## Use it

Requires Node.js **22.13+**. In a repository using Loadout:

```sh
npm install -g lidtop/loadout
loadout
```

Pick your kits, select **Continue**, and confirm. Run `loadout` again to change your selection.

## Add it to your repository

```sh
loadout init
```

Add kits under `.loadout/kits/` and commit the collection for your team. Enable **Browse → loadout → write-kit** for a short guide your agent can use to create kits.

`loadout --help` lists the commands.

[MIT](LICENSE) · External kits retain their upstream licenses.
