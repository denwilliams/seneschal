import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedChannel } from "../workspace/resolve.ts";
import { checkPath, type JailConfig } from "./jail.ts";
import { findStaged } from "./attachments.ts";
import {
  addDocument,
  listCategories,
  listDocuments,
  readDocumentPage,
  removeDocument,
  searchDocuments,
  type DocumentEntry,
} from "./documents.ts";

/**
 * Tools for the document library.
 *
 * Shaped around how somebody actually uses a shelf of documents, which is not
 * how they use a database:
 *
 * - **Search returns descriptions, not documents.** A summary and a matching
 *   line is usually the whole answer, and when it is not, it is enough to
 *   choose which document to open. Returning bodies would spend a context
 *   window on the four documents that were not the one.
 * - **Reading is paged.** A forty-page contract does not fit in a turn, and an
 *   agent that reads the first twenty thousand characters and says so is more
 *   use than one that fails.
 * - **Filing takes the judgement and derives the facts.** The title, summary,
 *   category and tags come from the agent because they need a reader; the
 *   bytes, the checksum, the channel and the extraction come from the harness
 *   because they need to be true.
 */

export interface DocumentToolsContext {
  channel: ResolvedChannel;
  /** This channel's jail, applied to the path handed to `add_document`. */
  jail: JailConfig;
  currentUserId: () => string;
}

function describeForModel(entry: DocumentEntry): string {
  const flags = [
    entry.approximate ? "text extraction was approximate" : "",
    entry.truncated ? "only the first part of the document was extracted" : "",
  ].filter(Boolean);
  return (
    `- ${entry.id} — ${entry.title}\n` +
    `    category: ${entry.category}${entry.tags.length > 0 ? `, tags: ${entry.tags.join(", ")}` : ""}\n` +
    `    ${entry.summary.replace(/\n+/g, " ")}\n` +
    `    ${entry.filename}, ${entry.chars.toLocaleString()} characters, filed by ${entry.addedBy} on ${entry.addedAt.slice(0, 10)}` +
    (entry.source ? `, from ${entry.source}` : "") +
    (flags.length > 0 ? `\n    note: ${flags.join("; ")}` : "")
  );
}

export function createDocumentTools(ctx: DocumentToolsContext): ToolDefinition[] {
  const { channel } = ctx;
  if (!channel.documents.canRead && !channel.documents.canAdd) return [];

  const shared = channel.shared;
  const tools: ToolDefinition[] = [];

  const search = defineTool({
    name: "search_documents",
    label: "Search the document library",
    description:
      "Search documents anybody in this account has filed — contracts, policies, manuals, reports, notes. " +
      "Do this whenever a question sounds like it has a written answer somewhere, before saying you do not know and before looking it up on the web. " +
      "Returns titles, summaries and the matching line; use `read_document` for the text itself.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "What you are looking for, in the words someone would use. Terms are matched against the title, category, tags, summary and full text.",
      }),
      category: Type.Optional(
        Type.String({ description: "Restrict to one category, as shown by list_documents." }),
      ),
      limit: Type.Optional(Type.Number({ description: "How many documents to return. Default 8." })),
    }),
    execute: async (_id, params: { query: string; category?: string; limit?: number }) => {
      const hits = searchDocuments(shared, params.query, {
        ...(params.category ? { category: params.category } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      });
      if (hits.length === 0) {
        const total = listDocuments(shared).length;
        return {
          content: [
            {
              type: "text" as const,
              text:
                total === 0
                  ? "The document library is empty — nothing has been filed in this account yet. Say so rather than implying you looked in a full shelf."
                  : `Nothing in the document library matches "${params.query}". There are ${total} document(s) filed; \`list_documents\` shows what they are about.`,
            },
          ],
          details: { hits: 0, ids: [] as string[] },
        };
      }
      const lines = hits.map(
        (h) => `${describeForModel(h.entry)}${h.snippet ? `\n    match: "${h.snippet}"` : ""}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${hits.length} document(s) match "${params.query}":\n\n${lines.join("\n\n")}\n\n` +
              "Read one with `read_document` before quoting it — the summary is another agent's description, not the document.",
          },
        ],
        details: { hits: hits.length, ids: hits.map((h) => h.entry.id) },
      };
    },
  });

  const list = defineTool({
    name: "list_documents",
    label: "Browse the document library",
    description:
      "List what is in the document library, by category. " +
      "Call this before filing something so you reuse a category that already exists instead of inventing a near-duplicate, and when someone asks what documents there are.",
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({ description: "List the documents in one category instead of the categories." }),
      ),
    }),
    execute: async (_id, params: { category?: string }) => {
      const all = listDocuments(shared);
      if (all.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "The document library is empty — nothing has been filed yet." },
          ],
          details: { count: 0, categories: [] as string[] },
        };
      }

      if (params.category) {
        const wanted = all.filter((e) => e.category === params.category!.trim().toLowerCase());
        if (wanted.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No documents are filed under "${params.category}". Categories in use: ${listCategories(shared)
                  .map((c) => c.category)
                  .join(", ")}.`,
              },
            ],
            details: { count: 0, categories: [] as string[] },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `${wanted.length} document(s) in ${params.category}:\n\n${wanted.map(describeForModel).join("\n\n")}`,
            },
          ],
          details: { count: wanted.length, categories: [params.category] },
        };
      }

      const categories = listCategories(shared);
      const recent = all.slice(0, 5);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${all.length} document(s) in the library.`,
              "",
              "Categories in use — reuse one of these rather than inventing another:",
              ...categories.map((c) => `- ${c.category} (${c.count})`),
              "",
              "Most recently filed:",
              ...recent.map(describeForModel),
            ].join("\n"),
          },
        ],
        details: { count: all.length, categories: categories.map((c) => c.category) },
      };
    },
  });

  const read = defineTool({
    name: "read_document",
    label: "Read a document",
    description:
      "Read the text of a document in the library, a page at a time. " +
      "Do this before answering from a document: the summary was written by whichever agent filed it, and it is not the document. " +
      "If the text runs on, call again with `offset` — do not answer from the first page and imply you read the whole thing.",
    parameters: Type.Object({
      id: Type.String({ description: "Document id, as shown by search_documents or list_documents." }),
      offset: Type.Optional(
        Type.Number({ description: "Character to start at. Default 0; use the offset the last page ended at." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "How many characters to read. Default 20000." }),
      ),
    }),
    execute: async (_id, params: { id: string; offset?: number; limit?: number }) => {
      const page = readDocumentPage(shared, params.id.trim(), {
        ...(params.offset ? { offset: params.offset } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      });
      const { entry } = page;
      const caveats = [
        entry.approximate
          ? "The text was extracted approximately, so wording may be imperfect and layout is lost — say so if you quote it."
          : "",
        entry.truncated ? "The document was longer than the extraction cap; the end is missing." : "",
      ].filter(Boolean);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `# ${entry.title}`,
              `_${entry.filename}, filed by ${entry.addedBy} on ${entry.addedAt.slice(0, 10)}${entry.source ? `, from ${entry.source}` : ""}._`,
              ...caveats.map((c) => `_${c}_`),
              `_Characters ${page.offset}–${page.offset + page.text.length} of ${page.total}.${
                page.more ? ` Continue with offset ${page.offset + page.text.length}.` : " This is the end."
              }_`,
              "",
              page.text,
            ].join("\n"),
          },
        ],
        details: { id: entry.id, offset: page.offset, total: page.total, more: page.more },
      };
    },
  });

  if (channel.documents.canRead) tools.push(search, list, read);

  // Offered even where it is not allowed, like `publish_skill`: an agent that
  // has no such tool has no idea a library exists to file into, and answers
  // "can you keep this?" with a flat no.
  const add = defineTool({
    name: "add_document",
    label: "File a document",
    description:
      "File a document into the account's document library, so every channel can find it later. " +
      "Use this for anything somebody attaches that has lasting value — a policy, a contract, a manual, a spec, a report — and for a document you wrote yourself that is worth keeping. " +
      "Read it first: the summary and category you give are what everyone searches against, and a summary written from the filename is worse than not filing it. " +
      "Do not file something transient (a screenshot of an error, a one-off CSV), and never file anything private or sensitive — the library is readable by every channel in this account.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Path to the file, as given to you when it was attached (usually under `attachments/`), or a path in your workspace for something you wrote.",
      }),
      title: Type.String({
        description: "What someone would call this document when looking for it. Not the filename.",
      }),
      summary: Type.String({
        description:
          "A few sentences: what this document is, what is actually in it, and when someone here would need it. This is what search matches and what people read instead of opening it.",
      }),
      category: Type.String({
        description:
          "A short slug grouping it with its like — `hr`, `contracts`, `product-specs`. Check `list_documents` and reuse an existing category where one fits.",
      }),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Up to 8 short tags for the things this document is about. Names, systems, projects.",
        }),
      ),
      note: Type.Optional(
        Type.String({ description: "One line of context: where it came from, or what it supersedes." }),
      ),
    }),
    execute: async (
      _id,
      params: { path: string; title: string; summary: string; category: string; tags?: string[]; note?: string },
    ) => {
      if (!channel.documents.canAdd) {
        throw new Error(
          "This channel cannot file documents. The library is readable across the whole account, so an operator " +
            "decides which channels put things on it: `share.documentsAdd: true` for this channel. " +
            "Tell the person that, and offer to summarise the document in the conversation instead.",
        );
      }

      const raw = params.path?.trim();
      if (!raw) throw new Error("add_document needs the path of the file to file.");

      // The same check `read` gets: a path outside this channel's roots is a
      // way to file another channel's private notes into a shared library.
      const decision = checkPath(ctx.jail, raw, "read");
      if (!decision.allowed) {
        throw new Error(
          decision.reason ?? `${raw} is outside this channel's workspace, so it cannot be filed.`,
        );
      }

      // An attachment is filed as it arrived, with the extraction the harness
      // already did — the agent names the text it read, not the original, and
      // it should not have to know the difference.
      const staged = findStaged(channel.paths, decision.resolved);
      const source =
        staged?.source ??
        `written in ${channel.ref.name ? `#${channel.ref.name}` : "this channel"}`;

      // The text is extracted again from the original rather than taken from
      // the staged copy. The staged text sits in the workspace, which the
      // agent can write to, and a library whose text is whatever the agent
      // last wrote there is not a record of anything.
      const result = await addDocument(shared, channel, {
        path: staged?.originalPath ?? decision.resolved,
        ...(staged ? { filename: staged.filename } : {}),
        ...(staged?.mimeType ? { mimeType: staged.mimeType } : {}),
        source,
        ...(ctx.currentUserId() ? { addedByUser: ctx.currentUserId() } : {}),
        title: params.title,
        summary: params.summary,
        category: params.category,
        ...(params.tags ? { tags: params.tags } : {}),
        ...(params.note ? { note: params.note } : {}),
      });

      if (result.duplicateOf) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `That exact file is already in the library as \`${result.duplicateOf.id}\` ("${result.duplicateOf.title}"), ` +
                `filed by ${result.duplicateOf.addedBy} on ${result.duplicateOf.addedAt.slice(0, 10)}. ` +
                "Nothing was changed. Tell the person it is already there and where to find it.",
            },
          ],
          details: {
            id: result.duplicateOf.id,
            category: result.duplicateOf.category,
            version: result.duplicateOf.version,
            duplicate: true,
          },
        };
      }

      const { entry } = result;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              result.replacedVersion
                ? `Updated \`${entry.id}\` to v${entry.version}.`
                : `Filed "${entry.title}" as \`${entry.id}\` under ${entry.category}.`,
              "Every channel in this account can find it from now on.",
              result.alongside
                ? `Note: \`${result.alongside.id}\` already had that title ("${result.alongside.title}", from ${result.alongside.addedBy}). ` +
                  "If they are the same document, remove one; if they are not, say which is which in your reply."
                : "",
              entry.approximate
                ? "The text was extracted approximately, so the stored copy may differ in wording from the original."
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          },
        ],
        details: { id: entry.id, category: entry.category, version: entry.version, duplicate: false },
      };
    },
  });

  const remove = defineTool({
    name: "remove_document",
    label: "Remove a document",
    description:
      "Take a document this channel filed off the shelf — it was superseded, filed by mistake, or should never have been shared. " +
      "You can only remove what this channel filed. Removing deletes the stored text and the original.",
    parameters: Type.Object({
      id: Type.String({ description: "Document id, as shown by search_documents." }),
    }),
    execute: async (_id, params: { id: string }) => {
      const removed = removeDocument(shared, channel, params.id.trim());
      if (!removed) throw new Error(`The document library has nothing filed as \`${params.id}\`.`);
      return {
        content: [{ type: "text" as const, text: `Removed \`${params.id}\` from the document library.` }],
        details: { id: params.id },
      };
    },
  });

  tools.push(add);
  if (channel.documents.canAdd) tools.push(remove);

  return tools;
}
