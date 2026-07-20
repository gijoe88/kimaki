// Phase E integration e2e for the arbitrary-depth permissions design
// (docs/architecture/permission-system-arbitrary-depth.md §10 step 7).
//
// Verifies the FULL real pipeline end-to-end:
//   synthetic event → dispatchEventForTesting → registered runtime callback →
//   handleEvent → appendEventToBuffer → ingress filter (isSessionReachable) →
//   handlePermissionAsked → getDerivedSubtaskChain → showPermissionButtons
//
// Only the event SOURCE is synthetic (task edges + permission.asked with real
// opencode event shapes). Everything downstream is the production code path:
// the Phase A graph derivation, the Phase B ingress relaxation + label
// surfacing, and the Phase C Layer 2 auto-accept are all exercised for real.
//
// Per AGENTS.md e2e style:
// - assert on Discord messages (what the user sees), not internal state.
// - deterministic content (fixed synthetic session IDs, no Date.now()).
// - poll timeouts 4s max, 100ms interval.
// - MatchInlineSnapshot placed before other expects so it captures on failure.

import { describe, expect, test } from 'vitest'
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining } from './test-utils.js'
import { dispatchEventForTesting } from './session-handler/global-event-listener.js'
import { getThreadState } from './session-handler/thread-runtime-state.js'
import { pendingPermissions } from './session-handler/thread-session-runtime.js'

const TEXT_CHANNEL_ID = '200000000000001020'

// ─── Synthetic event helpers ──────────────────────────────────
// Build events with real opencode shapes. The top-level `id` is required by
// the SDK type but never read by derivation/runtime logic, so we inject a
// synthetic counter id when omitted (same pattern as eventEntry in
// event-stream-state.test.ts).

let syntheticEventIdCounter = 0

function withId(
  event: Omit<OpenCodeEvent, 'id'> & { id?: string },
): OpenCodeEvent {
  if ('id' in event && event.id) {
    return event as OpenCodeEvent
  }
  return { ...event, id: `evt_test_${++syntheticEventIdCounter}` } as OpenCodeEvent
}

function buildTaskEdgeEvent({
  parentSessionId,
  childSessionId,
  subagentType,
  description,
  partId,
  callId,
  messageId,
}: {
  parentSessionId: string
  childSessionId: string
  subagentType: string
  description: string
  partId: string
  callId: string
  messageId: string
}): OpenCodeEvent {
  return withId({
    type: 'message.part.updated',
    properties: {
      part: {
        id: partId,
        sessionID: parentSessionId,
        messageID: messageId,
        type: 'tool',
        tool: 'task',
        callID: callId,
        state: {
          status: 'running',
          input: {
            subagent_type: subagentType,
            description,
          },
          metadata: { sessionId: childSessionId },
          time: { start: 1_700_000_000_000 },
        },
      },
    },
  })
}

function buildPermissionAskedEvent({
  leafSessionId,
  permissionId,
  patterns,
}: {
  leafSessionId: string
  permissionId: string
  /**
   * Optional override for the permission patterns. Defaults to
   * `['/tmp/kimaki-test-external/*']` (matches the always-rule below).
   * Tests that need a DIFFERENT dedupe key but still want Layer 2 glob
   * coverage can pass a sub-path pattern like
   * `['/tmp/kimaki-test-external/sub/*']` — it's still matched by the
   * always-rule `/tmp/kimaki-test-external/*` (wildcardMatch turns the
   * trailing `*` into `.*`), but the dedupe key differs.
   */
  patterns?: string[]
}): OpenCodeEvent {
  const askedPatterns = patterns ?? ['/tmp/kimaki-test-external/*']
  return withId({
    type: 'permission.asked',
    properties: {
      id: permissionId,
      sessionID: leafSessionId,
      permission: 'external_directory',
      patterns: askedPatterns,
      metadata: {
        filepath: '/tmp/kimaki-test-external/secret.txt',
        parentDir: '/tmp/kimaki-test-external',
      },
      always: ['/tmp/kimaki-test-external/*'],
      tool: {
        messageID: 'msg_test_depth2_assistant',
        callID: 'call_test_depth2_read',
      },
    },
  })
}

// ─── Wait helpers ──────────────────────────────────────────────

async function waitForRootSessionId({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const sessionId = getThreadState(threadId)?.sessionId
    if (sessionId) {
      return sessionId
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error(`Timed out waiting for root session id for thread ${threadId}`)
}

async function waitForPendingPermission({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; messageId: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const threadPermissions = pendingPermissions.get(threadId)
    const firstPermission = threadPermissions
      ? [...threadPermissions.values()][0]
      : undefined
    if (firstPermission?.contextHash && firstPermission.messageId) {
      return {
        contextHash: firstPermission.contextHash,
        messageId: firstPermission.messageId,
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending permission context')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Injects the depth-2 task chain (root → depth1 → depth2) through the real
// handleEvent pipeline. Events are dispatched with small delays so the
// runtime's serialized action queue processes each one fully before the next
// arrives; the permission.asked MUST land after both task edges so the chain
// exists in the event buffer when getDerivedSubtaskChain runs.
async function injectNestedDepth2Chain({
  rootSessionId,
}: {
  rootSessionId: string
}): Promise<void> {
  // Edge 1: root → depth-1 child (project-manager)
  dispatchEventForTesting(
    buildTaskEdgeEvent({
      parentSessionId: rootSessionId,
      childSessionId: 'ses_test_depth1',
      subagentType: 'project-manager',
      description: 'manage the nested investigation',
      partId: 'prt_test_task_1',
      callId: 'call_test_task_1',
      messageId: 'msg_test_root_assistant',
    }),
  )
  await delay(150)

  // Edge 2: depth-1 child → depth-2 leaf (investigate)
  dispatchEventForTesting(
    buildTaskEdgeEvent({
      parentSessionId: 'ses_test_depth1',
      childSessionId: 'ses_test_depth2',
      subagentType: 'investigate',
      description: 'investigate the external file',
      partId: 'prt_test_task_2',
      callId: 'call_test_task_2',
      messageId: 'msg_test_depth1_assistant',
    }),
  )
  await delay(150)
}

// ─── Tests ─────────────────────────────────────────────────────

describe('permissions arbitrary depth: integration e2e', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-permissions-arbitrary-depth-e2e',
    dirName: 'qa-permissions-arbitrary-depth-e2e',
    username: 'permissions-depth-tester',
  })

  test(
    'depth-2 permission prompt surfaces in root thread with leaf label and (depth 2) suffix',
    async () => {
      // 1. Send user message → create thread + root session.
      //    Use the "new thread" predicate (not name-based) because the bot
      //    renames the thread from the initial message text to the model's
      //    response ('nested-permission-setup-ready') within milliseconds.
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((t) => t.id),
      )

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'NESTED_PERMISSION_SETUP_MARKER',
      })

      const thread = await ctx.discord
        .channel(TEXT_CHANNEL_ID)
        .waitForThread({
          timeout: 6_000,
          predicate: (t) => !existingThreadIds.has(t.id),
        })

      const th = ctx.discord.thread(thread.id)

      // 2. Wait for root session to be established and the setup assistant
      //    text to appear (guarantees the real run's events have been
      //    processed before we inject synthetic ones).
      const rootSessionId = await waitForRootSessionId({
        threadId: thread.id,
        timeoutMs: 6_000,
      })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'nested-permission-setup-ready',
        timeout: 6_000,
      })
      // Small grace period for the finish + idle events to flush through the
      // action queue so the snapshot ordering is deterministic.
      await delay(300)

      // 3. Inject the depth-2 chain (root → depth1 → depth2)
      await injectNestedDepth2Chain({ rootSessionId })

      // 4. Inject permission.asked from the depth-2 leaf
      dispatchEventForTesting(
        buildPermissionAskedEvent({
          leafSessionId: 'ses_test_depth2',
          permissionId: 'per_test_depth2_1',
        }),
      )

      // 5. Wait for the permission buttons to appear in the runtime state
      await waitForPendingPermission({ threadId: thread.id, timeoutMs: 4_000 })

      // 6. Assert the message content has the leaf label + (depth 2) suffix
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '(depth 2)',
        timeout: 4_000,
      })

      // 7. Snapshot the full thread text (deterministic — fixed IDs, no
      //    Date.now() in any rendered content). Placed before other expects
      //    so it captures even on failure (per AGENTS.md e2e style).
      expect(await th.text({ showInteractions: true })).toMatchInlineSnapshot(`
        "--- from: user (permissions-depth-tester)
        NESTED_PERMISSION_SETUP_MARKER
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ nested-permission-setup-ready
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        ┣ project-manager **manage the nested investigation**


        ⚠️ **Permission Required**
        **From:** \`investigate-1\`   (depth 2)
        **Type:** \`external_directory\`
        Agent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)
        **Pattern:** \`/tmp/kimaki-test-external/*\`"
      `)

      // 8. Additional targeted assertions on the rendered permission message.
      const messages = await th.getMessages()
      const permMessage = messages.find(
        (m) =>
          m.author.id === ctx.discord.botUserId &&
          m.content.includes('Permission Required') &&
          m.content.includes('(depth 2)'),
      )
      expect(permMessage).toBeDefined()
      // The displayed label is the LEAF only (§6.2 user decision #1):
      // `investigate-1` because ses_test_depth2 is the first (and only) child
      // of ses_test_depth1's assistant message. Depth suffix is 2 (chain
      // length 3 - 1 = 2).
      expect(permMessage!.content).toContain('**From:** `investigate-1`')
      expect(permMessage!.content).toContain('**Type:** `external_directory`')
      expect(permMessage!.content).toContain(
        '**Pattern:** `/tmp/kimaki-test-external/*`',
      )
    },
    20_000,
  )

  test(
    'Accept Always on a depth-2 prompt auto-accepts a sibling depth-2 prompt (Layer 2)',
    async () => {
      // 1-2. Create thread + root session (use "new thread" predicate —
      //      the bot renames the thread to the model's response quickly).
      const existingThreadIds = new Set(
        (await ctx.discord.channel(TEXT_CHANNEL_ID).getThreads()).map((t) => t.id),
      )

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'NESTED_PERMISSION_SETUP_MARKER sibling',
      })

      const thread = await ctx.discord
        .channel(TEXT_CHANNEL_ID)
        .waitForThread({
          timeout: 6_000,
          predicate: (t) => !existingThreadIds.has(t.id),
        })

      const th = ctx.discord.thread(thread.id)

      const rootSessionId = await waitForRootSessionId({
        threadId: thread.id,
        timeoutMs: 6_000,
      })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'nested-permission-setup-ready',
        timeout: 6_000,
      })
      await delay(300)

      // 3. Inject depth-2 chain + first leaf permission
      await injectNestedDepth2Chain({ rootSessionId })

      dispatchEventForTesting(
        buildPermissionAskedEvent({
          leafSessionId: 'ses_test_depth2',
          permissionId: 'per_test_sibling_1',
        }),
      )

      // 4. Wait for the first prompt to appear
      const pending = await waitForPendingPermission({
        threadId: thread.id,
        timeoutMs: 4_000,
      })

      // Snapshot the state right after the first prompt (before click).
      // Placed early so it captures even if later assertions fail.
      expect(await th.text({ showInteractions: true })).toMatchInlineSnapshot(`
        "--- from: user (permissions-depth-tester)
        NESTED_PERMISSION_SETUP_MARKER sibling
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ nested-permission-setup-ready
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        ┣ project-manager **manage the nested investigation**


        ⚠️ **Permission Required**
        **From:** \`investigate-1\`   (depth 2)
        **Type:** \`external_directory\`
        Agent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)
        **Pattern:** \`/tmp/kimaki-test-external/*\`"
      `)

      // 5. Click "Accept Always" on the first depth-2 prompt — this populates
      //    the runtime's alwaysAcceptedRules (Layer 2) with the
      //    external_directory pattern covering /tmp/kimaki-test-external/*.
      const interaction = await th.user(TEST_USER_ID).clickButton({
        messageId: pending.messageId,
        customId: `permission_always:${pending.contextHash}`,
      })
      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 4_000,
      })

      // Give the onAcceptAlways callback a moment to append the rule to
      // alwaysAcceptedRules (it runs synchronously inside handlePermissionButton
      // right after the permission.reply resolves).
      await delay(200)

      // 6. Inject a task edge making a SIBLING depth-2 session reachable
      //    (same parent ses_test_depth1, different leaf session). Without this
      //    edge the ingress filter would drop the sibling's permission.asked
      //    for the wrong reason (unreachable), which would pass the "no new
      //    buttons" assertion without exercising Layer 2.
      dispatchEventForTesting(
        buildTaskEdgeEvent({
          parentSessionId: 'ses_test_depth1',
          childSessionId: 'ses_test_depth2_sibling',
          subagentType: 'investigate',
          description: 'investigate sibling external file',
          partId: 'prt_test_task_sibling',
          callId: 'call_test_task_sibling',
          messageId: 'msg_test_depth1_assistant_sibling',
        }),
      )
      await delay(150)

      // 7. Inject the sibling's permission.asked. The sibling uses a SUB-path
      //    pattern so its dedupe key differs from the first prompt — this
      //    ensures the "no new buttons" assertion can ONLY pass via Layer 2
      //    (alwaysAcceptedRules glob coverage), not via dedupe collapse.
      //    (If patterns were identical, dedupe would also prevent the second
      //    message, making the test a false pass for Layer 2.) The always-rule
      //    `/tmp/kimaki-test-external/*` from the first prompt still covers
      //    `/tmp/kimaki-test-external/sub/*` via glob (`*` → `.*` matches
      //    `sub/*`), so Layer 2 auto-accepts and skips the buttons.
      dispatchEventForTesting(
        buildPermissionAskedEvent({
          leafSessionId: 'ses_test_depth2_sibling',
          permissionId: 'per_test_sibling_2',
          patterns: ['/tmp/kimaki-test-external/sub/*'],
        }),
      )

      // 8. Assert NO new "Permission Required" message appears within a short
      //    deterministic window. The auto-accept path is instant (the event
      //    pipeline is serialized), so 1s is more than enough. Poll to be sure.
      const messagesBeforeSibling = await th.getMessages()
      const permCountBefore = messagesBeforeSibling.filter(
        (m) =>
          m.author.id === ctx.discord.botUserId &&
          m.content.includes('Permission Required'),
      ).length

      let permCountAfter = permCountBefore
      for (let i = 0; i < 10; i++) {
        await delay(100)
        const messagesNow = await th.getMessages()
        permCountAfter = messagesNow.filter(
          (m) =>
            m.author.id === ctx.discord.botUserId &&
            m.content.includes('Permission Required'),
        ).length
        if (permCountAfter > permCountBefore) {
          // A new permission message appeared — Layer 2 failed to auto-accept.
          break
        }
      }

      // The first (clicked) prompt's message still contains "Permission
      // Required" after being updated with the accept status, so the count
      // stays at 1. If Layer 2 failed, a second message would appear (count 2).
      expect(permCountBefore).toBe(1)
      expect(permCountAfter).toBe(1)
    },
    20_000,
  )
})
