const auth = require('../lib/auth');
const { setHeaders, sendJson, errorResponse, error } = require('../lib/http');
const { createHistoryStore, csvExport } = require('../lib/request-history');

function createHandler(service = createHistoryStore(), authProvider = auth) {
  return async function handler(req, res) {
    setHeaders(res);
    try {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET'); throw error(405, 'method_not_allowed', 'Yöntem desteklenmiyor.');
      }
      const user = await authProvider.requireUser(req);
      const query = req.query || Object.fromEntries(new URL(req.url, 'https://localhost').searchParams);
      const result = await service.getActivity(user.id, query);
      if (query.format === 'csv') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', 'attachment; filename="klyapi-istek-gecmisi.csv"');
        res.end(csvExport(result.items));
      } else sendJson(res, 200, result);
    } catch (cause) { errorResponse(res, cause); }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
