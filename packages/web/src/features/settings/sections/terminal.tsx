import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/client-settings';
import { SectionTitle, SettingRow } from '../parts';

export function TerminalSection() {
  const settings = useClientSettings();

  return (
    <div>
      <SectionTitle note="this browser only">Terminal &amp; editor</SectionTitle>
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
    </div>
  );
}
