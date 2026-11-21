const auth = require("../lib/auth");
const { setHeaders, sendJson, errorResponse, error } = require("../lib/http");

function createHandler(service = auth) {
  return async function handler(req, res) {
    setHeaders(res);
    try {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        throw error(405, "method_not_allowed", "Yöntem desteklenmiyor.");
      }
      sendJson(res, 200, await service.getAccount(req));
    } catch (cause) { errorResponse(res, cause); }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
