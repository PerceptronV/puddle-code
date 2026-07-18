import { useEffect, useState } from 'react';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/client-settings';
import { useConfig, usePatchConfig } from '../../../lib/queries';
import { SectionTitle, SettingRow } from '../parts';

/**
 * The daemon's agent-search PATH (host-wide, config.json): colon-separated dirs
 * prepended to PATH so the daemon can find agent CLIs like `claude`. Saved on
 * blur; a daemon restart applies it. Distinct from the browser-scoped rows here.
 */
function AgentPathRow() {
  const config = useConfig();
  const patch = usePatchConfig();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (config.data) setValue(config.data.agentPath);
  }, [config.data]);
  return (
    <SettingRow
      label="Agent search path (host-wide)"
      description="Colon-separated dirs the daemon prepends to PATH to find agent CLIs like claude (e.g. ~/.local/bin). Applies after the daemon restarts."
      htmlFor="agent-path"
    >
      <Input
        id="agent-path"
        type="text"
        className="w-64 font-mono text-2xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (config.data && value !== config.data.agentPath) patch.mutate({ agentPath: value });
        }}
      />
    </SettingRow>
  );
}

export function TerminalSection() {
  const settings = useClientSettings();

  return (
    <div>
      <SectionTitle note="This browser only">Terminal &amp; editor</SectionTitle>
      <SettingRow
        label="Terminal scrollback"
        description="Lines kept per terminal."
        htmlFor="scrollback"
      >
        <Input
          id="scrollback"
          type="number"
          min={500}
          max={100000}
          step={500}
          className="w-28 tabular-nums"
          value={settings.terminalScrollback}
          onChange={(e) =>
            updateClientSettings({ terminalScrollback: Number(e.target.value) || 5000 })
          }
        />
      </SettingRow>
      <SettingRow
        label="Editor tab size"
        description="Consumed when the editor lands in Phase 3."
        htmlFor="tab-size"
      >
        <Input
          id="tab-size"
          type="number"
          min={1}
          max={8}
          className="w-20 tabular-nums"
          value={settings.editorTabSize}
          onChange={(e) => updateClientSettings({ editorTabSize: Number(e.target.value) || 2 })}
        />
      </SettingRow>
      <SettingRow label="Editor word wrap" htmlFor="word-wrap">
        <Switch
          id="word-wrap"
          checked={settings.editorWordWrap}
          onCheckedChange={(checked) => updateClientSettings({ editorWordWrap: checked })}
        />
      </SettingRow>
      <SettingRow
        label="SSH host for editor links"
        description="Used for vscode:// and cursor:// remote links until the CLI supplies it automatically."
        htmlFor="editor-link-host"
      >
        <Input
          id="editor-link-host"
          type="text"
          placeholder="user@host"
          className="w-48"
          value={settings.editorLinkSshHost}
          onChange={(e) => updateClientSettings({ editorLinkSshHost: e.target.value })}
        />
      </SettingRow>
      <AgentPathRow />
    </div>
  );
}
