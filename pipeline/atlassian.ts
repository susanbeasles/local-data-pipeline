import { createHash } from "node:crypto";
import type { Task } from "./intake.ts";

type Object = Record<string, unknown>;
function object(value: unknown): Object {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid response object");
  return value as Object;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical((value as Object)[key]))
        .join(",") +
      "}"
    );
  const result = JSON.stringify(value);
  if (result === undefined) throw Error("task must contain JSON values");
  return result;
}
export function task(
  name: string,
  cloudId: string,
  inputs: Object,
  kind: string,
  scope: string,
  entity?: string,
): Task {
  const value = { name, cloudId, inputs, kind, scope, ...(entity === undefined ? {} : { entity }) };
  return { id: createHash("sha256").update(canonical(value)).digest("hex"), ...value };
}
const types = [
  "page",
  "live_doc",
  "blogpost",
  "whiteboard",
  "database",
  "embed",
  "smart_link",
  "folder",
  "slide",
];
export function seed({
  cloudId,
  projects,
  spaces,
}: {
  cloudId: string;
  projects: string[];
  spaces: string[];
}): Task[] {
  return [
    ...projects.map((project) =>
      task(
        "searchJiraIssuesUsingJql",
        cloudId,
        {
          jql: `project = ${JSON.stringify(project)} ORDER BY id ASC`,
          maxResults: 10,
          view: "full",
          fields: ["*all"],
          responseContentFormat: "html",
          searchResultMode: "issues",
        },
        "jira",
        project,
      ),
    ),
    ...spaces.flatMap((spaceId) =>
      types.flatMap((type) =>
        [
          "current",
          "archived",
          ...(["page", "blogpost"].includes(type) ? ["draft", "trashed"] : []),
        ].map((status) =>
          task(
            "listConfluenceContent",
            cloudId,
            { spaceId, type, status, limit: 20 },
            "confluence",
            spaceId,
          ),
        ),
      ),
    ),
  ];
}
function payload(response: unknown, operation: string): Object {
  let body = object(response);
  check(body);
  if (body.structuredContent !== undefined) body = object(body.structuredContent);
  else if (Array.isArray(body.content)) {
    const texts = body.content.filter((item) => object(item).type === "text");
    if (texts.length !== 1 || typeof object(texts[0]).text !== "string")
      throw Error("expected one JSON text response");
    body = object(JSON.parse(object(texts[0]).text as string));
  } else throw Error("expected MCP response");
  check(body);
  if (body.data !== undefined) body = operation === "listJiraIssueRemoteIssueLinks" && Array.isArray(body.data) ? { links: body.data.map(object) } : object(body.data);
  check(body);
  return body;
}
function check(value: Object) {
  if (
    value.ok === false ||
    value.isError ||
    value.error ||
    value.truncated ||
    value.isTruncated ||
    value.truncation ||
    (Array.isArray(value.errors) && value.errors.length)
  )
    throw Error("connector error or truncated response");
}
function list(body: Object, key: string): Object[] {
  if (!Array.isArray(body[key])) throw Error(`missing ${key} array`);
  return body[key].map(object);
}
function id(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0)
    throw Error("missing entity identifier");
  return String(value);
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw Error("invalid pagination number");
  return value as number;
}
export function expand(job: Task, response: unknown): Task[] {
  const body = payload(response, job.name),
    children: Task[] = [];
  const add = (name: string, inputs: Object, entity = job.entity) =>
    children.push(task(name, job.cloudId, inputs, job.kind, job.scope, entity));
  const page = (inputs: Object) => add(job.name, { ...job.inputs, ...inputs });
  const cursor = () => {
    let next = body.nextCursor;
    if (next === undefined && body._links !== undefined) {
      const link = object(body._links).next;
      if (link !== undefined && link !== null && link !== "") {
        if (typeof link !== "string") throw Error("invalid next link");
        const url = new URL(link, "https://pagination.invalid");
        next = url.searchParams.get("cursor");
        if (!next) throw Error("next link missing cursor");
      }
    }
    if (next !== undefined && next !== null && next !== "") {
      if (typeof next !== "string" || next === job.inputs.cursor)
        throw Error("invalid or repeated cursor");
      page({ cursor: next });
    }
  };
  const offsets = (records: Object[]) => {
    const start = number(body.startAt ?? job.inputs.startAt ?? 0),
      total = number(body.total);
    if (start !== (job.inputs.startAt ?? 0)) throw Error("unexpected page offset");
    const size = body.maxResults === undefined ? records.length : number(body.maxResults);
    if (start + records.length < total) {
      if (!records.length || !size) throw Error("empty page with remaining records");
      page({ startAt: start + size });
    }
  };
  switch (job.name) {
    case "searchJiraIssuesUsingJql": {
      for (const issue of list(body, "issues")) {
        const key = id(issue.key ?? issue.id);
        add(
          "listJiraIssueComments",
          {
            issueIdOrKey: key,
            maxResults: 20,
            startAt: 0,
            responseContentFormat: "html",
            reactionDetail: "users",
          },
          key,
        );
        add("listJiraIssueChangelogs", { issueIdOrKey: key, maxResults: 20, startAt: 0 }, key);
        add(
          "listJiraIssueWorklogs",
          {
            issueIdOrKey: key,
            maxResults: 20,
            startAt: 0,
            responseContentFormat: "html",
            expand: "properties",
          },
          key,
        );
        add("listJiraIssueRemoteIssueLinks", { issueIdOrKey: key }, key);
      }
      if (typeof body.isLast !== "boolean") throw Error("missing Jira isLast");
      if (!body.isLast) {
        const next = body.nextPageToken;
        if (typeof next !== "string" || !next || next === job.inputs.nextPageToken)
          throw Error("invalid or repeated Jira cursor");
        page({ nextPageToken: next });
      }
      break;
    }
    case "listJiraIssueComments":
      offsets(list(body, "comments"));
      break;
    case "listJiraIssueChangelogs":
      offsets(list(body, "values"));
      break;
    case "listJiraIssueWorklogs":
      offsets(list(body, "worklogs"));
      break;
    case "listConfluenceContent": {
      const type = String(job.inputs.type);
      for (const item of list(body, "results")) {
        const contentId = id(item.id);
        const format =
          type === "whiteboard"
            ? "svg"
            : type === "database"
              ? "csv"
              : ["embed", "smart_link"].includes(type)
                ? "url"
                : "html";
        add(
          "getConfluenceContent",
          {
            content_id: contentId,
            ...(["page", "live_doc", "blogpost"].includes(type) ? { detail: "full" } : {}),
            content_format: format,
            ...(job.inputs.status === "draft" && ["page", "blogpost"].includes(type)
              ? { draft: true }
              : {}),
          },
          contentId,
        );
        if (["page", "blogpost", "live_doc"].includes(type))
          add("listConfluenceContentVersions", { contentId, limit: 20 }, contentId);
        if (["page", "blogpost"].includes(type)) {
          add(
            "listConfluenceComments",
            {
              "content-id": contentId,
              "body-format": "html",
              "include-replies": true,
              "content-type": type,
              limit: 20,
            },
            contentId,
          );
          add(
            "listConfluenceAttachments",
            { contentId, limit: 20, status: "current,archived" },
            contentId,
          );
        }
      }
      cursor();
      break;
    }
    case "listConfluenceContentVersions":
      for (const version of list(body, "results"))
        add("getConfluenceContentVersion", {
          contentId: job.inputs.contentId,
          versionNumber: number(version.number),
          content_format: "html",
        });
      cursor();
      break;
    case "listConfluenceAttachments":
      for (const attachment of list(body, "results")) {
        const attachmentId = id(attachment.id);
        if (attachment.version !== undefined)
          add(
            "getConfluenceAttachment",
            { attachmentId, version: number(object(attachment.version).number) },
            attachmentId,
          );
      }
      cursor();
      break;
    case "listConfluenceComments":
      list(body, Array.isArray(body.comments) ? "comments" : "results");
      cursor();
      break;
    case "getConfluenceContent":
    case "getConfluenceContentVersion":
    case "getConfluenceAttachment":
    case "listJiraIssueRemoteIssueLinks":
      break;
    default:
      throw Error(`unsupported operation ${job.name}`);
  }
  return children;
}
