import { test } from "node:test";
import assert from "node:assert/strict";
import { expand, seed, task } from "../atlassian.ts";
const response = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ data }) }],
});
const jira = () => seed({ cloudId: "cloud", projects: ["ABC"], spaces: [] })[0];
test("canonical IDs and deterministic seed", () => {
  assert.equal(
    task("x", "c", { b: 2, a: 1 }, "k", "s").id,
    task("x", "c", { a: 1, b: 2 }, "k", "s").id,
  );
  assert.equal(seed({ cloudId: "c", projects: [], spaces: ["1"] }).length, 22);
});
test("Jira cursor and explicit final page", () => {
  const children = expand(
    jira(),
    response({ issues: [{ key: "ABC-1" }], isLast: false, nextPageToken: "next" }),
  );
  assert.equal(children.length, 5);
  const next = children.at(-1)!;
  assert.equal(next.inputs.nextPageToken, "next");
  assert.deepEqual(expand(next, response({ issues: [], isLast: true })), []);
  assert.throws(
    () => expand(next, response({ issues: [], isLast: false, nextPageToken: "next" })),
    /cursor/,
  );
});
test("comment totals advance by effective page size and reject stalls", () => {
  const job = expand(jira(), response({ issues: [{ id: "1" }], isLast: true }))[0];
  assert.equal(
    expand(job, response({ comments: [{ id: "2" }], total: 3, startAt: 0, maxResults: 1 }))[0]
      .inputs.startAt,
    1,
  );
  assert.throws(
    () => expand(job, response({ comments: [], total: 3, startAt: 0, maxResults: 20 })),
    /empty page/,
  );
  assert.deepEqual(expand(job, response({ comments: [], total: 0, startAt: 0 })), []);
});
test("Confluence parses cursor only and schedules version bodies", () => {
  const job = task(
    "listConfluenceContent",
    "c",
    { spaceId: "1", type: "page", status: "current", limit: 20 },
    "confluence",
    "1",
  );
  const children = expand(
    job,
    response({
      results: [{ id: "2" }],
      _links: { next: "https://untrusted.invalid/path?cursor=abc" },
    }),
  );
  assert.equal(children.at(-1)!.inputs.cursor, "abc");
  assert.equal(children.at(-1)!.name, "listConfluenceContent");
  const versions = children.find((child) => child.name === "listConfluenceContentVersions")!;
  assert.deepEqual(expand(versions, response({ results: [{ number: 3 }] }))[0].inputs, {
    contentId: "2",
    versionNumber: 3,
    content_format: "html",
  });
  assert.throws(
    () => expand(children.at(-1)!, response({ results: [], nextCursor: "abc" })),
    /cursor/,
  );
});
test("errors, truncation and malformed lists fail visibly", () => {
  for (const data of [
    {},
    { issues: [], isLast: true, truncated: true },
    { issues: [], isLast: true, error: "failed" },
  ])
    assert.throws(() => expand(jira(), response(data)));
  assert.throws(() => expand(jira(), { isError: true, content: [] }));
  assert.throws(() => expand(jira(), { content: [{ type: "text", text: "not JSON" }] }));
  assert.deepEqual(
    expand(jira(), { structuredContent: { data: { issues: [], isLast: true } } }),
    [],
  );
});
test("attachments fetch only explicitly returned version numbers", () => {
  const job = task("listConfluenceAttachments", "c", { contentId: "1" }, "confluence", "s", "1");
  const jobs = expand(job, response({ results: [{ id: "2", version: { number: 5 } }] }));
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].inputs, { attachmentId: "2", version: 5 });
});
test('remote links accept array payloads and Confluence comments accept comments field',()=>{
 assert.deepEqual(expand(task('listJiraIssueRemoteIssueLinks','c',{issueIdOrKey:'ABC-1'},'jira','ABC'),response([])),[]);
 const job=task('listConfluenceComments','c',{'content-id':'1'},'confluence','1');
 assert.equal(expand(job,response({ok:true,comments:[],nextCursor:'next'}))[0]!.inputs.cursor,'next');
 assert.throws(()=>expand(job,response({ok:false,comments:[]})));
});
