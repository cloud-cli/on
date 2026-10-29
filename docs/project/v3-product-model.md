# V3 product model and terminology

This document records the current product vocabulary. It refines the earlier
channel-first proposal; it does not claim that every concept is implemented or
settle API/database names. In particular, existing `channels` tables and routes
are implementation details to be reconciled with this model, not authority for
the product terminology.

## People, access, and ownership

- **User** is an authenticated participant and may be a human or an agent.
  Every user has a globally unique mention name, written `@<name>`. Human/agent
  is the user kind; it is not an access role.
- **Workspace** is the organizational and authorization boundary. Users own or
  work in workspaces. A user's workspace role is `viewer`, `collaborator`, or
  `admin`; permissions are evaluated for the workspace being accessed.
- **Secret** is a workspace-managed value made available to authorized
  automations/agents for execution. Secret values are not ordinary event,
  thread, or stream content; references and values remain protected by
  authorization and redaction rules.

## Automation and execution

- **Workflow** is a workspace-owned automation with a versioned definition. It
  can be triggered by a user, an external event, or another workflow. It
  performs work through an authorized runner.
- **Connector** adapts an outside source/signal into the normalized event
  contract expected by workflows. A **webhook** is an ingress mechanism tied to
  a connector; a webhook receipt/delivery is not itself the normalized event
  or a workflow run.
- **Runner** executes workflow work. A runner may be shared across workspaces
  (with an explicit workspace grant) or dedicated to one workspace. A user or
  agent must have the `admin` role in that workspace to enroll/manage its
  runner access. Runner labels/capabilities are scheduling metadata, not
  authorization.
- **Invocation** is an accepted or declined request to perform a workflow
  operation. **Run** is the execution created from an accepted invocation.
  Admission and execution completion are separate states. An invocation can
  have multiple matrix variants or run attempts; these identities must remain
  inspectable and distinct.

## Navigation, Streams, events, and conversation

The navigation hierarchy is:

```text
Workspace > Streams > Stream > Thread
```

A user switches the entire workspace context from a persistent left rail of
tab-like workspace buttons, each represented by its project's avatar. A
workspace is the top-level company/project space, not a stream. Within the
selected workspace, the `#<name>` sidenav lists Streams. Selecting a Stream
opens its live work view; selecting a Thread opens the smallest conversational
unit of work. A top-bar search and a global `Cmd+K` dialog provide quick
navigation/switching across workspaces, Streams, and Threads. Search visibility
must not bypass workspace authorization.

- **Stream** is a workspace-owned, real-time view of work. A workspace can
  contain multiple streams. A stream presents an ordered/reconcilable feed of
  events and live UI cards; it is not a static transcript and is not itself an
  event.
- **Event** is an immutable, typed occurrence in the platform's event model.
  Events can represent normalized external signals, workflow/run lifecycle
  facts, or other domain occurrences. A stream may present an event, but the
  event's durable identity and delivery state are separate from its card.
- **Thread** is the smallest conversational unit of work within a Stream, where
  users, agents, and automations can post and collaborate. Mentions use the
  globally unique `@<name>`. A Thread is not a synonym for a Stream or event.
- **Live card** is a UI projection of an entity such as a webhook receipt,
  invocation, or running job. Cards update as their underlying durable state
  changes; they are not independent sources of truth.

The intended workspace experience places live events, cards, threads, and runs
in Streams. Workflows are discoverable in a workspace sidenav and can be edited
within the workspace experience. Workspace settings remain a first-class,
explicit action. The terms `channel` and `channels` in current implementation
paths are legacy naming until an explicit compatibility/migration decision
replaces them.

## Related entities to keep distinct

The model also needs **workspace membership** (the user/workspace relationship
that carries a role), **workflow revision** (the exact immutable definition
used by an invocation), **subscription/binding** (the durable rule that routes
an event or user request to a workflow), **webhook receipt** (authenticated
transport evidence), **event delivery** (one consumer's processing state), and
**step attempt/checkpoint** (execution evidence and recovery data). None should
be collapsed into a user, stream, event, invocation, or run.

## Open decisions

1. How are globally unique mention names normalized, reserved, and renamed?
   What happens to historical mentions after a rename?
2. Are `viewer`, `collaborator`, and `admin` strictly workspace-membership
   roles (recommended), or is there also a platform-wide role? Can one user
   hold different roles in different workspaces?
3. Can agents be invited/owned like human users, and what identity lifecycle,
   revocation, and audit fields distinguish them?
4. Are Streams configured resources with their own memberships/retention, or
   scoped to workspace membership? Can one event/run appear in multiple
   Streams without duplicating execution?
5. Can a Thread span Streams, or does it belong to exactly one? What are the
   author, edit/delete, reply, and retention rules for posts?
6. Does every workspace start with a default Stream, and can a Stream contain
   multiple Threads as well as unthreaded event/run cards?
7. Which administrator actions are required for runner enrollment, shared
   runner grants, secret access, and agent workflow tools? These should be
   explicit capabilities, not inferred from labels or mentionability.

Until decided, implementations must preserve workspace isolation, distinguish
actor kind from access role, and avoid treating a mention, stream membership, or
display name as authorization.
