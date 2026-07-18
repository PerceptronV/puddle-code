import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import { updateClientSettings, useClientSettings } from '../../../lib/client-settings';
import { SectionTitle, SettingRow } from '../parts';

/**
 * Editor settings (SPEC §11, client scope): the Monaco knobs plus the
 * vscode://`/`cursor:// deep-link host. Terminal and daemon knobs live under
 * Sessions — this section is purely about the centre editor.
 */
export function EditorSection() {
  const settings = useClientSettings();

  return (
    <div>
      <SectionTitle note="This browser only">Editor</SectionTitle>
      <SettingRow label="Tab size" description="Spaces per indent level." htmlFor="tab-size">
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
      <SettingRow label="Word wrap" htmlFor="word-wrap">
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
    </div>
  );
}
