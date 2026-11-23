import { Agent } from 'node:http';
import type { Express } from 'express';
import request from 'supertest';

const keepAlive = new Agent({ keepAlive: true });

/**
 * Supertest with a keep-alive agent. Supertest's default sends `Connection: close`, and Node 26 on
 * Windows intermittently answers those with ECONNRESET (reproducible with bare node:http).
 */
export function client(app: Express) {
  const http = request(app);
  return {
    get: (path: string) => http.get(path).agent(keepAlive),
    post: (path: string) => http.post(path).agent(keepAlive),
    patch: (path: string) => http.patch(path).agent(keepAlive),
    put: (path: string) => http.put(path).agent(keepAlive),
    delete: (path: string) => http.delete(path).agent(keepAlive),
  };
}
