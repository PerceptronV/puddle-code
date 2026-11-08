import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { agentSignalRequestSchema, type AgentSignalRequest } from '@puddle/shared';
import { isLocalHostHeader } from '../../security/middleware.js';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../resources/budget.js';
import {
  RuntimeSignalBodyTooLarge,
  readSignalBody,
  RUNTIME_SIGNAL_REQUESTS,
  RUNTIME_SIGNAL_WORK_BYTES,
} from './signals/body.js';

/** The existing provider-hook contract, served by its owner rather than puddled. */
export class RuntimeSignals {
  private server: Server | null = null;
  private active = true;
  private readonly requests: RuntimeBufferBudget;

  constructor(
    private readonly nonce: string,
    private readonly receive: (signal: AgentSignalRequest) => boolean | Promise<boolean>,
    allowance?: RuntimeByteAllowance,
  ) {
    this.requests = new RuntimeBufferBudget(
      {
        bytes: RUNTIME_SIGNAL_REQUESTS * RUNTIME_SIGNAL_WORK_BYTES,
        count: RUNTIME_SIGNAL_REQUESTS,
      },
      allowance,
    );
  }

  async listen(): Promise<string> {
    const server = createServer(
      { requestTimeout: 5000, headersTimeout: 5000 },
      async (req, res) => {
        const finish = (status: number) => {
          res.writeHead(status, { connection: 'close' });
          res.end();
        };
        if (!this.active || req.method !== 'POST' || req.url !== '/agent-signal') {
          finish(404);
          return;
        }
        // Provider hooks never send Origin. This dedicated endpoint has no browser
        // callers and cannot inherit frontend or connection-token authority.
        if (!isLocalHostHeader(req.headers.host) || req.headers.origin !== undefined) {
          finish(403);
          return;
        }
        const release = this.requests.reserve(RUNTIME_SIGNAL_WORK_BYTES);
        if (!release) {
          finish(503);
          return;
        }
        try {
          const signal = agentSignalRequestSchema.safeParse(await readSignalBody(req));
          if (!signal.success) {
            finish(400);
            return;
          }
          const supplied = Buffer.from(signal.data.nonce);
          const expected = Buffer.from(this.nonce);
          if (
            !this.active ||
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
          ) {
            finish(404);
            return;
          }
          finish((await this.receive(signal.data)) ? 204 : 404);
        } catch (error) {
          if (!res.headersSent) finish(error instanceof RuntimeSignalBodyTooLarge ? 413 : 400);
        } finally {
          release();
        }
      },
    );
    server.maxConnections = 32;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Runtime signal endpoint did not bind');
    return `http://127.0.0.1:${address.port}/agent-signal`;
  }

  async close(): Promise<void> {
    this.active = false;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
