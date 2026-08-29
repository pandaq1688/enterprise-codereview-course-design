import http from 'node:http';

/**
 * Local Mock HTTP server for RemoteLlmReviewProvider tests.
 * Records method, url, and whether Authorization starts with "Bearer ".
 *
 * @param {object | ((req: http.IncomingMessage, recorded: object) => object)} [options]
 *   statusCode, body (string|object), delayMs, hang
 */
export function createFakeHttpServer(options = {}) {
  /** @type {Array<{
   *   method: string,
   *   url: string,
   *   authorization: string,
   *   authorizationStartsWithBearer: boolean,
   *   body: string
   * }>} */
  const requests = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const auth = req.headers.authorization ?? '';
        const recorded = {
          method: req.method ?? 'GET',
          url: req.url ?? '',
          authorization: auth,
          authorizationStartsWithBearer: auth.startsWith('Bearer '),
          body: rawBody
        };
        requests.push(recorded);

        const resolved =
          typeof options === 'function' ? options(req, recorded) : options;

        if (resolved?.hang) {
          return;
        }

        if (resolved?.delayMs) {
          await new Promise((r) => setTimeout(r, resolved.delayMs));
        }

        const statusCode = resolved?.statusCode ?? 200;
        let body = resolved?.body;
        if (body !== undefined && typeof body !== 'string') {
          body = JSON.stringify(body);
        }
        if (body === undefined || body === null) {
          body = '';
        }

        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
      })();
    });
  });

  /**
   * @returns {Promise<{ baseUrl: string, port: number }>}
   */
  function listen() {
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', (err) => {
        if (err) {
          reject(err);
          return;
        }
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('fake-http-server: failed to bind'));
          return;
        }
        resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, port: addr.port });
      });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  function close() {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { server, requests, listen, close };
}

/**
 * OpenAI-compatible chat completions success body.
 * @param {string} content
 */
export function chatCompletionsBody(content) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  };
}
