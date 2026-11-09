import type { Readable, Writable } from 'node:stream';
import {
  puddlangMcpRequestSchema,
  puddlangMcpCallSchema,
  puddlangMcpTools,
  puddlangMcpRunSchema,
  puddlangMcpIdSchema,
  puddlangMcpEventsSchema,
  puddlangMcpEmptySchema,
  puddlangMcpOutcomesSchema,
  puddlangMcpOutcomeSchema,
  huddleMcpTools,
  huddleSourceMcpTools,
  huddleExecutionMcpTools,
  huddlePlacementMcpTools,
  huddleAuthoringMcpTool,
  huddleAuthoringRequestSchema,
  readHuddleAuthoring,
} from '@puddle/shared';
import type { PuddlangClient } from './client.js';
import { callHuddleTool } from '../huddle/mcp.js';
import { callHuddleSourceTool } from '../huddle/source/mcp.js';
import { callHuddleExecutionTool, executionTools } from '../huddle/execution/mcp.js';
import { callHuddlePlacementTool, placementTools } from '../huddle/placement/mcp.js';

/** MCP 2025-06-18 stdio: bounded newline-delimited JSON-RPC, no stdout logging. */
export async function serveMcp(
  client: Pick<
    PuddlangClient,
    'context' | 'start' | 'status' | 'events' | 'cancel' | 'outcomes' | 'disposeOutcome'
  > &
    Partial<Pick<PuddlangClient, 'huddles'>>,
  input: Readable,
  output: Writable,
): Promise<void> {
  let initialised = false;
  let ready = false;
  let buffer = Buffer.alloc(0);
  const pending = new Set<Promise<void>>();
  const write = (message: unknown) => {
    output.write(JSON.stringify(message) + '\n');
  };
  const handle = async (raw: unknown) => {
    const parsed = puddlangMcpRequestSchema.safeParse(raw);
    if (!parsed.success) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    const { id, method, params } = parsed.data;
    if (id === undefined) {
      if (method === 'notifications/initialized' && initialised) ready = true;
      return;
    }
    const reply = (result: unknown) => write({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) =>
      write({ jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') {
      if (initialised) {
        fail(-32600, 'Already initialised');
        return;
      }
      initialised = true;
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'puddlang', version: '0.1.0' },
        instructions:
          'Runs execute on the selected Puddle host/profile with its OS authority. Account labels belong to this profile. Runs survive MCP disconnect; cancellation is explicit. Inspect context for supported agents. Huddle source tools never activate graphs. Runtime tools can execute trusted code: require explicit execution intent and supply reviewed digests/owner targets. Never refresh a target or retry a mutation automatically after a failed reply; inspect runtime/history. Successful source validation is not live execution admission.',
      });
      return;
    }
    if (method === 'ping') {
      reply({});
      return;
    }
    if (!ready) {
      fail(-32000, 'Initialise the connection first');
      return;
    }
    if (method === 'tools/list') {
      reply({
        tools: [
          ...puddlangMcpTools,
          huddleAuthoringMcpTool,
          ...(client.huddles?.supported
            ? huddleMcpTools.filter(
                (tool) => tool.name !== 'huddle_duplicate' || client.huddles?.duplicationSupported,
              )
            : []),
          ...(client.huddles?.source.supported ? huddleSourceMcpTools : []),
          ...executionTools(client.huddles?.execution),
          ...placementTools(client.huddles?.placement),
        ],
      });
      return;
    }
    if (method !== 'tools/call') {
      fail(-32601, 'Method not found');
      return;
    }
    const call = puddlangMcpCallSchema.safeParse(params);
    if (!call.success) {
      fail(-32602, 'Invalid tool call');
      return;
    }
    try {
      const args = call.data.arguments ?? {};
      let result: unknown;
      if (call.data.name === huddleAuthoringMcpTool.name) {
        result = readHuddleAuthoring(huddleAuthoringRequestSchema.parse(args).path);
      } else if (huddleMcpTools.some((tool) => tool.name === call.data.name)) {
        result = await callHuddleTool(client.huddles, call.data.name, args);
      } else if (huddleSourceMcpTools.some((tool) => tool.name === call.data.name)) {
        result = await callHuddleSourceTool(client.huddles?.source, call.data.name, args);
      } else if (huddleExecutionMcpTools.some((tool) => tool.name === call.data.name)) {
        result = await callHuddleExecutionTool(client.huddles?.execution, call.data.name, args);
      } else if (huddlePlacementMcpTools.some((tool) => tool.name === call.data.name)) {
        result = await callHuddlePlacementTool(client.huddles?.placement, call.data.name, args);
      } else
        switch (call.data.name) {
          case 'puddlang_context':
            puddlangMcpEmptySchema.parse(args);
            result = await client.context();
            break;
          case 'puddlang_run':
            result = await client.start(puddlangMcpRunSchema.parse(args));
            break;
          case 'puddlang_status':
            result = await client.status(puddlangMcpIdSchema.parse(args).id);
            break;
          case 'puddlang_events': {
            const a = puddlangMcpEventsSchema.parse(args);
            result = await client.events(a.id, a.after);
            break;
          }
          case 'puddlang_cancel':
            result = await client.cancel(puddlangMcpIdSchema.parse(args).id);
            break;
          case 'puddlang_outcomes': {
            const a = puddlangMcpOutcomesSchema.parse(args);
            result = await client.outcomes(a.id, a.after);
            break;
          }
          case 'puddlang_outcome': {
            const { id, operation, ...request } = puddlangMcpOutcomeSchema.parse(args);
            result = await client.disposeOutcome(id, operation, request);
            break;
          }
          default:
            fail(-32602, 'Unknown tool');
            return;
        }
      reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) {
      reply({
        isError: true,
        content: [
          {
            type: 'text',
            text: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
          },
        ],
      });
    }
  };
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      buffer = Buffer.concat([buffer, bytes]);
      let newline: number;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline > 1024 * 1024) throw new Error('MCP message exceeds 1 MiB');
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        if (pending.size >= 32) await Promise.race(pending);
        const task = handle(value).finally(() => pending.delete(task));
        pending.add(task);
      }
      if (buffer.length > 1024 * 1024) throw new Error('MCP message exceeds 1 MiB');
    }
  } finally {
    await Promise.allSettled(pending);
  }
}
