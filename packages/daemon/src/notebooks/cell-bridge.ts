/** Interactive execution extends the same installed nbclient and KernelManager. */
export const NOTEBOOK_CELL_BRIDGE = String.raw`
import time, uuid
input_pending = None

class LiveClient(BoundedClient):
    def __init__(self, nb, run_id):
        super().__init__(nb, km=manager, allow_errors=False, record_timing=False, timeout=None)
        self.kc = client
        self.kc.allow_stdin = True
        self.widget_registry = {'@jupyter-widgets/output': {'OutputModel': PassiveOutput}}
        if widget_collector is not None:
            for comm_id, state in widget_collector.widget_state.items():
                if state.get('_model_module') == '@jupyter-widgets/output' and state.get('_model_name') == 'OutputModel':
                    self.widget_state[comm_id] = dict(state)
                    self.comm_objects[comm_id] = PassiveOutput(comm_id, dict(state), self.kc, self)
        self.run_id = run_id
        self.states = ['queued'] * len(nb.cells)
        self.started = {}
        self.elapsed = {}
        self.published = {}
        self.flush_handle = None

    def publish(self):
        self.flush_handle = None
        for index, cell in enumerate(self.nb.cells):
            value = dict(id=cell.id, source=cell.source, state=self.states[index],
                         execution_count=cell.get('execution_count'), outputs=cell.get('outputs', []))
            if index in self.elapsed:
                value['elapsed_ms'] = self.elapsed[index]
            encoded = json.dumps(value, ensure_ascii=False)
            if self.published.get(index) != encoded:
                self.published[index] = encoded
                emit({'event': 'cell', 'run_id': self.run_id, 'cell': value})

    def process_message(self, msg, cell, cell_index):
        try:
            return super().process_message(msg, cell, cell_index)
        finally:
            if self.flush_handle is None:
                self.flush_handle = asyncio.get_running_loop().call_later(0.1, self.publish)

async def poll_input(run_id):
    global input_pending
    while True:
        try:
            message = await client.get_stdin_msg(timeout=1)
        except asyncio.CancelledError:
            raise
        except Exception:
            continue
        if message.get('header', {}).get('msg_type') != 'input_request':
            continue
        content = message.get('content', {})
        prompt = dict(id=str(uuid.uuid4()), prompt=str(content.get('prompt', ''))[:4096], password=bool(content.get('password', False)))
        input_pending = (run_id, prompt['id'])
        emit({'event': 'input', 'run_id': run_id, 'input': prompt})

async def run_cells(message):
    global interrupted, input_pending
    interrupted = False
    runner = None
    input_task = None
    index = None
    try:
        await start(message['kernel'], message['cwd'])
        nb = nbformat.v4.new_notebook(cells=[nbformat.v4.new_code_cell(source=cell['source'], id=cell['id']) for cell in message['cells']])
        runner = LiveClient(nb, message['run_id'])
        input_task = asyncio.create_task(poll_input(message['run_id']))
        for index, cell in enumerate(nb.cells):
            if interrupted:
                raise RuntimeError('Notebook execution interrupted')
            runner.states[index] = 'running'
            runner.started[index] = time.monotonic()
            runner.publish()
            await runner.async_execute_cell(cell, index)
            if interrupted:
                raise RuntimeError('Notebook execution interrupted')
            runner.states[index] = 'succeeded'
            runner.elapsed[index] = max(0, (time.monotonic() - runner.started[index]) * 1000)
            runner.publish()
        emit({'id': message['id'], 'ok': True})
    except BaseException as error:
        if runner is not None and index is not None:
            runner.states[index] = 'cancelled' if interrupted or isinstance(error, asyncio.CancelledError) else 'failed'
            runner.elapsed[index] = max(0, (time.monotonic() - runner.started[index]) * 1000)
            for at in range(index + 1, len(runner.states)):
                runner.states[at] = 'cancelled'
            runner.publish()
        if manager is not None:
            try:
                await manager.interrupt_kernel()
            except Exception:
                pass
        emit({'id': message['id'], 'error': str(error)[-32768:] or type(error).__name__})
    finally:
        if runner is not None and runner.flush_handle is not None:
            runner.flush_handle.cancel()
        if input_task is not None:
            input_task.cancel()
            await asyncio.gather(input_task, return_exceptions=True)
        input_pending = None
        emit({'event': 'input-cleared', 'run_id': message['run_id']})
`;
