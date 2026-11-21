# Delete documents

Deleting a document takes two steps: you read it first to get a short-lived token, then you delete with that token. The gate stops a delete based on a stale or guessed ID.

## Delete a document

1. Read the document with `armDelete`. The result includes a `deleteReadReceipt`:

   ```sh
   outline-cli invoke documents.info \
     --args '{"id":"<document-id>","armDelete":true,"view":"summary"}'
   ```

   The receipt holds the `token`, the `documentId`, the `revision` you read, and `issuedAt`, `expiresAt` and `ttlSeconds`.

2. Delete with the token as `readToken`, plus `performAction`:

   ```sh
   outline-cli invoke documents.delete \
     --args '{"id":"<document-id>","readToken":"<token>","performAction":true}'
   ```

## What the gate checks

The delete fails, and nothing is removed, in these cases:

| Situation | Error code |
| --- | --- |
| No `readToken` | `DELETE_READ_TOKEN_REQUIRED` |
| Unknown or expired token | `DELETE_READ_TOKEN_INVALID` |
| Token from a different profile | `DELETE_READ_TOKEN_PROFILE_MISMATCH` |
| Token issued for a different document | `DELETE_READ_TOKEN_DOCUMENT_MISMATCH` |
| The document changed after you read it | `DELETE_READ_TOKEN_STALE` |
| No `performAction:true` | `ACTION_GATED` |

A token works once. After a successful delete it is removed. Tokens expire after 15 minutes (900 seconds) unless you set `readTokenTtlSeconds` on the read, which is limited to between 60 and 86,400 seconds. After an error, read the document again with `armDelete:true` to get a fresh token.

Deleting through `api.call` with a `documents.delete` method goes through the same token check.

## Other removal tools

`documents.archive` archives a document and `documents.restore` brings one back. `documents.permanent_delete` and `documents.empty_trash` remove documents for good. All four need `performAction:true`. The read token is checked by `documents.delete` and by `api.call` with those methods, not by `documents.permanent_delete`, so read the document and confirm the target yourself before a permanent delete. `documents.deleted` and `documents.archived` list what is in the trash or the archive.
