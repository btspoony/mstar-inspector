# ADR: Replace the review slash command with a bare bot mention

Status: implemented — A bare mention is the sole comment-trigger grammar.

## Problem

The existing comment trigger uses `/review`; an explicit user request calls for a bot-mention trigger with no required command wording.

## Decision

The comment trigger recognizes the resolved App bot’s bare mention anywhere in the comment. `/review` is retired outright, without a compatibility alias or deprecation window; discussion stays untrusted evidence, not natural-language commands.

## Alternatives considered

- **Extend the `/review` command family:** the source records this deferred candidate as superseded by the explicit direction to replace, not extend, the command.
- **Keep a compatibility alias/deprecation window:** the source rejects both under the development-stage clean new-App contract.

## Consequences

The prefix grammar, tests and wire label `review_command` are removed; mention jobs use `issue_comment`. The settings surface displays the exact cached-slug mention, or no mention before first sync. Existing actor authorization and pause gates still apply.
