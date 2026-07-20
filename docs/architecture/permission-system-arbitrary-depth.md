# Permission system support for arbitrary-depth agent call chains

Status: **Design approved — ready for project-manager.**
Owner: architect.
Related incident: sairo, 2026-07-20 (depth-2 leaf `read` on host path hung the whole chain).

## User decisions (captured 2026-07-20)

1. **Chain label format**: leaf only (e.g. `investigate-2`). No full chain.
2. **TTL**: uniform 10 min (no shorter TTL for deep prompts).
3. **Abort button**: no — keep the existing 3 buttons (Accept / Accept Always / Deny).
4. **"Accept Always" scope**: propagate to the **whole scope of the root
   session** — ancestors, siblings, descendants (current + future). See §5.6.
5. **Opt-out flag**: none. Deep prompts are always surfaced.
6. (Defaulted, not explicitly answered) **Concurrency display**: keep separate
   messages per prompt (current behavior).
7. (Defaulted, not explicitly answered) **Subagent part display depth**:
   depth-1 only for v1. Only interactive UI (permissions/questions/buttons)
   crosses depth. Can widen later.

## 1. Problem

Task-tool subagents with `threadId === null` (no Discord thread of their own) hang
forever on permission prompts. At depth ≥ 2 from the thread-bearing root, the
permission prompt is **unreachable** in Discord, so the leaf tool call sits in
`state.status === "running"` until the user manually aborts the leaf session.

Concrete failure chain (sairo incident):

```
root session (threadId set, ses_ROOT)
  └─ task → project-manager subagent (threadId null, ses_PM)
       └─ task → investigator subagent (threadId null, ses_INV)  ← leaf
            └─ read /home/kimaki/.local/lib/python3.13/.../server.py
               (host path outside project workdir → permission.asked)
               → no Discord thread can surface buttons
               → ses_INV tool hangs in "running"
               → ses_PM blocks waiting on ses_INV
               → ses_ROOT chain frozen
```

Only recovery today: `POST /session/{id}/abort` on the leaf, then PM re-dispatches.

This is not isolated. It recurs every time a deep subagent touches a path that
falls through the allow rules. Depth is the killer: at depth ≥ 2 the prompt is
silently dropped before it ever reaches Discord.

## 2. Goal

A permissioned tool call at **arbitrary** depth N (N = 1, 2, 5, ...) must be
resolvable from the single Discord thread that owns the root session. The fix
must be safe by default (human-in-the-loop preserved) and fully backward
compatible with the current depth-0 and depth-1 behavior.

## 3. Current-state analysis (file:line references)

All paths below are in `cli/src/`.

### 3.1 Event subscription (single global stream)

`session-handler/global-event-listener.ts:144` — one persistent SSE connection
to `client.global.event()` delivers **every** event from **every** session
(main + every descendant subagent) to **every** registered runtime.

`session-handler/global-event-listener.ts:137` (`dispatchEvent`) fans out each
event to every registered runtime callback. Filtering is the runtime's job.

> Implication: the root runtime **already receives** the leaf's
> `permission.asked` event. The bug is that it drops the event in its own
> filter, not that the event is missing.

### 3.2 Per-runtime session filter (the drop site)

`session-handler/thread-session-runtime.ts:1366`:

```ts
// Drop events that don't match current session (stale events from
// previous sessions), unless it's a global event or a subtask session.
if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
  if (!this.getSubtaskInfoForSession(eventSessionId)) {
    return // stale event from previous session
  }
}
```

For a depth-2 leaf event, `eventSessionId === ses_INV`, `sessionId === ses_ROOT`,
and `getSubtaskInfoForSession(ses_INV)` returns `undefined` (see §3.3). The
event is silently dropped. **This is the root cause.**

The same filter is also applied at `thread-session-runtime.ts:1371` for scoped
toasts and at `thread-session-runtime.ts:1989` in `handlePartUpdated`.

### 3.3 Subtask derivation is depth-1 only

`session-handler/event-stream-state.ts:60` — `getTaskCandidateFromEvent` is the
only place parent→child links are derived from the event stream. It parses
`task` tool parts and reads `part.state.metadata.sessionId` as the child.

The depth-1 limit is enforced at `event-stream-state.ts:77`:

```ts
const part = event.properties.part
if (part.sessionID !== mainSessionId) {
  return undefined
}
```

This requires the `task` tool part to belong to the **main** session. A task
part emitted by `ses_PM` (spawning `ses_INV`) has `part.sessionID === ses_PM`,
so it is ignored. The `ses_PM → ses_INV` edge never enters the graph.

Consumers of this derivation:

- `getDerivedSubtaskIndex` — `event-stream-state.ts:612`
- `getDerivedSubtaskAgentType` — `event-stream-state.ts:675`
- `getDerivedSubagentSessions` — `event-stream-state.ts:701`
- `getSubtaskInfoForSession` (runtime) — `thread-session-runtime.ts:973`
- `handleSubtaskPart` (display) — `thread-session-runtime.ts:2199`
- `handleSessionIdle` subtask branch — `thread-session-runtime.ts:2254`
- `/fork-subagent` command — `commands/fork-subagent.ts:102`

### 3.4 Permission surfacing path

`session-handler/thread-session-runtime.ts:2381` — `handlePermissionAsked`:

```ts
const subtaskInfo = this.getSubtaskInfoForSession(permission.sessionID)
const isMainSession = permission.sessionID === sessionId
const isSubtaskSession = Boolean(subtaskInfo)

if (!isMainSession && !isSubtaskSession) {
  logger.log(`[PERMISSION IGNORED] ...`)
  return
}
```

For depth ≥ 2, `isMainSession === false` and `isSubtaskSession === false`, so
the handler returns early with a log line. Confirmed by reading the code path.

If it had proceeded, it would call `showPermissionButtons` at
`commands/permissions.ts:140`, which posts 3 buttons (Accept / Accept Always /
Deny) into `this.thread` (the root thread) — already correct for our needs.

### 3.5 Permission reply path

`commands/permissions.ts:348` — `handlePermissionButton` calls:

```ts
permClient.permission.reply({
  requestID,           // the permission.asked id
  directory,           // ctx.directory = runtime's sdkDirectory
  reply,               // 'once' | 'always' | 'reject'
})
```

Per `MEMORY.md:101` ("OpenCode permission.reply cannot widen/change scope"),
`reply` cannot override the patterns. The scope of `"always"` is fixed by
`PermissionRequest.patterns` from the original `permission.asked` event. This
constrains Option C (see §5.3).

### 3.6 Permission event shape (real fixture)

`session-handler/event-stream-fixtures/real-session-permission-external-file.jsonl:20`:

```json
{
  "type": "permission.asked",
  "properties": {
    "id": "per_cb9b55b16001wJkRbFGEBf5zJk",
    "sessionID": "ses_3464ab14dffejYF1mCflXShl24",
    "permission": "external_directory",
    "patterns": ["/Users/morse/*"],
    "metadata": { "filepath": "/Users/morse/.zprofile", "parentDir": "/Users/morse" },
    "always": ["/Users/morse/*"],
    "tool": { "messageID": "msg_...", "callID": "uifaJHtaRefZUrWe" }
  }
}
```

Key fields: `sessionID` (the leaf session), `patterns` (what "Accept Always"
will allow), `tool.callID` (links to the running tool call). No `directory` —
we route via the runtime's `sdkDirectory`.

### 3.7 Task tool parent→child edge shape (real fixture)

`session-handler/event-stream-fixtures/real-session-task-three-parallel-sleeps.jsonl:27`:

```json
{
  "type": "message.part.updated",
  "properties": {
    "part": {
      "sessionID": "ses_33d8cd632ffeImx2BDMv6M2eM3",   // ← parent
      "messageID": "msg_cc2732a19001uh1bPt6iz2pNSJ",
      "type": "tool", "tool": "task", "callID": "call_Dm2S6QoS9vZhlq6KycpFQ53V",
      "state": {
        "status": "running",
        "metadata": { "sessionId": "ses_33d8c8e09ffeOl89nZk9eCHaQy" }  // ← child
      }
    }
  }
}
```

The edge is **only** derivable from `task` tool parts. There is no
`session.parentID` field on `session.created` / `session.updated` (confirmed by
inspecting every fixture in `event-stream-fixtures/`). This means the kimaki
side must reconstruct the graph from the event stream — we cannot ask the
opencode server for the parent.

### 3.8 Existing TTL safety net

`commands/permissions.ts:167` — every surfaced permission auto-rejects after
`getPermissionTimeoutMs()` (default 10 min, configurable via
`--permission-timeout-minutes`). The reject carries a feedback message telling
the model the user is away and to either mention the user or work around it.
This relies on `continue_loop_on_deny` being enabled in opencode config.

> The TTL only fires for permissions that **reached** `showPermissionButtons`.
> For depth ≥ 2 prompts that were dropped in §3.4, the TTL never starts. This
> is why the chain hangs instead of auto-recovering.

### 3.9 Cleanup / teardown

`session-handler/thread-session-runtime.ts:284` — `cleanupPendingUiForThread`
rejects every pending permission for the thread on dispose/delete. Already
correct; no change needed.

## 4. Options considered

### 4.1 Option A — Propagate the prompt up to the thread-bearing root

Extend subtask derivation to walk the full parent chain at arbitrary depth.
When a `permission.asked` arrives for any descendant, surface the buttons in
the root thread with a label describing the chain.

**Pros**

- Preserves the human-in-the-loop property — every permission reviewed by the
  same person who reviews top-level ones.
- Minimal surface change: one derivation function becomes graph-aware; the
  existing button + reply plumbing is reused unchanged.
- Works with the existing `permission.reply` SDK; no scope-widening needed.
- Fully backward compatible: depth-0 and depth-1 paths unchanged.
- The existing TTL auto-reject (§3.8) keeps unattended chains from hanging —
  once we surface the prompt, the safety net works for deep prompts too.

**Cons**

- Root thread can get noisy if many subagents prompt concurrently. Mitigation:
  existing dedupe (`buildPermissionDedupeKey` at `thread-session-runtime.ts:4484`)
  already collapses identical-pattern prompts into one message.
- Label needs to convey depth so the user can make an informed decision (see
  §6.2 for format).

**Threat model**

- Safe by default. No new authority is granted; we only route an existing
  prompt to an existing viewer. The "Accept Always" scope is unchanged (fixed
  by `PermissionRequest.patterns`, per `MEMORY.md:101`).

### 4.2 Option B — Auto-deny (or auto-allow narrow scope) for threadless subagents

Auto-resolve permissioned tool calls from threadless subagents after a short
timeout, without ever showing buttons.

**Pros**

- Zero Discord noise. Subagents self-heal on tool errors.

**Cons**

- Auto-deny is just a shorter TTL on top of Option A. Once A surfaces the
  prompt, the existing TTL mechanism already auto-denies on timeout. B is a
  tuning knob, not an alternative.
- Auto-**allow** is unsafe: threadless subagents often touch paths the user
  would not approve (the sairo incident was a system Python site-package).
  Auto-allowing external reads defeats the entire purpose of permission
  gating and is a privilege escalation vector.

**Threat model**

- Auto-allow = unsafe. Reject.
- Auto-deny = safe but lossy (subagents fail unnecessarily when the user
  would have approved). Acceptable only as a tuning of A's TTL.

### 4.3 Option C — Pre-declare per-subagent permission scopes at dispatch time

Parent agent declares "this subagent may read X, Y, Z" when it spawns the
`task`. Anything outside the declared scope is auto-denied immediately without
a prompt.

**Pros**

- Eliminates prompts entirely for well-scoped tasks.
- Composable with unattended cron workflows.

**Cons**

- Requires model cooperation — the parent agent must emit accurate scopes.
  Models are bad at this: they over-broaden ("allow everything") or
  under-broaden ("deny everything, subagent fails").
- `permission.reply` cannot widen scope (`MEMORY.md:101`), so declaration must
  happen via `session.update({ permission })` on the child session after we
  observe the `task` running event. Extra round-trip per spawn.
- Doesn't help subagents that hit **unexpected** paths mid-run.
- Loses human-in-the-loop.

**Threat model**

- Privilege escalation: a confused parent can over-authorize a child. One
  confused PM can grant filesystem-wide read to a leaf. Acceptable only for
  trusted-agent chains, not as a default.

### 4.4 Recommendation: A + Always-propagation

**Option A is the default path.** It is minimal, safe, and backward compatible.
The TTL safety net (§3.8) already handles the "user is away" case once the
prompt is surfaced.

**No shorter TTL for deep prompts** (user decision #2): keep the uniform
10-minute default. The TTL is the only "auto" behavior; everything else is
human-driven.

**"Accept Always" propagates to the whole root session scope** (user decision
#4): when the user clicks "Accept Always" on any prompt (depth-0 or depth-N),
the accepted rule is enforced across the root session's entire task tree —
ancestors, siblings, current descendants, and any descendants spawned later.
This is a deliberate scope expansion: it removes the friction of re-approving
the same pattern in every subagent. Implementation in §5.6.

**Option C deferred** to a follow-up design. It is a power-user feature
(`--permission-scope` flag on `kimaki send` for the parent, propagated via
`session.update`), orthogonal to fixing the hang.

## 5. Proposed approach (detailed)

### 5.1 Graph-aware subtask derivation

In `session-handler/event-stream-state.ts`, relax `getTaskCandidateFromEvent`
to accept `task` tool parts from **any** session, not just `mainSessionId`.
The `mainSessionId` filter at line 77 was an optimization, not a correctness
requirement — it silently broke deeper chains.

Add a pure derivation that builds the reachability graph and answers two
questions:

```ts
// New: returns the chain from mainSessionId down to candidateSessionId,
// or undefined if candidate is not a descendant.
export function getDerivedSubtaskChain({
  events, mainSessionId, candidateSessionId, upToIndex?,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): string[] | undefined
// e.g. [mainSessionId, ses_PM, ses_INV]  — ordered root → leaf

// New: per-hop labels for the chain (reuses getTaskCandidateFromEvent +
// subtask indexing logic, generalized to any parent session).
export function getDerivedSubtaskChainLabels({
  events, mainSessionId, candidateSessionId, upToIndex?,
}): { sessionId: string; label: string; subagentType?: string }[] | undefined
```

The existing `getDerivedSubtaskIndex` / `getDerivedSubtaskAgentType` /
`getSubtaskInfoForSession` are kept as depth-1 shortcuts (their callers in
`handleSubtaskPart` and `/fork-subagent` only care about direct children) but
internally delegate to the graph walker so behavior stays consistent.

Indexing rule for labels at arbitrary depth: index is **scoped to the parent
assistant message that spawned the task**, exactly as today
(`event-stream-state.ts:612`). A depth-2 leaf whose parent (ses_PM) spawned
three tasks gets index 1/2/3 within ses_PM's assistant message — no collision
with depth-1 indices.

### 5.2 Runtime: accept events for any reachable session

In `session-handler/thread-session-runtime.ts:1366`, replace the depth-1 check:

```ts
// Before
if (!this.getSubtaskInfoForSession(eventSessionId)) {
  return // stale event from previous session
}

// After
if (!this.isSessionReachable(eventSessionId)) {
  return // stale event from previous session
}
```

where `isSessionReachable` is a thin wrapper:

```ts
private isSessionReachable(candidateSessionId: string): boolean {
  const sessionId = this.state?.sessionId
  if (!sessionId) return false
  if (candidateSessionId === sessionId) return true
  return this.getDerivedSubtaskChain({ ... }) !== undefined
}
```

Apply the same relaxation at line 1371 (scoped toast), line 1989
(`handlePartUpdated`), and inside `handlePermissionAsked` / `handlePermissionReplied`.

### 5.3 Permission handler: surface deep prompts with chain context

In `handlePermissionAsked` (`thread-session-runtime.ts:2381`), replace
`getSubtaskInfoForSession` with the chain walker and build a richer label:

```ts
const chain = this.getDerivedSubtaskChain({
  events: this.eventBuffer,
  mainSessionId: sessionId,
  candidateSessionId: permission.sessionID,
})

if (permission.sessionID !== sessionId && !chain) {
  logger.log(`[PERMISSION IGNORED] ...`)
  return
}

const subtaskLabel = chain && chain.length > 1
  ? this.formatChainLabel(chain)   // "pm-1 › investigate-2"
  : undefined
```

`showPermissionButtons` (`commands/permissions.ts:140`) already accepts
`subtaskLabel` and renders it as `**From:** \`<label>\``. We extend the message
format (see §6.2) to render the full chain and depth, and pass `chain` so the
button handler can include it in log/audit.

The existing dedupe (`buildPermissionDedupeKey` at
`thread-session-runtime.ts:4484`) already collapses prompts with identical
`directory + permission + patterns` regardless of sessionID, so concurrent
prompts from siblings dedupe to a single message — desirable. The aggregated
requestIDs flow through `addPermissionRequestToContext`
(`commands/permissions.ts:441`) and the reply path fans out one reply per
requestID. **No change needed.**

### 5.4 Reply path: unchanged

`handlePermissionButton` (`commands/permissions.ts:348`) already replies with
`directory = ctx.directory` (the runtime's `sdkDirectory`) — which is the same
for every session in the chain (they all run in the same worktree / project
opencode-server context). The reply is routed by `requestID`, which is unique
per leaf prompt. **No change needed.**

### 5.5 Display of subtask parts at depth ≥ 2 (orthogonal but related)

Once the filter in §5.2 is relaxed, `handleSubtaskPart`
(`thread-session-runtime.ts:2199`) will also start receiving tool/text parts
from deeper subagents. Today it only handles depth-1.

**User decision #7 (defaulted)**: keep depth-1-only display for parts in v1.
Only interactive UI (permissions, questions, action buttons) crosses depth.
Subagent text/tool display stays depth-1 and can be widened in a follow-up.
Rationale: minimize root-thread spam; the user only asked for permission
surfacing, not full deep-subagent observability.

### 5.6 "Accept Always" propagation across the whole root session scope

**Goal** (user decision #4): clicking "Accept Always" on any prompt — whether
depth-0 or depth-N — must prevent future prompts for the same patterns across
the **entire root session tree**: ancestors, siblings, current descendants,
and descendants spawned later.

#### 5.6.1 Why `permission.reply` alone is not enough

`permission.reply({ reply: 'always' })` (the SDK call in
`commands/permissions.ts:388`) registers the rule **only on the leaf session**
that emitted `permission.asked`. Siblings and not-yet-spawned descendants do
not inherit. Per `MEMORY.md:101`, `permission.reply` also cannot widen the
patterns. So a second mechanism is required.

#### 5.6.2 Hybrid enforcement (opencode-side + kimaki-side)

Two layers, both fed from the same source-of-truth set:

**Layer 1 — opencode-side (persistence + native enforcement):**

When "Accept Always" is clicked, in addition to the existing
`permission.reply({ reply: 'always' })` for the immediate request, call
`session.update({ permission: addedRules })` on the **root session**
(`mainSessionId`). The root session is the durable owner; this is the same
API path already used by the `--permission` CLI flag
(`thread-session-runtime.ts:4048`). `addedRules` is built from the
`permission.asked` event's `always` field (a list of patterns) plus the
`permission` type, in the `PermissionRuleset` shape:

```ts
{ permission: 'external_directory', pattern: '/home/kimaki/*', action: 'allow' }
```

We also call `session.update` on currently-running descendant sessions
discovered via the task graph (§5.1) so they don't re-prompt mid-run.

**Implementation risk (open):** whether opencode cascades the root session's
`permission` field to **future** task-spawned children is unverified. If it
does, Layer 1 alone suffices for future descendants. If it does not, Layer 2
covers the gap.

**Layer 2 — kimaki-side (deterministic enforcement, restart-safe via Layer 1):**

Maintain a per-runtime **always-accepted set**:

```ts
// On ThreadSessionRuntime; persisted to root session via Layer 1.
private alwaysAcceptedRules: PermissionRuleset = []
```

When "Accept Always" is clicked, append the new rules to this set. When any
new `permission.asked` arrives for any reachable session (root + all
descendants), check whether the prompt's patterns are covered by
`alwaysAcceptedRules` using the existing `arePatternsCoveredBy` helper
(`commands/permissions.ts:81`). If covered:

- Auto-reply `permission.reply({ reply: 'once' })` without showing buttons.
- Log `[PERMISSION AUTO-ACCEPTED] covered by root-session always-rule`.

If not covered, surface buttons normally.

This layer guarantees correct behavior regardless of opencode's cascading
semantics, and it works even mid-run before opencode's `session.update` has
propagated.

#### 5.6.3 What counts as "the whole scope of the root session"

- The root session itself (`mainSessionId`).
- All currently-running descendants found via the task graph (§5.1).
- All future descendants (Layer 2 catches them at `permission.asked` time).
- Siblings at any depth — they share the root runtime, so they share
  `alwaysAcceptedRules`.

Explicitly **not** covered: other root sessions in other Discord threads.
Each root runtime owns its own `alwaysAcceptedRules`. Cross-thread
propagation would require writing to global opencode config (out of scope).

#### 5.6.4 Sources of the rule patterns

The `permission.asked` event carries two relevant fields (see fixture §3.6):

- `patterns`: what the immediate prompt covers (used for the dedupe key and
  the rendered `**Pattern:**` line).
- `always`: what "Accept Always" should add to the ruleset. For
  `external_directory` this is typically the parent directory glob
  (e.g. `["/Users/morse/*"]`). For `edit` / `bash` it may differ.

We use `always` when non-empty; otherwise fall back to `patterns`. Each entry
is combined with the `permission` type to build a `PermissionRuleset` entry.

#### 5.6.5 Reverse operation (no "revoke" in v1)

There is no UI to revoke an always-accepted rule in v1. The rule persists for
the lifetime of the root session. If a revoke is needed, the user can use the
existing `/permissions` slash command (if present) or restart the session. A
follow-up can add a "Manage always-rules" UI; out of scope here.

## 6. UX design

### 6.1 Where buttons appear

Always in the root thread (the thread that owns `mainSessionId`). Never create
synthetic threads for threadless subagents. This matches the user's mental
model: one thread per top-level task.

### 6.2 Permission message format

Today (`commands/permissions.ts:232`):

```
⚠️ **Permission Required**
**From:** `task-2`
**Type:** `external_directory`
Agent is accessing files outside the project. [Learn more](...)
**Pattern:** `/home/kimaki/*`
```

Proposed for depth ≥ 2 (user decision #1: leaf label only, plus depth suffix):

```
⚠️ **Permission Required**
**From:** `investigate-2`   (depth 2)
**Type:** `external_directory`
Agent is accessing files outside the project. [Learn more](...)
**Pattern:** `/home/kimaki/.local/lib/python3.13/*`
```

- The label is the **leaf subagent** (e.g. `investigate-2`), not the full
  chain. User explicitly chose leaf-only for brevity.
- `(depth N)` is shown only when N ≥ 2 so depth-1 prompts stay visually
  identical to today (no regression).
- The pattern is the leaf's `PermissionRequest.patterns`, compacted by
  `compactPermissionPatterns` as today.

When a prompt is auto-accepted by Layer 2 (§5.6.2), no Discord message is
shown at all — the prompt is resolved silently. Optionally log a single
diagnostic line in the thread like `_Auto-accepted (covered by root always-rule): \`bash: git *\`_`
so the user has visibility. Decide default-on vs default-off during
implementation (recommendation: default-off, configurable via existing
verbosity).

### 6.3 Concurrent prompts

Each prompt gets its own message (current behavior). When dedupe collapses
multiple leaf prompts with identical patterns into one message, the rendered
label is the **shallowest** chain in the dedupe set (most informative), with a
`+N more` suffix if > 1 session is covered:

```
**From:** `pm-1 › investigate-2`   (+1 more, depth 2)
```

## 7. Data flow diagram

```
Leaf session ses_INV calls `read /home/...`
opencode server emits permission.asked { sessionID: ses_INV, ... }
        │
        ▼
/global/event SSE → root runtime (ses_ROOT)
        │
        ▼
handleEvent() — line 1366 filter
   isSessionReachable(ses_INV)?
      ├─ build reachability graph from task tool parts in eventBuffer
      ├─ ses_ROOT ─┬─ task → ses_PM
      │            └─ task → ses_INV (via ses_PM)
      └─ YES → proceed (today: NO → drop, hang)
        │
        ▼
handlePermissionAsked()
   chain = getDerivedSubtaskChain(...)
      → [ses_ROOT, ses_PM, ses_INV]
   label = "pm-1 › investigate-2"
        │
        ▼
showPermissionButtons({ thread: rootThread, permission, subtaskLabel: label })
   posts Accept / Accept Always / Deny into root thread
   starts TTL auto-reject timer (default 10 min)
        │
        ▼
[user clicks Accept] OR [TTL expires → auto-reject with feedback]
        │
        ▼
permission.reply({ requestID, directory: sdkDirectory, reply })
        │
        ▼
opencode server resumes (or errors) ses_INV tool call
        │
        ▼
ses_INV continues → ses_PM unblocks → ses_ROOT chain resumes
```

## 8. Edge cases

### 8.1 Race: user clicks Allow after subagent already exited

The leaf may abort / idle / error before the user answers. Today's button
handler uses atomic `takePendingPermissionContext`
(`commands/permissions.ts:126`) so only one of {TTL, click, cancel} wins.

- If the leaf session is gone, `permission.reply` is a no-op (opencode
  discards replies for unknown request IDs).
- We should additionally listen for `session.idle` / `session.deleted` /
  `session.error` on any session in the chain and proactively dismiss its
  pending prompt with status "Subagent exited before answer." This is a small
  addition in `handleSessionIdle` / `handleSessionError`.

### 8.2 Timeout behavior

Inherit the existing TTL (`getPermissionTimeoutMs()`, default 10 min, user
decision #2: no shorter TTL for deep prompts). On expiry, auto-reject with
the existing feedback message. The leaf sees a tool error; with
`continue_loop_on_deny` enabled, the model works around it or mentions the
user.

### 8.3 Multiple subagents prompting concurrently

Each permission has a unique `id`. We already support multiple pending
permissions per thread (`pendingPermissions` Map keyed by permissionId). No
new concurrency primitive. Identical-pattern prompts dedupe to one message
with aggregated requestIDs (already supported via
`addPermissionRequestToContext`).

### 8.4 Subagent finishes before answer (parent aborts leaf)

Without §8.1's proactive dismissal, the prompt sits until TTL. Acceptable but
noisy. The proactive dismissal is a strict improvement.

### 8.5 Dedupe across depths

`buildPermissionDedupeKey` is `directory :: permission :: patterns` — no
sessionID. A depth-2 leaf and a depth-1 leaf asking for the same pattern in
the same directory dedupe to one prompt. Desirable: one user action covers
both. The aggregated requestIDs are replied in parallel.

### 8.6 Stale chain (parent session reused)

Session IDs are opaque `ses_` UUIDs; reuse does not happen in practice. No
mitigation needed.

### 8.7 Buttons clicked out of order

Each prompt is independent. No ordering invariant. Already handled.

### 8.8 Reply `directory` for cross-depth

All sessions in the chain share the runtime's `sdkDirectory` (same worktree /
project). `permission.reply({ directory: sdkDirectory })` routes correctly.
No change.

### 8.9 Event buffer compaction

The event buffer is compacted (`thread-session-runtime.ts:1088`) but
explicitly preserves `task` tool `subagent_type` (line 1167). The compaction
also preserves `metadata.sessionId` for running task parts because it only
clears `state.input` (not `state.metadata`). The graph builder reads
`state.metadata.sessionId`, so compaction is safe. Verify with a unit test
that feeds a compacted buffer.

### 8.10 `permission.asked` arrives before the spawning `task` running event

Unlikely (opencode emits the task running event before the child session can
prompt), but if it happens, the chain walker returns undefined and we drop the
prompt. Mitigation: if a `permission.asked` for an unknown session is seen,
hold it in a small pending buffer (e.g., 500 ms) and re-evaluate when the next
`message.part.updated` arrives. This is a defensive fallback; the primary path
does not need it. Decide in implementation (default: skip, log and drop).

## 9. Migration / backward compatibility

- **Depth-0 (main session) permissions:** unchanged. `permission.sessionID === sessionId` short-circuits in `handlePermissionAsked`.
- **Depth-1 (direct subtask) permissions:** behavior unchanged. Label rendering is identical when depth === 1 (no `(depth N)` suffix). Existing tests in `event-stream-state.test.ts` continue to pass because `getDerivedSubtaskChain` returns the same one-hop chain for depth-1 cases.
- **Depth ≥ 2 (new):** previously silently dropped; now surfaced in root thread. No SQLite schema change. No `opencode.json` change. No new env vars required.
- **"Accept Always" propagation (new behavior, applies at all depths):**
  - Layer 1 (`session.update` on root + current descendants) is additive — it
    only appends `allow` rules. Existing per-session permission rules are
    preserved.
  - Layer 2 (kimaki-side auto-accept set) is purely a fast-path; it never
    rejects, only auto-accepts covered prompts.
  - Backward compat caveat: today "Accept Always" only affects the leaf
    session. After this change, it affects the whole root tree. This is the
    intended behavior change (user decision #4) but is user-visible: a single
    "Accept Always" click in a deep prompt will silence future prompts across
    the whole thread. Documented in the changeset.
- **No DB migration.** The `permission` table inside opencode's sqlite is untouched; we only change routing/derivation/enforcement in the kimaki process.

## 10. Implementation sequence (for the project-manager)

Ordered by dependency. Each step is independently testable.

1. **Pure derivation.** In `event-stream-state.ts`, relax
   `getTaskCandidateFromEvent` (drop the `part.sessionID === mainSessionId`
   filter) and add `getDerivedSubtaskChain` + `getDerivedSubtaskChainLabels`.
   Add unit tests in `event-stream-state.test.ts` with a depth-3 fixture
   (manually constructed from the existing task fixture by nesting). Verify
   compaction-safe (§8.9).

2. **Runtime reachability filter.** In `thread-session-runtime.ts`, add
   `isSessionReachable` (uses `getDerivedSubtaskChain`) and apply it at the
   three filter sites (§5.2). Keep `getSubtaskInfoForSession` for depth-1
   display callers.

3. **Permission surfacing.** In `handlePermissionAsked`, switch to the chain
   walker. Build the leaf-only label + `(depth N)` suffix per §6.2. Extend
   `showPermissionButtons` / `updatePermissionMessage` to render the depth
   suffix. The label itself uses the existing `subtaskLabel` plumbing
   (`commands/permissions.ts:227`) — no new param needed beyond passing the
   leaf label and depth.

4. **"Accept Always" propagation — Layer 1 (opencode-side).** In
   `handlePermissionButton` (`commands/permissions.ts:348`), when
   `response === 'always'`, after the existing `permission.reply` loop, build
   `addedRules` from `ctx.permission.always ?? ctx.permission.patterns` +
   `ctx.permission.permission` (shape: `{ permission, pattern, action: 'allow' }`).
   Call `session.update({ sessionID: rootSessionId, permission: appendedRules })`
   on the root session, and on each currently-running descendant discovered
   via `getDerivedSubtaskChain`. The root session ID is available on the
   runtime (`this.state?.sessionId`); pass it through to the button context.
   Use `parsePermissionRules` / `PermissionRuleset` types from `opencode.ts`.

5. **"Accept Always" propagation — Layer 2 (kimaki-side enforcement).** Add
   `alwaysAcceptedRules: PermissionRuleset` to `ThreadSessionRuntime`.
   Populate it in step 4's "always" path. In `handlePermissionAsked`, before
   showing buttons, check `arePatternsCoveredBy` against the runtime's
   `alwaysAcceptedRules`; if covered, auto-reply `permission.reply({ reply:
   'once' })` and skip the buttons. Log `[PERMISSION AUTO-ACCEPTED]`.

6. **Proactive dismissal.** In `handleSessionIdle` / `handleSessionError` /
   a new `handleSessionDeleted`, dismiss pending prompts whose chain contains
   the exiting session. Status text: "Subagent exited before answer."

7. **E2E test.** Add a `discord-digital-twin` e2e that builds a depth-2 chain
   via the deterministic provider, has the leaf attempt a gated `read`, and
   asserts: (a) buttons appear in the root thread with the leaf label +
   `(depth 2)` suffix, (b) clicking Accept unblocks the leaf, (c) TTL expiry
   rejects and the chain recovers via tool error, (d) clicking Accept Always
   on a depth-2 prompt prevents a sibling depth-2 subagent from prompting
   for the same pattern. Add `expect(await th.text()).toMatchInlineSnapshot()`
   per AGENTS.md e2e style.

8. **Fixture.** Add `event-stream-fixtures/real-session-nested-task-permission.jsonl`
   captured from a real depth-2 run (or hand-built from existing fixtures) so
   derivation tests use realistic shapes.

9. **Changeset.** Per the `changesets` skill: add a `.changeset/*.md` entry
   describing (a) the bug fix — depth ≥ 2 permission hang — and (b) the
   behavior change — "Accept Always" now covers the whole root session tree.
   Both are user-visible.

Verify after each step: `cd cli && pnpm tsc` (per AGENTS.md). After steps 1,
7: `pnpm test --run` for the affected files; after step 7 also
`pnpm test -u --run` to snapshot the new e2e output.

## 11. Threat model summary

| Option / behavior | Authority granted | Human-in-loop | Verdict |
|-------------------|-------------------|---------------|---------|
| A (propagate up)   | None new — same prompt, same viewer.                          | Yes | **Default.** Safe. |
| TTL auto-reject    | None — model sees tool error, works around it.                | No  | Inherited from today. |
| Auto-allow (B-allow) | Auto-grants leaf permission.                                | No  | **Rejected.** Privilege escalation. |
| Pre-declare (C)    | Parent declares child scope; can over-authorize.              | No  | Deferred. Power-user follow-up. |
| **Always-propagate (§5.6)** | Rule granted once by human click, then applied across the whole root tree. | Yes (initial), No (subsequent) | **Approved by user (#4).** Threat: a too-broad "Accept Always" click silences future prompts across the thread. Mitigation: rules are scoped to the exact patterns from the `permission.asked` event (no widening); user can restart the session to reset; revoke UI is a follow-up. |

The Always-propagate threat is the one to watch in code review: ensure the
auto-accept check (Layer 2) only matches patterns that are genuinely covered
by an accepted rule (use the existing `arePatternsCoveredBy` helper), and
never auto-accept a broader permission type than what was approved (e.g. an
`edit` rule must not auto-accept a `bash` prompt even if patterns overlap).

## 12. Open questions — all resolved

All questions from the original draft have been answered by the user
(2026-07-20, see top of doc). No remaining open questions for the
project-manager. The two defaulted items (#6 concurrency display, #7 part
display depth) follow the recommended v1-minimal path and can be revisited
in a follow-up if the user wants different behavior.

---

End of design. **Approved by user.** Ready for project-manager delegation.
