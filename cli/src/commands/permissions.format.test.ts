// Locks the §6.2 permission message format contract from the arbitrary-depth
// permissions design (docs/architecture/permission-system-arbitrary-depth.md).
//
// The depth-suffix rendering in showPermissionButtons is the most user-visible
// change of Phase B: depth-0 and depth-1 prompts MUST stay byte-identical to
// the pre-change format, and depth >= 2 prompts MUST render the leaf label with
// a `(depth N)` suffix (three spaces, OUTSIDE the closing backtick).
//
// We capture the `content` passed to `thread.send` and assert on the exact
// string so a future change cannot silently break the contract.

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PermissionRequest } from '@opencode-ai/sdk/v2'
import type { ThreadChannel } from 'discord.js'
import { pendingPermissionContexts, showPermissionButtons } from './permissions.js'

function createFakeThread(): {
  thread: ThreadChannel
  getLastContent: () => string | undefined
} {
  let lastContent: string | undefined
  const send = vi.fn(async (args: { content?: string }) => {
    lastContent = args.content
    return { id: 'msg-test' }
  })
  const thread = {
    id: 'thread-test',
    send,
  } as unknown as ThreadChannel
  return { thread, getLastContent: () => lastContent }
}

function basePermission(): PermissionRequest {
  return {
    id: 'per_test',
    sessionID: 'ses_test',
    permission: 'external_directory',
    patterns: ['/home/kimaki/.local/lib/python3.13/*'],
    metadata: {},
    always: ['/home/kimaki/.local/lib/python3.13/*'],
    tool: { messageID: 'msg_tool', callID: 'call_test' },
  }
}

afterEach(() => {
  pendingPermissionContexts.clear()
  vi.restoreAllMocks()
})

describe('showPermissionButtons — §6.2 depth-suffix format', () => {
  test('depth 0 (main session): no **From:** line, no depth suffix', async () => {
    const { thread, getLastContent } = createFakeThread()
    await showPermissionButtons({
      thread,
      permission: basePermission(),
      directory: '/project',
      // subtaskLabel + depth both undefined — mirrors the depth-0 runtime path
      // where handlePermissionAsked leaves them unset.
    })
    const content = getLastContent()!
    // Byte-identical to the pre-change main-session format.
    expect(content).not.toContain('**From:**')
    expect(content).not.toContain('(depth')
    expect(content).toMatchInlineSnapshot(
      `"⚠️ **Permission Required**\n**Type:** \`external_directory\`\nAgent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)\n**Pattern:** \`/home/kimaki/.local/lib/python3.13/*\`"`,
    )
  })

  test('depth 1 (direct child): **From:** label shown, NO depth suffix (byte-identical to old depth-1)', async () => {
    const { thread, getLastContent } = createFakeThread()
    await showPermissionButtons({
      thread,
      permission: basePermission(),
      directory: '/project',
      subtaskLabel: 'task-1',
      depth: 1,
    })
    const content = getLastContent()!
    // Exactly the old depth-1 line — no depth suffix because depth < 2.
    expect(content).toContain('**From:** `task-1`\n')
    expect(content).not.toContain('(depth')
    expect(content).toMatchInlineSnapshot(
      `"⚠️ **Permission Required**\n**From:** \`task-1\`\n**Type:** \`external_directory\`\nAgent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)\n**Pattern:** \`/home/kimaki/.local/lib/python3.13/*\`"`,
    )
  })

  test('depth 2: leaf label + THREE spaces + (depth 2) OUTSIDE the closing backtick', async () => {
    const { thread, getLastContent } = createFakeThread()
    await showPermissionButtons({
      thread,
      permission: basePermission(),
      directory: '/project',
      subtaskLabel: 'investigate-2',
      depth: 2,
    })
    const content = getLastContent()!
    // The §6.2 contract: `**From:** \`investigate-2\`   (depth 2)` — three
    // spaces between the closing backtick and the `(depth 2)` suffix, and the
    // suffix is OUTSIDE the backticks.
    expect(content).toContain('**From:** `investigate-2`   (depth 2)\n')
    // Guard against accidentally moving the suffix inside the backticks.
    expect(content).not.toContain('`investigate-2   (depth 2)`')
    expect(content).not.toContain('`investigate-2`(depth 2)')
    // Guard against the wrong number of spaces.
    expect(content).not.toContain('`investigate-2` (depth 2)')
    expect(content).not.toContain('`investigate-2`  (depth 2)')
    expect(content).toMatchInlineSnapshot(
      `"⚠️ **Permission Required**\n**From:** \`investigate-2\`   (depth 2)\n**Type:** \`external_directory\`\nAgent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)\n**Pattern:** \`/home/kimaki/.local/lib/python3.13/*\`"`,
    )
  })

  test('depth 3: suffix scales with depth', async () => {
    const { thread, getLastContent } = createFakeThread()
    await showPermissionButtons({
      thread,
      permission: basePermission(),
      directory: '/project',
      subtaskLabel: 'research-3',
      depth: 3,
    })
    const content = getLastContent()!
    expect(content).toContain('**From:** `research-3`   (depth 3)\n')
    expect(content).toMatchInlineSnapshot(
      `"⚠️ **Permission Required**\n**From:** \`research-3\`   (depth 3)\n**Type:** \`external_directory\`\nAgent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)\n**Pattern:** \`/home/kimaki/.local/lib/python3.13/*\`"`,
    )
  })

  test('subtaskLabel set but depth undefined: no depth suffix (back-compat for callers that only pass a label)', async () => {
    const { thread, getLastContent } = createFakeThread()
    await showPermissionButtons({
      thread,
      permission: basePermission(),
      directory: '/project',
      subtaskLabel: 'task-1',
      // depth intentionally omitted — depthSuffix must be ''.
    })
    const content = getLastContent()!
    expect(content).toContain('**From:** `task-1`\n')
    expect(content).not.toContain('(depth')
  })
})
