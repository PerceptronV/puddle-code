/** Dedicated shell clients keep assistance replies out of nbclient's execution channel. */
export const NOTEBOOK_INTELLIGENCE_BRIDGE = String.raw`
async def query_kernel(message):
    query_client = None
    result = dict(matches=[], start=message['cursor'], end=message['cursor'], documentation='')
    try:
        if manager is not None and await manager.is_alive():
            query_client = manager.client()
            # Manager clients clone the same session id. A distinct routing
            # identity prevents this socket taking over the execution client.
            query_client.session.session = str(uuid.uuid4())
            query_client.start_channels(iopub=False, stdin=False, hb=False, control=False)
            if message['kind'] == 'complete':
                request_id = query_client.complete(message['code'], message['cursor'])
            else:
                request_id = query_client.inspect(message['code'], message['cursor'], detail_level=0)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                reply = await query_client.get_shell_msg(timeout=max(0.01, deadline - time.monotonic()))
                if reply.get('parent_header', {}).get('msg_id') != request_id:
                    continue
                content = reply.get('content', {})
                if content.get('status') == 'ok':
                    if message['kind'] == 'complete':
                        result['matches'] = [str(item)[:512] for item in content.get('matches', [])[:200]]
                        result['start'] = max(0, min(len(message['code']), int(content.get('cursor_start', message['cursor']))))
                        result['end'] = max(result['start'], min(len(message['code']), int(content.get('cursor_end', message['cursor']))))
                    else:
                        result['documentation'] = str(content.get('data', {}).get('text/plain', ''))[:32768]
                break
    except Exception:
        pass
    finally:
        if query_client is not None:
            query_client.stop_channels()
    emit({'id': message['id'], 'result': result})
`;
