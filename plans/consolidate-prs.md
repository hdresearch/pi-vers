# Plan: Consolidate Open PRs into Single PR

## Open PRs to Consolidate

After checking `refs/pull/*/head` against remote branches, here are the **actual open PRs with changes**:

| PR | Branch | Commits | Files Changed | Summary |
|----|--------|---------|---------------|---------|
| #5 | `browser-connect` | 6 | 15 (+5170) | Browser automation via CDP + Chrome orchestration (subsumes PR #4 `two-path-browser-launch`) |
| #14 | *(detached/fork)* | 2 | 5 (+1142) | `agent-services` extension + 2 new skills (`agent-services`, `swarm-coordination`) |
| #20 | `feat/agent-posture-skill` | 1 | 1 (+76) | New skill: `skills/agent-posture/SKILL.md` |
| #26 | *(detached/fork)* | 1 | 1 (+4/-4) | Fix: use full VM IDs in swarm tool output (stop slicing IDs) |
| #52 | `pranavfeb13` | 1 | 3 (+7) | Add 5s timeout to registry fetch calls + `.gitignore` update |
| #59 | `mistachkin_thorium_updates` | 1 | 2 (+1842/-192) | Major rewrite of `thorium-orchestrator.ts` + register in `package.json` |

### Open PRs with NO unique changes (already in main)
| PR | Branch | Status |
|----|--------|--------|
| #4 | `two-path-browser-launch` | Subsumed by PR #5 (`browser-connect`) |
| #8 | `feat/agent-contributing` | 0 commits ahead of main |
| #24 | `fix/registry-vm-ids` | 0 commits ahead of main |
| #33 | `feat/bootstrap-fleet-skill` | 0 commits ahead of main |
| #10-13, #15-19, #21-23, #25, #27-32, #34-38 | *(various)* | Already merged into main |

### Branches WITHOUT open PRs (but have changes)
These branches have unmerged work but no corresponding open PR. **Include or exclude?**

| Branch | Commits | Summary |
|--------|---------|---------|
| `ty/architect` | 3 (net: 2 new files) | Architect pattern skill + docs (reader ext added then reverted) |
| `yb/persist-ssh` | 1 | Defensive `list()` fix in `vers-vm.ts` |
| `yb/rlm` | 6 | New `vers-rlm.ts` extension + model update + `vers-vm-copy.ts` tweaks |
| `fix/install-script-and-scp-tool` | 1 | Fix `install.sh` + add `vers_vm_copy` SCP tool |

---

## Overlap Analysis

### Files touched by multiple PRs/branches

#### 1. `package.json` — 4 sources
| Source | Change |
|--------|--------|
| PR #5 `browser-connect` | Adds `scripts.test`, `devDependencies.vitest`, reformats `keywords` |
| PR #14 | Adds `./extensions/agent-services.ts` to extensions list |
| PR #59 `mistachkin_thorium_updates` | Adds `./extensions/thorium-orchestrator.ts` to extensions list |
| `yb/rlm` *(no PR)* | Adds `./extensions/vers-rlm.ts` to extensions list |

**Resolution**: All additive, non-conflicting. Combine all extensions list additions + test config. PR #14 is based on an older main (missing `vers-lieutenant.ts`, `vers-vm-copy.ts` in list) — will need rebase-style resolution.

#### 2. `extensions/vers-swarm.ts` — 3 sources
| Source | Change | Region |
|--------|--------|--------|
| PR #26 | Use full VM IDs (remove `.slice(0,12)`) | Lines 282, 415, 442, 642 |
| PR #52 `pranavfeb13` | Add `AbortSignal.timeout(5000)` to fetch calls | Lines 156, 172, 188 |
| `yb/rlm` *(no PR)* | Update default model to `claude-sonnet-4-5-20250929` | Lines 689, 832 |

**Resolution**: All touch different regions of the file. No real conflict — all apply cleanly together.

#### 3. `extensions/vers-vm.ts` — 2 sources (both without PRs)
| Source | Change | Region |
|--------|--------|--------|
| `fix/install-script-and-scp-tool` | Adds `scpArgs()`, `scp()` methods + `vers_vm_copy` tool | New methods + new tool registration |
| `yb/persist-ssh` | Defensive fix to `list()` return + session_start count | Lines 114, 788 |

**Resolution**: Non-overlapping regions. Both apply cleanly.

---

## Merge Strategy

### Approach: Sequential merge into `claude/consolidate-open-prs-T7xZk`

Start from `main`, merge each source one at a time. Order: smallest/most independent first, largest last.

### Merge Order (open PRs only — 6 PRs)

| Step | Source | Risk | Notes |
|------|--------|------|-------|
| 1 | PR #20 `feat/agent-posture-skill` | None | 1 new file, zero overlap |
| 2 | PR #26 *(fix/registry-vm-ids)* | None | Small `vers-swarm.ts` change in isolated lines |
| 3 | PR #52 `pranavfeb13` | Low | `.gitignore` + `vers-swarm.ts` timeouts (different region from #26) |
| 4 | PR #14 *(agent-services)* | Low | New extension + skills + `package.json` (old base, needs conflict resolution) |
| 5 | PR #59 `mistachkin_thorium_updates` | Low | Large but self-contained `thorium-orchestrator.ts` + `package.json` addition |
| 6 | PR #5 `browser-connect` | Medium | Largest changeset (5K+ lines), `package.json` scripts/devDeps + new extension |

### If including non-PR branches too (4 additional)

| Step | Source | Risk | Notes |
|------|--------|------|-------|
| 7 | `yb/persist-ssh` | None | Small defensive fix in `vers-vm.ts` |
| 8 | `fix/install-script-and-scp-tool` | None | `vers-vm.ts` SCP additions + `install.sh` fix |
| 9 | `yb/rlm` | Low | New `vers-rlm.ts` + `vers-swarm.ts` model update + `package.json` |
| 10 | `ty/architect` | None | 2 new files only |

### Expected Manual Conflict Resolution
1. **`package.json`** (steps 4-6, 9): Extensions list grows from multiple sources. All additive — just ensure every extension appears once in the final list.
2. **`extensions/vers-swarm.ts`** (steps 2-3, 9): Three sets of changes in different regions. Git should auto-merge, but verify.

### Post-Merge Validation
- [ ] All new files/extensions exist
- [ ] `package.json` extensions list includes all new entries
- [ ] `package.json` is valid JSON
- [ ] Run `npx vitest run` if available (from PR #5)
- [ ] Final `git diff main` review — confirm no changes lost

---

## Final PR

- **Branch**: `claude/consolidate-open-prs-T7xZk`
- **Target**: `main`
- **Title**: `chore: consolidate open PRs into single release`
- **Body**: Table of all included PRs/branches with contributor attribution and links to originals
- **After merge**: Close original PRs (#4, #5, #8, #14, #20, #24, #26, #33, #52, #59) referencing the consolidated PR
