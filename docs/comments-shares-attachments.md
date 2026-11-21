# Comments, shares and attachments

Read and post comments, create share links, and save the images and files embedded in a document. Posting, sharing and permission changes need `performAction:true`.

## Comments

List the comments on a document, with replies nested under their parent:

```sh
outline-cli invoke comments.list \
  --args '{"query":"incident runbook","includeReplies":true,"limit":20,"view":"summary"}'
```

To read one thread's replies, pass `parentCommentId` instead of `includeReplies`.

Post a comment from plain Markdown text. The CLI builds Outline's rich-text document for you:

```sh
outline-cli invoke comments.create \
  --args '{"query":"incident runbook","text":"Looks good.","performAction":true}'
```

Add `mentions` to tag people by name, email or user ID. The CLI resolves them and inserts the mentions at the start of the comment. A name matches on the first name, so `"Tran Le Quan"` finds a user Outline stores as `"Quan, Tran Le"`.

```sh
outline-cli invoke comments.create \
  --args '{"query":"incident runbook","text":"Please review the rollback steps.","mentions":["Tran Le Quan","alice@example.com"],"performAction":true}'
```

Reply to a comment with `parentCommentId` and the document's ID:

```sh
outline-cli invoke comments.post \
  --args '{"documentId":"<doc-id>","parentCommentId":"<comment-id>","text":"Confirmed.","performAction":true}'
```

Comment text is limited to 1000 characters, and the CLI checks that before it calls Outline. Real newlines and `\n` or `\r\n` sequences turn into line breaks, so comments never show a literal `\n`. `comments.post` is another name for `comments.create`.

`comments.review_queue` lists comments across documents or a whole collection, so you can work through them in one pass:

```sh
outline-cli invoke comments.review_queue \
  --args '{"collectionQuery":"engineering","includeReplies":true,"view":"summary"}'
```

## Share links

```sh
outline-cli invoke shares.list \
  --args '{"documentQuery":"public handbook","limit":10,"view":"summary"}'

outline-cli invoke shares.create \
  --args '{"documentQuery":"public handbook","published":true,"performAction":true}'
```

`shares.info` reads one share. `shares.update` and `shares.revoke` change or remove it, and both need `performAction:true`. Check the target document before you create a share.

## Attachments and images

List what a document embeds, then save it to disk:

```sh
outline-cli invoke documents.attachments \
  --args '{"query":"example title"}'

outline-cli invoke documents.download_attachments \
  --args '{"refs":["example title"],"outputDir":"./outline-attachments","overwrite":true}'

outline-cli invoke attachments.download \
  --args '{"id":"<attachment-id>","outputDir":"./outline-attachments","overwrite":true}'
```

Use these tools instead of calling `attachments.redirect` through `api.call`, because that endpoint returns binary data. `attachments.download` also accepts `filePath` for an exact output path, but not together with `outputDir` or `fileName`.

To upload a local file as a new document, use `documents.import_file`. Run `outline-cli tools contract documents.import_file` for its arguments.

## Permissions

You can see and change who has access to a document, collection or group with names or emails instead of IDs:

```sh
outline-cli invoke documents.users --args '{"query":"incident runbook","limit":20,"view":"summary"}'
outline-cli invoke collections.memberships --args '{"query":"engineering","limit":20,"view":"summary"}'

outline-cli invoke documents.add_user \
  --args '{"documentQuery":"incident runbook","userQuery":"alice@example.com","permission":"read","performAction":true}'

outline-cli invoke collections.add_group \
  --args '{"query":"engineering","groupQuery":"security","permission":"read_write","performAction":true}'
```

The `*.add_user`, `*.remove_user`, `*.add_group` and `*.remove_group` tools exist for documents and collections, and `groups.add_user` and `groups.remove_user` manage group members. [Tools](tools.md) lists them all.
