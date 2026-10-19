# Team catalog example

Copy `.loadout/` into a project and commit it with the team's code. Loadout discovers `.loadout/catalog.json` in the selected project; team members do not need a user-wide catalog registration.

Choose **Acme team → Team review**, configure the focus areas, and select **Repository** to install only in that project. Each member's choices remain local to that member. Discovery does not install anything automatically.

From the Loadout checkout, browse this example with:

```sh
mise exec -- bun src/cli.tsx --repo examples/team-catalog
```

The catalog and kit YAML are live project files, not imported copies. After a teammate edits them, refresh Loadout to inspect drift and explicitly review an update. If they are removed, existing installed snapshots remain available until their owner changes them.
