# Local Mindcraft tests — no automatic GitHub runners

At the owner's request the **test** workflows (Bob Brain Client and
BobBot MindServer Control) are removed from `.github/workflows/` in this
policy PR and archived in `docs/workflow-archive/`.

Run the preserved syntax and unit tests on a developer machine with
**Node.js 22+**:

```bash
bash scripts/test-local.sh
```

The script works both before and after the optional V2 receipt writer
lands; it checks available files and runs their offline Node test suites.
No running Mindcraft/Bob, Minecraft, MindServer, Discord or model endpoint
is contacted. Report exact commit and Node version with local results.

**The unrelated `develop` branch's `deploy.yml` publishes documentation,
not tests, and has not been modified.**

To stop tests on `newearth/main`, this small PR must be approved/merged or
an administrator must disable Actions in repository Settings > Actions >
General. This proposal does **not** merge itself. Archived workflows stay
in Git history. Review branch-protection required checks before retiring
them; do not bypass branch protections.
