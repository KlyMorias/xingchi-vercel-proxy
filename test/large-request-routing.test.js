const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../vercel.json");
const { MAX_WIRE_BYTES } = require("../lib/request-body");

const generationPaths = ["/api", "/v1", "/api/v1"].flatMap((prefix) =>
  ["responses", "messages", "chat/completions"].map((suffix) => `${prefix}/${suffix}`));
const externalRoutes = config.routes.filter((route) => route.dest?.startsWith("https://"));

test("large uploads retain every API alias while their normal Vercel fallback stays available", () => {
  assert.equal(externalRoutes.length, 2);
  const declaredLength = externalRoutes.find((route) => route.has);
  const unknownLength = externalRoutes.find((route) => route.missing);
  assert.ok(declaredLength);
  assert.ok(unknownLength);
  assert.equal(declaredLength.has[0].value.gt, MAX_WIRE_BYTES,
    "the fast-route threshold must track the function's actual body limit");
  assert.deepEqual(declaredLength.has.map(({ type, key }) => ({ type, key })),
    [{ type: "header", key: "content-length" }]);
  assert.deepEqual(unknownLength.missing, [{ type: "header", key: "content-length" }]);

  for (const route of externalRoutes) {
    assert.deepEqual(route.methods, ["POST"], "GET and preflight requests must keep their Vercel path");
    assert.equal(route.headers?.["X-KlyAPI-Ingress"], "large",
      "live boundary checks must distinguish an external rewrite from the normal function path");
    for (const path of generationPaths) {
      const matcher = new RegExp(route.src);
      assert.ok(matcher.test(path), path);
      assert.equal(path.replace(matcher, route.dest), `https://klyapi-large-requests.onrender.com${path}`);
      const suffix = path.includes("chat/completions") ? "chat/completions" : path.split("/").at(-1);
      assert.equal(config.rewrites.find(({ source }) => source === path)?.destination,
        `/api/proxy?path=v1/${suffix}`, `normal calls to ${path} must retain their fast fallback`);
    }
  }
});

test("external upload routing cannot capture the panel, account endpoints or unlisted paths", () => {
  const localPaths = ["/", "/key", "/login", "/api", "/api/", "/api/account", "/api/login",
    "/api/keys", "/api/users", "/api/proxy", "/healthz", "/server.cjs",
    "/api/models", "/v1/models", "/api/v1/models", "/api/v1/responses/",
    "/API/v1/responses", "/api/v1/responses/anything", "/foo/api/v1/responses",
    "/api/v1/../responses", "/api/v1/%72esponses", "/api/v1/responses%2fanything"];
  for (const route of externalRoutes) {
    const matcher = new RegExp(route.src);
    for (const path of localPaths) assert.equal(matcher.test(path), false, path);
  }
  for (const prefix of ["/api", "/v1", "/api/v1"]) {
    assert.equal(config.rewrites.find(({ source }) => source === `${prefix}/models`)?.destination,
      "/api/proxy?path=v1/models");
  }
  for (const headerRule of config.headers) {
    assert.equal(headerRule.headers.some(({ key }) => key.toLowerCase() === "x-klyapi-ingress"), false,
      "a global header would incorrectly label normal function traffic as a large upload");
  }
});
