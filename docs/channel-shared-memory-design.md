# Channel Shared Memory With Isolated Sessions

## Background

Flash-Claw is evolving toward a multi-channel architecture (Feishu, WeCom, Slack). We want to share long-term memory across channels while keeping per-channel sessions isolated. This document proposes a design that decouples session keys from memory identity and introduces a cross-channel identity layer.

## Goals

- Share long-term memory across channels for the same real user.
- Keep short-term session history isolated per channel/account/chat.
- Avoid accidental cross-user memory merges.
- Provide an explicit, auditable binding flow for identity linking.
- Keep changes localized and incremental.

## Non-Goals

- A full multi-channel architecture spec (covered elsewhere).
- Auto-merge identities without user consent.
- Changes to LLM prompt content or tool execution semantics.

## Current State

- Session history is keyed by `sessionId` (working memory / short-term memory).
- Long-term memory uses a `userId` string (currently derived from channel-specific user id or session id).
- There is no identity mapping, so cross-channel sharing is not possible without risk.

## Proposed Design

### Key Principle

Split the identity used for memory from the identity used for session history.

- **Session key** remains channel-specific.
- **Memory identity** becomes a stable, cross-channel user identity.

### Key Definitions

#### Session ID (short-term)

Use a strict, channel-scoped key to ensure isolation:

```
${channel}:${accountId}:${tenantId ?? "default"}:${chatId}:${userId}
```

#### Memory User ID (long-term)

Use a global identity to share memories across channels:

```
global:${identityId}
```

### Identity Resolver

Introduce a resolver that maps channel user identity to a global identity id.

```ts
interface IdentityResolver {
  resolve(input: {
    channel: string;
    accountId: string;
    tenantId?: string;
    userId: string;
  }): Promise<string>; // returns identityId
}
```

### Identity Store

Backed by SQLite. Each mapping is explicit and auditable.

Schema proposal:

```
identity_map (
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel, account_id, tenant_id, user_id)
)
```

### Binding Flow

#### Default (no binding)

- If no identity mapping exists, generate a channel-scoped identity:

```
identityId = hash(`${channel}:${accountId}:${tenantId}:${userId}`)
```

This prevents accidental cross-user memory sharing.

#### Explicit Binding (recommended)

1. User issues `/bind` (or equivalent) in channel A.
2. System returns a short-lived code (e.g., 8 chars).
3. User issues `/bind <code>` in channel B.
4. System links both channel identities to the same `identityId`.

Bindings should be revocable with `/unbind`.

### Memory Manager Changes

All memory reads/writes must use `memoryUserId` (global identity), not `sessionId`.

```ts
const identityId = await identityResolver.resolve({ channel, accountId, tenantId, userId });
const memoryUserId = `global:${identityId}`;

memoryManager.recall({
  text,
  userId: memoryUserId,
  sessionId,
});

memoryManager.storeInteraction(
  { sender: { id: memoryUserId }, conversationId: sessionId, ... },
  response,
);
```

Session history (working memory) remains unchanged and continues using `sessionId`.

## API and Component Changes

### New Components

- `IdentityResolver`
- `IdentityStore`
- `BindCodeService` (optional helper)

### Updated Components

- `MessageDispatcher` (or equivalent layer) resolves identity and passes `memoryUserId`.
- `MemoryManager` calls updated to use `memoryUserId`.

### Configuration

- New config flag: `MEMORY_IDENTITY_MODE`
  - `isolated` (default): no cross-channel sharing
  - `explicit`: only share with binding

## Security and Privacy

- No auto-merge across channels by default.
- All bindings are explicit and auditable.
- Add a `/unbind` flow and admin tools to remove mappings.
- Keep the identity map in local storage (SQLite), not in logs.

## Migration Strategy

1. Add identity mapping tables (no behavior change).
2. Introduce `IdentityResolver` and switch memory to use `memoryUserId`.
3. Roll out `/bind` and `/unbind` commands.
4. Enable explicit cross-channel sharing by config.

## Testing Plan

- Unit tests: identity resolution with and without bindings.
- Integration tests: two channels, same bound identity, shared memory recall.
- Negative tests: two channels without binding should not share memory.
- Regression tests: existing session behavior unchanged.

## Rollout Plan

1. Ship in `isolated` mode by default.
2. Enable explicit bindings for select tenants.
3. Monitor memory recall accuracy and cross-channel behavior.

## Open Questions

- What is the UX for `/bind` in each channel (command or natural language)?
- Should we allow admin overrides (bulk bindings)?
- How long should bind codes remain valid?
