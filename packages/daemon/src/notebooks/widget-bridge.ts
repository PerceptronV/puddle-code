/** A separate IOPub subscriber keeps widgets alive between cell executions. */
export const NOTEBOOK_WIDGET_BRIDGE = String.raw`
import base64
from nbclient.output_widget import OutputWidget
widget_client = None
widget_task = None
widget_collector = None

def widget_message(msg):
    value = dict(msg_id=msg['header']['msg_id'], parent_id=msg.get('parent_header', {}).get('msg_id', ''),
                 msg_type=msg['header']['msg_type'], content=msg.get('content', {}),
                 metadata=msg.get('metadata', {}),
                 buffers=[base64.b64encode(bytes(buffer)).decode('ascii') for buffer in msg.get('buffers', [])])
    if len(json.dumps(value).encode()) > 2 * 1024 * 1024:
        raise RuntimeError('Widget message exceeds 2 MiB')
    emit({'event': 'widget', 'widget': value})

class CapturedOutput(OutputWidget):
    def __init__(self, *args):
        super().__init__(*args)
        self.display_ids = {}

    def output(self, outs, msg, display_id, cell_index):
        if self.clear_before_next_output:
            self.display_ids.clear()
        super().output(outs, msg, display_id, cell_index)
        identifier = (msg['content'].get('transient') or {}).get('display_id')
        if identifier:
            self.display_ids.setdefault(identifier, []).append(self.outputs[-1])

    def clear_output(self, outs, msg, cell_index):
        if not msg['content'].get('wait'):
            self.display_ids.clear()
        super().clear_output(outs, msg, cell_index)

    def handle_msg(self, msg):
        data = msg['content']['data']
        if data.get('method') != 'echo_update' and 'outputs' in data.get('state', {}):
            self.outputs = data['state']['outputs']
            self.display_ids.clear()
        super().handle_msg(msg)

    def update_display(self, msg):
        identifier = (msg['content'].get('transient') or {}).get('display_id')
        outputs = self.display_ids.get(identifier, [])
        for output in outputs:
            output['data'] = msg['content']['data']
            output['metadata'] = msg['content'].get('metadata', {})
        if outputs:
            self.sync_state()

    def sync_state(self):
        # Publish the same trait change locally even when kernel echo is disabled.
        msg = self.kernel_client.session.msg('comm_msg', content=dict(
            comm_id=self.comm_id, data=dict(method='update', state=dict(outputs=self.outputs), buffer_paths=[])))
        widget_message(msg)
        super().sync_state()

class PassiveOutput(OutputWidget):
    # Execution clients suppress captured output in cells. The persistent
    # collector alone owns its state and sends it back to the kernel.
    def output(self, *args):
        pass
    def clear_output(self, *args):
        pass

async def start_widgets():
    global widget_client, widget_task, widget_collector
    widget_client = manager.client()
    widget_client.session.session = str(uuid.uuid4())
    widget_client.start_channels(stdin=False, hb=False, control=False)
    widget_collector = NotebookClient(nbformat.v4.new_notebook(), km=manager)
    widget_collector.kc = widget_client
    widget_collector.widget_registry = {'@jupyter-widgets/output': {'OutputModel': CapturedOutput}}
    # wait_for_ready establishes the subscriber before any user cell can run.
    await widget_client.wait_for_ready(timeout=30)
    widget_task = asyncio.create_task(poll_widgets())

def forget_widget(comm_id):
    widget_collector.widget_state.pop(comm_id, None)
    widget_collector.widget_buffers.pop(comm_id, None)
    closed_widget = widget_collector.comm_objects.pop(comm_id, None)
    for parent, hooks in list(widget_collector.output_hook_stack.items()):
        if closed_widget in hooks:
            hooks.remove(closed_widget)
        if not hooks:
            widget_collector.output_hook_stack.pop(parent, None)

async def poll_widgets():
    try:
        while not closing:
            try:
                msg = await widget_client.get_iopub_msg(timeout=1)
            except asyncio.CancelledError:
                raise
            except Exception:
                continue
            kind = msg['header']['msg_type']
            if kind in ('comm_open', 'comm_msg', 'comm_close'):
                content = msg['content']
                comm_id = content.get('comm_id')
                if kind == 'comm_open' and content.get('target_name') != 'jupyter.widget':
                    continue
                if kind != 'comm_open' and comm_id not in widget_collector.widget_state:
                    continue
                widget_message(msg)
                if kind == 'comm_close':
                    forget_widget(comm_id)
                else:
                    widget_collector.handle_comm_msg([], msg, 0)
                buffer_state = {key: list(value.values()) for key, value in widget_collector.widget_buffers.items()}
                if len(widget_collector.widget_state) > 1024 or len(json.dumps(dict(state=widget_collector.widget_state, buffers=buffer_state), default=str).encode()) > 4 * 1024 * 1024:
                    raise RuntimeError('Widget state exceeded 1,024 models / 4 MiB')
            elif kind == 'status':
                widget_message(msg)
            elif kind == 'update_display_data':
                for output in list(widget_collector.comm_objects.values()):
                    if isinstance(output, CapturedOutput):
                        output.update_display(msg)
            else:
                hooks = widget_collector.output_hook_stack.get(msg.get('parent_header', {}).get('msg_id', ''), [])
                if hooks:
                    if kind == 'clear_output':
                        hooks[-1].clear_output([], msg, 0)
                    elif kind in ('stream', 'display_data', 'execute_result', 'error'):
                        hooks[-1].output([], msg, None, 0)
    except asyncio.CancelledError:
        pass
    except Exception as error:
        emit({'event': 'widget-error', 'error': str(error)[:1024]})
        widget_collector.widget_state.clear()
        widget_collector.widget_buffers.clear()
        widget_collector.comm_objects.clear()
        widget_collector.output_hook_stack.clear()

def send_widget(message):
    if widget_client is None or widget_task is None or widget_task.done():
        raise RuntimeError('The widget channel is not active')
    value = message['message']
    msg = widget_client.session.msg(value['msg_type'], content=value['content'], metadata=value.get('metadata', {}))
    msg['header']['msg_id'] = value['msg_id']
    msg['buffers'] = [base64.b64decode(buffer, validate=True) for buffer in value.get('buffers', [])]
    widget_client.session.send(widget_client.shell_channel.socket, msg, buffers=msg['buffers'])
    # Reflect outgoing state before processing the kernel's response, even when
    # its echo updates are disabled. Later kernel corrections remain authoritative.
    widget_message(msg)
    if value['msg_type'] in ('comm_open', 'comm_msg'):
        # Keep executed-copy metadata current even when ipywidgets disables echo.
        widget_collector.handle_comm_msg([], msg, 0)
    elif value['msg_type'] == 'comm_close':
        forget_widget(value['content']['comm_id'])
`;
