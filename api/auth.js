const auth = require("../lib/auth");
const { setHeaders, sendJson, errorResponse, error, readJson, assertSameOrigin, assertFields } = require("../lib/http");

function createHandler(service = auth) {
  return async function handler(req, res) {
    setHeaders(res);
    try {
      if (req.method === "GET") {
        sendJson(res, 200, { user: auth.publicUser(await service.requireUser(req)) });
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "GET, POST");
        throw error(405, "method_not_allowed", "Yöntem desteklenmiyor.");
      }
      assertSameOrigin(req);
      const body = await readJson(req);
      if (body.action === "login") sendJson(res, 200, { user: await service.login(req, res, body) });
      else if (body.action === "logout") {
        assertFields(body, ["action"]);
        await service.logout(req, res);
        res.statusCode = 204;
        res.end();
      } else if (body.action === "password") sendJson(res, 200, { user: await service.changePassword(req, res, body) });
      else throw error(400, "invalid_action", "Geçersiz işlem.");
    } catch (cause) { errorResponse(res, cause); }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.config = { api: { bodyParser: false } };
