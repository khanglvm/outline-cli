# Tools

Look up any tool you can run with `outline-cli invoke <tool>` and whether it needs `performAction`. For the exact arguments of any tool, run `outline-cli tools contract <name>`.

There are 137 tools. Tool names also work with underscores in place of dots (`documents_search`), and a few shorthand names such as `docs.answer` map to a full tool. The `Gated` column is `yes` when the tool's signature includes `performAction`, which means the call fails with `ACTION_GATED` unless you pass `"performAction":true`.

Run `outline-cli tools list` for the same list as JSON, `outline-cli tools contract all --result-mode inline` for every signature and usage example, and `outline-cli tools help ai-skills --view full` for scenario playbooks written for agents.


## Core

| Tool | What it does | Gated |
| --- | --- | --- |
| `api.call` | Call any Outline API RPC endpoint directly. | yes |
| `auth.info` | Return authenticated user and team info to confirm profile permissions. | no |
| `capabilities.map` | Return effective profile capabilities from auth context and optional policy summary. | no |

## Search and read documents

| Tool | What it does | Gated |
| --- | --- | --- |
| `documents.search` | Search documents with single or multi-query batch in one invocation. | no |
| `documents.list` | List documents with filtering and pagination. | no |
| `documents.info` | Read one or many documents by UUID, slug, or document URL. | no |
| `documents.resolve` | Resolve fuzzy document references by combining title search with semantic fallback and returning confidence-ranked candidates. | no |
| `documents.resolve_urls` | Resolve document URLs (doc/share links) into confidence-ranked document candidates with URL-id/host-aware boosts. | no |
| `documents.canonicalize_candidates` | Canonicalize noisy/duplicate candidate sets into stable clusters with one preferred canonical document per cluster. | no |
| `search.expand` | Search and then hydrate top-ranked documents in one call, returning compact joined search+document output. | no |
| `search.research` | Run multi-query, multi-source research retrieval with weighted reranking, optional diversification, hydration, and follow-up cursor support for multi-turn QA. | no |
| `documents.archived` | List archived documents, optionally resolving a remembered collection filter first. | no |
| `documents.deleted` | List deleted documents, optionally resolving a remembered collection filter first. | no |
| `documents.answer` | Answer a question using Outline AI over the selected document scope. | no |
| `documents.answer_batch` | Run multiple documents.answerQuestion calls with per-item isolation. | no |
| `documents.open` | Open one document by ID/share ID or resolve a remembered title, URL, or URL id through local memory plus bounded live fallback. | no |
| `documents.open_batch` | Open several documents by mixed IDs, share IDs, remembered titles, URL ids, or full URLs while deduplicating live hydration inside one CLI call. | no |

## Create and edit documents

| Tool | What it does | Gated |
| --- | --- | --- |
| `documents.create` | Create a new document in Outline. | no |
| `documents.update` | Update an existing document. | yes |
| `documents.safe_update` | Update document only if current revision matches expectedRevision. | yes |
| `documents.diff` | Resolve a document and compute a line-level diff between current document text and proposed text. | no |
| `documents.apply_patch` | Apply unified diff patch (or full replace) to a document and persist update. | yes |
| `documents.apply_patch_safe` | Apply patch with mandatory revision guard so writes only proceed from the expected document revision. | yes |
| `documents.batch_update` | Run multiple document updates in one call with per-item results. | yes |
| `documents.plan_batch_update` | Plan multi-document refactors/renames by previewing affected docs, replacement counts, and text hunks before applying. | no |
| `documents.plan_terminology_refactor` | Plan terminology refactors using glossary/map inputs and return plan_batch_update-compatible output with metadata. | no |
| `documents.apply_batch_plan` | Apply a previously generated batch-update plan with hash confirmation and revision-safe updates. | yes |
| `documents.templatize` | Convert a document into a template. | yes |
| `documents.import` | Import a document from JSON payload. | yes |
| `documents.import_file` | Upload a local file as multipart/form-data to documents.import while preserving deterministic output envelopes. | yes |
| `documents.create_from_template` | Create from template, optionally inject placeholder values, and enforce strict unresolved-placeholder safety. | yes |

## Delete, archive and restore

| Tool | What it does | Gated |
| --- | --- | --- |
| `documents.delete` | Delete a document with mandatory read-confirmation token and action gate. | yes |
| `documents.archive` | Archive a document. | yes |
| `documents.restore` | Restore a document. | yes |
| `documents.permanent_delete` | Permanently delete a document. | yes |
| `documents.empty_trash` | Empty document trash. | yes |
| `documents.cleanup_test` | Find and optionally delete test-created documents by marker prefix. | yes |

## Collections

| Tool | What it does | Gated |
| --- | --- | --- |
| `collections.list` | List collections visible to the current profile. | no |
| `collections.info` | Read one or many collections by ID. | no |
| `collections.create` | Create a collection. | no |
| `collections.update` | Update collection metadata. | yes |
| `collections.tree` | Build a parent/child document tree for a collection, resolving remembered collection names or URLs when needed. | no |
| `collections.memberships` | Resolve a collection and list collection user memberships. | no |
| `collections.group_memberships` | Resolve a collection and list collection group memberships. | no |
| `collections.add_user` | Resolve a collection and user before adding collection access. | yes |
| `collections.remove_user` | Resolve a collection and user before removing collection access. | yes |
| `collections.add_group` | Resolve a collection and group before adding group collection access. | yes |
| `collections.remove_group` | Resolve a collection and group before removing group collection access. | yes |
| `collections.open` | Open one collection by ID or resolve a remembered collection name, URL id, or URL through local memory plus bounded live fallback. | no |
| `collections.open_batch` | Open several collections by mixed IDs, remembered names, URL ids, or full URLs while deduplicating live hydration inside one CLI call. | no |

## Revisions

| Tool | What it does | Gated |
| --- | --- | --- |
| `revisions.list` | Resolve a document and list its revisions. | no |
| `revisions.diff` | Resolve a document and compute a line-level diff between explicit revision IDs or the latest two revisions. | no |
| `revisions.restore` | Restore a document to a specific revision using documents.restore endpoint. | yes |
| `revisions.info` | Get revision details. | no |

## Comments

| Tool | What it does | Gated |
| --- | --- | --- |
| `comments.list` | List comments on a document (and their replies). Resolve the target with documentId/query/refs/url/urlId. Use includeReplies=true to nest replies, or parentCommentId to fetch the replies of one thread. | no |
| `comments.info` | Get comment details. | no |
| `comments.create` | Post a comment on a document. Pass plain/markdown `text` and the ProseMirror `data` doc is built for you; pass `mentions` (names/emails/userIds) to auto-insert @-mentions. Use `parentCommentId` to reply. | yes |
| `comments.post` | Convenience alias of comments.create: post a comment from plain `text` + ergonomic `mentions`. The ProseMirror data doc and @-mention nodes are built for you. | yes |
| `comments.update` | Update a comment. | yes |
| `comments.delete` | Delete a comment. | yes |
| `comments.review_queue` | Build a deterministic comment review queue from comments.list responses, resolving remembered document or collection references when needed. | no |

## Shares

| Tool | What it does | Gated |
| --- | --- | --- |
| `shares.list` | List shares, optionally resolving a remembered document first. | no |
| `shares.info` | Get share details by share ID, document ID, or remembered document reference. | no |
| `shares.create` | Create a share for a document ID or remembered document reference. | yes |
| `shares.update` | Update a share. | yes |
| `shares.revoke` | Revoke a share. | yes |

## Templates

| Tool | What it does | Gated |
| --- | --- | --- |
| `templates.list` | List templates, optionally resolving a remembered collection filter first. | no |
| `templates.info` | Get template details by ID or remembered template name. | no |
| `templates.create` | Create a template. | yes |
| `templates.update` | Update a template by ID or remembered template name. | yes |
| `templates.delete` | Delete a template by ID or remembered template name. | yes |
| `templates.restore` | Restore a template by ID or remembered template name. | yes |
| `templates.duplicate` | Duplicate a template by ID or remembered template name. | yes |
| `templates.extract_placeholders` | Resolve a template by ID or remembered name and extract sorted unique placeholder keys ({{key}}) from template text nodes. | no |

## Attachments

| Tool | What it does | Gated |
| --- | --- | --- |
| `documents.attachments` | Extract embedded Outline attachment references from a document body, including images rendered through /api/attachments.redirect, resolving remembered document refs when needed. | no |
| `attachments.download` | Download one Outline attachment or embedded image through the authenticated attachments.redirect endpoint and save it locally. | no |
| `documents.download_attachments` | Resolve a document, extract all embedded Outline attachment references, and save each referenced file locally. | no |

## Users, groups and access

| Tool | What it does | Gated |
| --- | --- | --- |
| `users.list` | List users. | no |
| `users.info` | Get user details by ID/email or remembered user reference. | no |
| `users.invite` | Invite a user. | yes |
| `users.update_role` | Update a user's workspace role. | yes |
| `users.activate` | Activate a user. | yes |
| `users.suspend` | Suspend a user. | yes |
| `groups.list` | List groups. | no |
| `groups.info` | Get group details by ID or remembered group reference. | no |
| `groups.memberships` | Resolve a group and list group user memberships. | no |
| `groups.create` | Create a group. | yes |
| `groups.update` | Update a group. | yes |
| `groups.delete` | Delete a group. | yes |
| `groups.add_user` | Resolve a group and user before adding the user to the group. | yes |
| `groups.remove_user` | Resolve a group and user before removing the user from the group. | yes |
| `documents.users` | Resolve a document and list users with access to it. | no |
| `documents.memberships` | Resolve a document and list document user memberships. | no |
| `documents.group_memberships` | Resolve a document and list document group memberships. | no |
| `documents.add_user` | Resolve a document and user before adding document access. | yes |
| `documents.remove_user` | Resolve a document and user before removing document access. | yes |
| `documents.add_group` | Resolve a document and group before adding group document access. | yes |
| `documents.remove_group` | Resolve a document and group before removing group document access. | yes |

## Links and graph

| Tool | What it does | Gated |
| --- | --- | --- |
| `documents.backlinks` | List backlinks for a document by exact ID or by resolving a remembered title, share ID, URL id, or URL first. | no |
| `documents.graph_neighbors` | Collect one-hop graph neighbors and deterministic edge rows for source documents, resolving titles or URLs when needed. | no |
| `documents.graph_report` | Build a bounded BFS graph report with stable nodes[] and edges[] output, resolving seed titles or URLs when needed. | no |
| `documents.issue_refs` | Extract deterministic issue references (URL links and key-pattern matches) from one or more documents, resolving titles or URLs when needed. | no |
| `documents.issue_ref_report` | Resolve candidate documents from title+semantic search, then extract deterministic issue reference summaries. | no |

## Local memory

| Tool | What it does | Gated |
| --- | --- | --- |
| `memory.lookup` | Resolve recently observed documents, collections, users, groups, or templates from local profile-scoped memory without a network call, including remembered URL references. | no |
| `memory.resolve` | Resolve from local memory, fall back to a bounded live search on misses, and optionally live-hydrate top matches in one call. | no |
| `memory.resolve_batch` | Resolve multiple references from local memory, fall back to bounded live search for misses, and deduplicate optional live hydration in one call. | no |
| `memory.recent` | List recently observed local memory entries for the selected profile without a network call. | no |
| `memory.remember` | Manually store a local profile-scoped memory alias for a known document, collection, user, group, or template. | yes |
| `memory.stats` | Summarize the local profile-scoped observation index. | no |
| `memory.clear` | Clear local Outline CLI memory for the selected profile or all profiles. | yes |

## Federated sync

| Tool | What it does | Gated |
| --- | --- | --- |
| `federated.sync_manifest` | Generate deterministic document manifest rows for federated index sync workflows. | no |
| `federated.sync_probe` | Probe document findability across title and semantic search with per-query ranked hits. | no |
| `federated.permission_snapshot` | Capture per-document permission and membership snapshots for federated ACL reconciliation. | no |

## Workspace administration

| Tool | What it does | Gated |
| --- | --- | --- |
| `events.list` | List workspace events, optionally resolving remembered document, collection, and actor filters first. | no |
| `oauth_clients.list` | List OAuth clients. | no |
| `oauth_clients.info` | Get OAuth client details. | no |
| `oauth_clients.create` | Create an OAuth client. | yes |
| `oauth_clients.update` | Update an OAuth client. | yes |
| `oauth_clients.rotate_secret` | Rotate an OAuth client secret. | yes |
| `oauth_clients.delete` | Delete an OAuth client. | yes |
| `oauth_authentications.list` | List OAuth authentications. | no |
| `oauth_authentications.delete` | Delete an OAuth authentication. | yes |
| `oauthClients.delete` | Compatibility alias for oauth_clients.delete. | yes |
| `oauthAuthentications.delete` | Compatibility alias for oauth_authentications.delete. | yes |
| `data_attributes.list` | List data attributes. | no |
| `data_attributes.info` | Get data attribute details. | no |
| `data_attributes.create` | Create a data attribute. | yes |
| `data_attributes.update` | Update a data attribute. | yes |
| `data_attributes.delete` | Delete a data attribute. | yes |
| `webhooks.list` | List webhooks. | no |
| `webhooks.info` | Get webhook details. | no |
| `webhooks.create` | Create a webhook. | yes |
| `webhooks.update` | Update a webhook. | yes |
| `webhooks.delete` | Delete a webhook. | yes |
| `file_operations.list` | List file operations. | no |
| `file_operations.info` | Get file operation details. | no |
| `file_operations.delete` | Delete a file operation. | yes |
