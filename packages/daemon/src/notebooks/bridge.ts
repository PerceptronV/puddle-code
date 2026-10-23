/**
 * Installed Jupyter owns wire messages and language kernels. This small private
 * bridge keeps its KernelManager alive independently of notebook executions.
 * Passed through stdin to Python: no generated module or shell command.
 */
export const NOTEBOOK_BRIDGE = String.raw`
import asyncio, json, os, signal, sys, tempfile
from pathlib import Path
import nbformat
from jupyter_client import AsyncKernelManager
from jupyter_client.kernelspec import KernelSpecManager
from nbconvert.nbconvertapp import NbConvertApp
from nbclient import NotebookClient

LIMIT = 5 * 1024 * 1024
manager = None
client = None
execution = None
interrupted = False
closing = False
kernel_name = None
runtime = tempfile.TemporaryDirectory(prefix='puddle-kernel-')

def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)

def catalogue():
    specs = KernelSpecManager().get_all_specs()
    return [{"name": name, "display_name": data['spec'].get('display_name') or name,
             "language": data['spec'].get('language', '')} for name, data in specs.items()]

class BoundedClient(NotebookClient):
    output_bytes = 0
    def process_message(self, msg, cell, cell_index):
        self.output_bytes += len(json.dumps(msg.get('content', {}), default=str).encode())
        if self.output_bytes > 2 * 1024 * 1024:
            raise RuntimeError('Notebook output exceeded 2 MiB')
        return super().process_message(msg, cell, cell_index)

async def start(name, cwd):
    global manager, client, kernel_name
    if manager is not None:
        if not await manager.is_alive():
            raise RuntimeError('The kernel exited. Restart it before running again.')
        if name != kernel_name:
            raise RuntimeError('Select or restart the kernel to change its language.')
        return
    kernel_name = name
    manager = AsyncKernelManager(kernel_name=name, connection_file=str(Path(runtime.name) / 'kernel.json'))
    await asyncio.wait_for(manager.start_kernel(cwd=cwd, stdout=sys.stderr, stderr=sys.stderr), timeout=30)
    pid = getattr(manager.provisioner, 'pid', None)
    emit({'event': 'spawned', **({'pid': pid} if isinstance(pid, int) else {})})
    client = manager.client()
    client.start_channels()
    await client.wait_for_ready(timeout=30)
    emit({'event': 'ready', 'kernel': name})

async def run(message):
    global interrupted
    interrupted = False
    try:
        source = Path(message['source'])
        with source.open('rb') as handle:
            raw = handle.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise RuntimeError('Notebook exceeds the 5 MiB editor limit')
        nb = nbformat.reads(raw.decode('utf-8'), as_version=4)
        if len(nb.cells) > 2000:
            raise RuntimeError('Notebook exceeds 2,000 cells')
        app = NbConvertApp()
        app.parse_command_line(message['args'])
        if app.extra_args != [str(source)] or app.export_format != 'notebook':
            raise RuntimeError('Notebook commands must use --to notebook and execute {{source}}')
        if app.output_base != 'notebook.ipynb' or str(Path(app.config.FilesWriter.get('build_directory', '')).resolve()) != str(Path(message['output']).parent.resolve()):
            raise RuntimeError('Notebook commands must retain --output notebook.ipynb --output-dir {{output_dir}}')
        config = app.config
        # The existing command fields continue to accept nbconvert execution
        # options. Puddle always owns the notebook output path and kernel lifetime.
        config.NotebookClient.update(dict(config.get('ExecutePreprocessor', {})))
        name = message.get('kernel') or config.NotebookClient.get('kernel_name') or nb.metadata.get('kernelspec', {}).get('name') or 'python3'
        await start(name, message.get('cwd', str(source.parent)))
        config.NotebookClient.shutdown_kernel = 'graceful'
        runner = BoundedClient(nb, km=manager, config=config)
        runner.kc = client
        runner.allow_errors = False
        runner.allow_error_names = []
        runner.kc.allow_stdin = False
        runner.record_timing = False
        if runner.timeout is None or runner.timeout < 0:
            runner.timeout = 120
        # Using the externally owned client avoids nbclient's cleanup context:
        # only explicit lifecycle commands below can stop this kernel.
        for index, cell in enumerate(nb.cells):
            if interrupted:
                raise RuntimeError('Notebook execution interrupted')
            await runner.async_execute_cell(cell, index)
        if interrupted:
            raise RuntimeError('Notebook execution interrupted')
        encoded = nbformat.writes(nb).encode('utf-8')
        if len(encoded) > LIMIT:
            raise RuntimeError('Executed notebook exceeds the 5 MiB editor limit')
        Path(message['output']).write_bytes(encoded)
        emit({'id': message['id'], 'ok': True})
    except BaseException as error:
        if isinstance(error, asyncio.CancelledError):
            raise
        if manager is not None:
            try:
                await manager.interrupt_kernel()
            except Exception:
                pass
        if manager is not None and not await manager.is_alive():
            emit({'event': 'dead', 'error': 'The kernel exited. Restart it before running again.'})
        emit({'id': message['id'], 'error': str(error)[-32768:] or type(error).__name__})

async def shutdown():
    global manager, client, closing, interrupted
    closing = True
    interrupted = True
    if execution is not None and not execution.done():
        execution.cancel()
        await asyncio.gather(execution, return_exceptions=True)
    if manager is not None:
        try:
            await manager.shutdown_kernel(now=True)
        except Exception:
            pass
    if client is not None:
        client.stop_channels()
    manager = None
    emit({'event': 'stopped'})
    runtime.cleanup()

async def monitor():
    while not closing:
        await asyncio.sleep(1)
        if manager is not None and manager.has_kernel and not await manager.is_alive():
            emit({'event': 'dead', 'error': 'The kernel exited. Restart it before running again.'})
            return

async def start_request(message):
    try:
        await start(message['kernel'], message['cwd'])
        emit({'id': message['id'], 'ok': True})
    except Exception as error:
        emit({'id': message['id'], 'error': str(error)})

async def main():
    global execution, interrupted
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.create_task(shutdown()))
        except NotImplementedError:
            pass
    emit({'event': 'catalogue', 'kernels': catalogue()})
    monitor_task = asyncio.create_task(monitor())
    while not closing:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        if len(line) > 262144:
            raise RuntimeError('Kernel request exceeds its size limit')
        message = json.loads(line)
        op = message['op']
        if op == 'shutdown':
            break
        if op == 'interrupt':
            interrupted = True
            try:
                if manager is not None and manager.has_kernel:
                    await manager.interrupt_kernel()
                emit({'id': message['id'], 'ok': True})
            except Exception as error:
                emit({'id': message['id'], 'error': str(error)})
        elif op == 'start':
            execution = asyncio.create_task(start_request(message))
        elif op == 'run':
            if execution is not None and not execution.done():
                emit({'id': message['id'], 'error': 'This notebook is already running'})
            else:
                execution = asyncio.create_task(run(message))
    monitor_task.cancel()
    await shutdown()

try:
    asyncio.run(main())
except BaseException as error:
    print(str(error), file=sys.stderr, flush=True)
    raise
`;
