const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const keySource = read("assets/key.js");
const loginSource = read("assets/login.js");
const playgroundSource = read("assets/playground.js");

// These checks inspect shipped HTML, unlike the client-state fixture that
// creates a synthetic node for every ID requested by the application.
function parseMarkup(source) {
  const nodes = [];
  const stack = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const tagPattern = /<\/?([A-Za-z][A-Za-z0-9:-]*)(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  for (const match of source.replace(/<!--[\s\S]*?-->/g, "").matchAll(tagPattern)) {
    const markup = match[0];
    const tag = match[1].toLowerCase();
    if (markup.startsWith("</")) {
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index !== -1) stack.splice(index);
      continue;
    }
    const attrs = {};
    const attributes = markup.slice(match[1].length + 1, -1).replace(/\/$/, "");
    for (const attr of attributes.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    }
    const node = { tag, attrs, parent: stack.at(-1), children: [] };
    node.parent?.children.push(node);
    nodes.push(node);
    if (!voidTags.has(tag) && !markup.endsWith("/>")) stack.push(node);
  }
  return { nodes, ids: new Map(nodes.filter((node) => node.attrs.id).map((node) => [node.attrs.id, node])) };
}

const documents = { "key.html": parseMarkup(read("key.html")), "login.html": parseMarkup(read("login.html")) };
const literalStrings = (source) => [...source.matchAll(/(["'])([^"'\r\n]+)\1/g)].map((match) => match[2]);
const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
function requireIds(document, ids, context) {
  const missing = [...new Set(ids)].filter((id) => !document.ids.has(id));
  assert.deepEqual(missing, [], `${context}: missing HTML IDs: ${missing.join(", ")}`);
}

for (const [filename, document] of Object.entries(documents)) {
  test(`${filename} has unique nonempty IDs`, () => {
    const ids = document.nodes.filter((node) => Object.hasOwn(node.attrs, "id")).map((node) => node.attrs.id);
    assert.ok(ids.length > 0, "No HTML IDs were parsed");
    assert.equal(ids.includes(""), false, "Empty IDs are not valid runtime targets");
    assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], "Duplicate HTML IDs");
  });

  test(`${filename} labels and ARIA references point to existing elements`, () => {
    for (const node of document.nodes) {
      for (const attribute of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
        if (!node.attrs[attribute]) continue;
        requireIds(document, node.attrs[attribute].trim().split(/\s+/), `${node.tag}[${attribute}]`);
      }
    }
  });
}

test("key client literal and loop-based element targets exist in shipped key.html", () => {
  const direct = [...keySource.matchAll(/\bbyId\(\s*(["'])([^"']+)\1\s*\)/g)].map((match) => match[2]);
  assert.ok(direct.length > 0, "The key-client ID extractor matched nothing");
  const loops = [...keySource.matchAll(/for\s*\(\s*const\s+id\s+of\s+\[((?:\s*["'][^"']+["']\s*,?)+)\]\s*\)/g)]
    .flatMap((match) => literalStrings(match[1]));
  const conditionals = [...keySource.matchAll(/\bbyId\(([^()\r\n]*\?[^()\r\n]*)\)/g)]
    .flatMap((match) => literalStrings(match[1]));
  const messages = [...keySource.matchAll(/\bshowFormMessage\(\s*(["'])([^"']+)\1/g)].map((match) => match[2]);
  requireIds(documents["key.html"], [...direct, ...loops, ...conditionals, ...messages], "assets/key.js");
});

test("login client literal element targets exist in shipped login.html", () => {
  const ids = [...loginSource.matchAll(/\bgetElementById\(\s*(["'])([^"']+)\1\s*\)/g)].map((match) => match[2]);
  assert.ok(ids.length > 0, "The login-client ID extractor matched nothing");
  requireIds(documents["login.html"], ids, "assets/login.js");
});

test("playground dynamically constructed IDs and input types match its real markup", () => {
  const init = playgroundSource.slice(playgroundSource.indexOf("function init("));
  const list = /const\s+ids\s*=\s*\[([^\]]+)\]/.exec(init);
  assert.ok(list, "Could not find the playground runtime suffix list");
  const suffixes = literalStrings(list[1]);
  assert.ok(suffixes.length > 0);
  const document = documents["key.html"];
  requireIds(document, suffixes.map((suffix) => `playground-${suffix}`), "assets/playground.js");
  for (const [suffix, tag] of Object.entries({ form: "form", key: "input", model: "select", prompt: "textarea", limit: "input", send: "button", stop: "button", copy: "button", clear: "button" })) {
    assert.equal(document.ids.get(`playground-${suffix}`)?.tag, tag, `playground-${suffix} must be a ${tag}`);
  }
  assert.equal(document.ids.get("playground-key").attrs.type, "password");
  assert.equal(document.ids.get("playground-limit").attrs.type, "number");
  assert.ok(document.ids.get("playground-view")?.attrs["data-module"], "Lazy playground module path is missing");
});

test("copy controls target real input values and close controls target native dialogs", () => {
  const document = documents["key.html"];
  const copyControls = document.nodes.filter((node) => Object.hasOwn(node.attrs, "data-copy-target"));
  assert.ok(copyControls.length > 0);
  for (const control of copyControls) {
    const target = document.ids.get(control.attrs["data-copy-target"]);
    assert.equal(target?.tag, "input", `Copy target ${control.attrs["data-copy-target"]} must be an input`);
    assert.ok(Object.hasOwn(target.attrs, "value"), "Copy target must provide a value");
  }
  for (const control of document.nodes.filter((node) => Object.hasOwn(node.attrs, "data-close-dialog"))) {
    assert.equal(document.ids.get(control.attrs["data-close-dialog"])?.tag, "dialog", "Close control must target a native dialog");
    assert.equal(control.tag, "button");
    assert.equal(control.attrs.type, "button", "Close control must not submit a form");
  }
  for (const id of ["user-dialog", "password-dialog", "command-dialog"]) assert.equal(document.ids.get(id)?.tag, "dialog", id);
});

test("querySelector descendant contracts and login form membership remain intact", () => {
  for (const [filename, id] of [["key.html", "key-help"], ["key.html", "toast"], ["login.html", "login-submit"]]) {
    const node = documents[filename].ids.get(id);
    assert.ok(node && descendants(node).some((child) => child.tag === "span"), `${id} requires a descendant span`);
  }
  const form = documents["login.html"].ids.get("login-form");
  assert.equal(form?.tag, "form");
  const children = new Set(descendants(form));
  for (const id of ["login-username", "login-password", "login-submit"]) assert.ok(children.has(documents["login.html"].ids.get(id)), `${id} must belong to login-form`);
});

test("navigation roots and the authentication content gate remain present", () => {
  const document = documents["key.html"];
  for (const [nav, view] of [["overview", "overview"], ["playground", "playground"], ["models", "models"], ["start", "setup"], ["users", "users"]]) {
    const control = document.ids.get(`nav-${nav}`);
    assert.ok(control && ["button", "a"].includes(control.tag), `nav-${nav} must be actionable`);
    assert.ok(document.ids.has(`${view}-view`), `${view}-view is missing`);
  }
  for (const id of ["models-view", "playground-view", "setup-view", "users-view", "nav-users"]) assert.ok(Object.hasOwn(document.ids.get(id).attrs, "hidden"), `${id} should initially be hidden`);
  assert.ok(document.nodes.find((node) => node.tag === "body")?.attrs.class.split(/\s+/).includes("auth-pending"));
  requireIds(document, ["auth-cover", "auth-status", "retry-auth"], "Authentication content gate");
});

test("compact navigation stays named and playground starters never submit the form", () => {
  const document = documents["key.html"];
  assert.equal(document.ids.get("open-command")?.attrs["aria-label"], "Hızlı geçiş");
  const group = document.nodes.find((node) => node.attrs.class?.split(/\s+/).includes("playground-starters"));
  assert.equal(group?.attrs.role, "group");
  assert.equal(group?.attrs["aria-label"], "Örnek mesajlar");
  const starters = descendants(group).filter((node) => Object.hasOwn(node.attrs, "data-playground-prompt"));
  assert.deepEqual(starters.map((node) => node.attrs["data-playground-prompt"]), ["idea", "code", "edit"]);
  for (const button of starters) {
    assert.equal(button.tag, "button");
    assert.equal(button.attrs.type, "button", "A starter must not spend tokens by submitting");
  }
});
