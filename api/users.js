const auth = require("../lib/auth");
const { setHeaders, sendJson, errorResponse, error, readJson, assertSameOrigin } = require("../lib/http");

function createHandler(service = auth) {
  return async function handler(req, res) {
    setHeaders(res);
    try {
      if (req.method === "GET") sendJson(res, 200, { users: await service.listUsers(req) });
      else if (["POST", "PATCH"].includes(req.method)) {
        assertSameOrigin(req);
        const body = await readJson(req);
        const user = req.method === "POST" ? await service.createUser(req, body) : await service.updateUser(req, body);
        sendJson(res, req.method === "POST" ? 201 : 200, { user });
      } else {
        res.setHeader("allow", "GET, POST, PATCH");
        throw error(405, "method_not_allowed", "Yöntem desteklenmiyor.");
      }
    } catch (cause) { errorResponse(res, cause); }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.config = { api: { bodyParser: false } };
