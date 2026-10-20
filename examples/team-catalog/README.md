# Team catalog example

Copy `.loadout/kits/` into a project and commit it with the team's code. Loadout discovers those kit YAML files in the automatic **Repo** catalog. There is no repository catalog index or registration step.

Choose **Repo → Team review**, configure the focus areas, and select **Repository** to apply it only in that project. Each member's choices remain local to that member. Discovery does not install anything automatically.

From the Loadout checkout, browse this example with:

```sh
mise exec -- bun src/cli.tsx --repo examples/team-catalog
```

The kit YAML files remain live project files. Their descriptions come from the YAML, not a second catalog file. After a teammate edits them, refresh Loadout to inspect drift and explicitly review an update. If they are removed, existing installed snapshots remain available until their owner changes them.
