"""Exercise the production execution loop with a synthetic, kernel-free client."""
import asyncio
import json as standard_json
import sys
from types import SimpleNamespace

events = []
serialisations = 0
fail_at = None
manager = None
client = SimpleNamespace(allow_stdin=False)


class Cell(dict):
    def __getattr__(self, name):
        return self[name]


class BoundedClient:
    def __init__(self, nb, **kwargs):
        self.nb = nb

    async def async_execute_cell(self, cell, index):
        if index == fail_at:
            raise RuntimeError('synthetic failure')


def dumps(value, **kwargs):
    global serialisations
    serialisations += 1
    return standard_json.dumps(value, **kwargs)


def emit(value):
    events.append(value)


async def start(*args):
    pass


json = SimpleNamespace(dumps=dumps)
nbformat = SimpleNamespace(v4=SimpleNamespace(
    new_code_cell=lambda **kwargs: Cell(**kwargs),
    new_notebook=lambda cells: SimpleNamespace(cells=cells),
))
exec(sys.stdin.read())


async def poll_input(runner):
    await asyncio.sleep(60)


async def check():
    global serialisations, fail_at
    for size in (100, 200):
        serialisations = 0
        events.clear()
        await run_cells(dict(id='request', kernel='synthetic', cwd='.', run_id='run',
                             cells=[dict(id=str(i), source='pass') for i in range(size)]))
        assert serialisations == 3 * size - 1, serialisations
        cells = [e['cell'] for e in events if e.get('event') == 'cell']
        assert len(cells) == 3 * size - 1
        assert sum(c['state'] == 'succeeded' for c in cells) == size
        assert sum(c['state'] == 'queued' for c in cells) == size - 1
        assert all('elapsed_ms' in c for c in cells if c['state'] == 'succeeded')
    events.clear()
    fail_at = 1
    await run_cells(dict(id='request', kernel='synthetic', cwd='.', run_id='run',
                         cells=[dict(id=str(i), source='pass') for i in range(4)]))
    latest = {e['cell']['id']: e['cell']['state'] for e in events if e.get('event') == 'cell'}
    assert list(latest.values()) == ['succeeded', 'failed', 'cancelled', 'cancelled'], latest


asyncio.run(check())
print('Linear cell publication and cancellation pass')
