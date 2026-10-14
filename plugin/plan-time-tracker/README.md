# Plan Time Tracker plugin source

This package binds to the existing private Plan Time Tracker Site App and provides the independent `track-plan` skill, metadata-only recovery fixtures, and a local-only bounded queue helper for `AppendObservation` envelopes. The queue is stored under the operating system user's state directory, scoped by the authenticated opaque owner scope and a repository ID or `owner/name`, and never sends requests itself.

The Site MCP remains the only tracker API and retains platform owner authentication. The package contains no runtime credentials, identity headers, or alternative authentication path. Web/cloud sessions are ephemeral; durable queue behavior is offered only when the local helper and writable state directory are available.

The helper accepts one JSON object on stdin and an operation argument (`enqueue`, `next`, `begin`, `acknowledge`, `fail`, `requeue-pending`, or `list`). Every call supplies `ownerScope` from `GetTrackerCapabilities` and a repository ID or `owner/name` as `repositoryContext`. `enqueue` also takes the exact observation `envelope`; send operations use the returned `commandId`. `fail` takes `retryable`, `errorCode`, and optional `retryAfterMs` from the MCP result. The helper never performs network requests or chooses lifecycle actions.
